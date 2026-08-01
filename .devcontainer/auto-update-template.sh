#!/usr/bin/env bash
# Auto-check and apply template updates on Codespace start.
# Also activates Claude Code (see the migration bridge below).

# Fail fast. This is the Codespace boot path, so every step whose failure is
# EXPECTED (optional scripts, a git repo with no upstream, a diverged branch)
# is explicitly tolerated with `|| true` or an `if` below — an unexpected
# failure should stop here rather than half-update the repo.
set -euo pipefail

# ─── Claude Code activation (migration bridge) ──────────────────────
# On existing (Cline-era) repos the new devcontainer.json postStartCommand only
# takes effect after a container rebuild — but THIS script is invoked by path,
# so its updated content runs on the next start. Running the setup here brings
# Claude Code + claude-code-router up without waiting for a rebuild. Kept ABOVE
# the auto-update-disabled check so disabling updates doesn't disable Claude
# Code. Idempotent — safe on every start. (A rebuild is still recommended so the
# devcontainer remoteEnv applies cleanly.)
if [ -f .devcontainer/setup-claude-router.sh ]; then
  bash .devcontainer/setup-claude-router.sh || true
fi

# Allow users to disable auto-updates by creating this file:
#   touch .template-auto-update-disabled
if [ -f ".template-auto-update-disabled" ]; then
  echo "⏸️  Template auto-update is disabled (.template-auto-update-disabled exists)."
  echo "   To re-enable: rm .template-auto-update-disabled"
  exit 0
fi

echo "🔄 Checking for template updates..."

# A repo that has quietly stopped receiving template updates also stops
# receiving SECURITY fixes, and the old catch-all "could not check" line made
# that indistinguishable from a flaky network. check-updates.sh reports the
# cause on stderr as reason=<token>; keep the two streams apart so the reason
# can be turned into a specific fix.
CHECK_ERR_FILE=$(mktemp)
RESULT=""
REASON=""
if [ ! -f scripts/check-updates.sh ]; then
  REASON="reason=script_missing"
else
  RESULT=$(bash scripts/check-updates.sh 2>"$CHECK_ERR_FILE") || REASON="reason=check_crashed"
  [ -n "$REASON" ] || REASON=$(grep -o 'reason=[a-z_]*' "$CHECK_ERR_FILE" 2>/dev/null | head -1 || true)
fi
rm -f "$CHECK_ERR_FILE"

case "$RESULT" in
  UP_TO_DATE)
    echo "✅ Template is up to date."
    ;;
  UPDATE_AVAILABLE*)
    LOCAL=$(echo "$RESULT" | cut -d'|' -f2)
    LATEST=$(echo "$RESULT" | cut -d'|' -f3)
    echo "📦 Update available: $LOCAL → $LATEST"
    echo "   Applying updates..."
    if ! bash scripts/apply-updates.sh; then
      echo "❌ The update engine failed — see the output above."
      echo "   This repo is still on $LOCAL and is NOT receiving platform security fixes."
      echo "   Ask your AI assistant: 'the template update failed, can you fix it?'"
    fi
    ;;
  *)
    case "$REASON" in
      reason=script_missing)
        echo "❌ scripts/check-updates.sh is missing — this repo can no longer see template updates."
        echo "   Fix: restore it from the template, or ask your AI assistant to re-sync the platform files."
        ;;
      reason=no_git)
        echo "❌ Not a git repository — template updates need git history."
        echo "   Fix: open the project from its GitHub repo (a downloaded ZIP has no git data)."
        ;;
      reason=fetch_auth)
        echo "❌ Not allowed to read the template repo — updates and security fixes are blocked."
        echo "   In Codespaces the built-in token only sees THIS repo, and it overrides gh logins."
        echo "   Fix (one-time, use your BAYER GitHub account):"
        echo "       unset GITHUB_TOKEN GH_TOKEN"
        echo "       gh auth login --web --hostname github.com"
        ;;
      reason=fetch_network)
        echo "⚠️  Could not reach GitHub — skipping the update check this time."
        echo "   Fix: check your connection/VPN; it will retry on the next start."
        ;;
      reason=no_manifest)
        echo "❌ The template repo has no .template-manifest.yml on its default branch."
        echo "   Fix: this is a platform-side problem — report it to the Vibe platform team."
        ;;
      reason=bad_version)
        echo "❌ The template manifest has no readable version — cannot tell if you are current."
        echo "   Fix: this is a platform-side problem — report it to the Vibe platform team."
        ;;
      reason=check_crashed)
        echo "❌ scripts/check-updates.sh exited unexpectedly."
        echo "   Fix: run it by hand to see the error: bash scripts/check-updates.sh"
        ;;
      *)
        echo "⚠️  Could not check for updates (unrecognized failure)."
        echo "   Fix: run it by hand to see the error: bash scripts/check-updates.sh"
        ;;
    esac
    ;;
esac

# Handle open Dependabot PRs: auto-merge green patch/minor, surface the rest
if [ -f scripts/check-dependabot-prs.sh ]; then
  bash scripts/check-dependabot-prs.sh || true
fi

# Bring the working tree up to date with merged updates (security fixes etc.).
# Fast-forward only, and only on the default branch — local work is never
# overwritten; if the pull can't apply cleanly it just reports and moves on.
# `|| true` on each of these: no remote, no network (git remote show does a
# network round trip), a detached HEAD or a repo with no commits are all normal
# situations here and must not abort the boot script under set -e / pipefail.
DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' || true)
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
if [ -n "$DEFAULT_BRANCH" ] && [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
  BEFORE=$(git rev-parse HEAD 2>/dev/null || true)
  if git pull --ff-only origin "$DEFAULT_BRANCH" >/dev/null 2>&1; then
    AFTER=$(git rev-parse HEAD 2>/dev/null || true)
    if [ "$BEFORE" != "$AFTER" ]; then
      echo "⬇️  Pulled latest $DEFAULT_BRANCH (includes any merged dependency updates)."
      if git diff --name-only "$BEFORE" "$AFTER" | grep -qE "package(-lock)?\.json|requirements\.txt"; then
        echo "   Dependencies changed — rebuild before testing: docker compose build --no-cache"
      fi
    fi
  else
    echo "⚠️  Could not fast-forward $DEFAULT_BRANCH (local changes or diverged history) — ask your AI assistant to help sync."
  fi
fi
