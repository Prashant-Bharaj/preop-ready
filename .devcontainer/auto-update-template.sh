#!/usr/bin/env bash
# Auto-check and apply template updates on Codespace start.
# Also activates Claude Code (see the migration bridge below).

# bash reads a script lazily, and the update applied below replaces THIS
# file: the running shell would continue parsing the new content at the old
# offset and die with a syntax error after the sync. Run from a private copy.
if [ -z "${TEMPLATE_HOOK_FROM_COPY:-}" ]; then
  _hook_copy=$(mktemp) && cp "${BASH_SOURCE[0]}" "$_hook_copy" \
    && TEMPLATE_HOOK_FROM_COPY=1 exec bash "$_hook_copy" "$@"
fi

# Fail fast. This is the Codespace boot path, so every step whose failure is
# EXPECTED (optional scripts, a git repo with no upstream, a diverged branch)
# is explicitly tolerated with `|| true` or an `if` below — an unexpected
# failure should stop here rather than half-update the repo.
set -euo pipefail

# ─── Container networking in Codespaces ─────────────────────────────
# The Codespaces image runs Docker 29, which keeps its firewall rules in the
# nftables backend. The codespace also carries a stale iptables-LEGACY rule set
# (older Docker layout) whose FORWARD policy is DROP, with accepts for docker0
# only. The kernel applies both, so every user-defined bridge (br-*, i.e. every
# docker compose network) is dropped there: containers reach neither each other
# nor the internet, and a backend calling myGenAssist fails with
# `getaddrinfo EAI_AGAIN`. Accepting the compose bridges in the legacy chain
# fixes both; Docker's own nftables rules keep enforcing isolation.
# Verified 2026-10-01. The rules are lost when the codespace stops, so this
# runs on every start (idempotent), and it lives HERE for the same reason as
# the bridge below: existing codespaces pick it up without a rebuild.
# /proc/net/ip_tables_names is read first because calling iptables-legacy
# where the legacy module is absent would load it.
if [ -d /.codespaces ] \
   && sudo -n grep -qsx filter /proc/net/ip_tables_names 2>/dev/null; then
  _legacy_forward=$(sudo -n iptables-legacy -S FORWARD 2>/dev/null || true)
  case "$_legacy_forward" in
    "-P FORWARD DROP"*)
      for _dir in -i -o; do
        sudo -n iptables-legacy -C FORWARD "$_dir" br-+ -j ACCEPT 2>/dev/null \
          || sudo -n iptables-legacy -I FORWARD "$_dir" br-+ -j ACCEPT 2>/dev/null \
          || true
      done
      ;;
  esac
fi

# ─── Claude Code activation (migration bridge) ──────────────────────
# On existing (Cline-era) repos the new devcontainer.json postStartCommand only
# takes effect after a container rebuild — but THIS script is invoked by path,
# so its updated content runs on the next start. Running the setup here brings
# Claude Code (myGenAssist gateway) up without waiting for a rebuild. Kept ABOVE
# the auto-update-disabled check so disabling updates doesn't disable Claude
# Code. Idempotent — safe on every start.
if [ -f .devcontainer/setup-claude-code.sh ]; then
  bash .devcontainer/setup-claude-code.sh || true
fi

# Allow users to disable auto-updates by creating this file:
#   touch .template-auto-update-disabled
if [ -f ".template-auto-update-disabled" ]; then
  echo "⏸️  Template auto-update is disabled (.template-auto-update-disabled exists)."
  echo "   To re-enable: rm .template-auto-update-disabled"
  exit 0
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

# After the engine has synced platform files, commit and push them so the
# project is current on its default branch without anyone typing git
# commands. Only the files the engine changed are staged (a diff of `git
# status` before/after the run), so work in flight stays untouched. Workflow
# files are left out: Codespaces tokens may not push them (the engine tracks
# those as pending_workflows). Opt out with:  touch .template-auto-commit-disabled
# Filter stdin paths to the ones the template manifest owns (auto_update,
# auto_update_major, merge_update entries) plus the version tracker.
platform_owned_paths() {
  local patterns
  patterns=$(awk '
    /^auto_update:|^auto_update_major:|^merge_update:/ { in_section=1; next }
    /^[a-zA-Z_]+:/ && !/^auto_update:|^auto_update_major:|^merge_update:/ { in_section=0 }
    in_section && /^  - path:/ {
      line=$0
      sub(/^  - path:[[:space:]]*/, "", line); gsub(/"/, "", line); sub(/[[:space:]]*#.*$/, "", line)
      print line
    }' .template-manifest.yml 2>/dev/null || true)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = ".template-version" ] || [ "$f" = ".template-manifest.yml" ]; then echo "$f"; continue; fi
    while IFS= read -r pat; do
      [ -n "$pat" ] || continue
      case "$pat" in
        */) [ "${f#$pat}" != "$f" ] && { echo "$f"; break; } ;;
        *)  [ "$f" = "$pat" ] && { echo "$f"; break; } ;;
      esac
    done <<< "$patterns"
  done
}

auto_commit_platform_update() {
  local from="$1" to="$2"
  if [ -f ".template-auto-commit-disabled" ]; then
    echo "   ⏸️  Auto-commit is disabled (.template-auto-commit-disabled exists) — synced files left for you to commit."
    return 0
  fi
  if [ -z "$DEFAULT_BRANCH" ] || [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]; then
    echo "   ℹ️  Not on $DEFAULT_BRANCH — synced files left for you to commit."
    return 0
  fi
  local post changed platform files wf
  post=$(git status --porcelain --untracked-files=all 2>/dev/null || true)
  # Files this run changed (status diff before/after) ...
  changed=$(comm -13 <(printf '%s\n' "$PRE_STATUS" | sort) <(printf '%s\n' "$post" | sort) | cut -c4- || true)
  # ... plus platform-owned files that were already dirty, e.g. left by an
  # earlier update that ran before auto-commit existed. The manifest's synced
  # paths are the platform's: users do not edit them, so staging them never
  # sweeps up project work.
  platform=$(printf '%s\n' "$post" | cut -c4- | platform_owned_paths || true)
  changed=$(printf '%s\n%s\n' "$changed" "$platform" | sed '/^$/d' | sort -u)
  [ -n "$changed" ] || return 0
  wf=$(printf '%s\n' "$changed" | grep '^\.github/workflows/' || true)
  files=$(printf '%s\n' "$changed" | grep -v '^\.github/workflows/' || true)
  if [ -n "$files" ]; then
    printf '%s\n' "$files" | while IFS= read -r f; do [ -n "$f" ] && git add -- "$f" || true; done
    if git commit -q -m "chore(template): apply platform update v$from → v$to [skip ci]" 2>/dev/null; then
      if git push -q origin "$DEFAULT_BRANCH" >/dev/null 2>&1; then
        echo "   ⬆️  Committed and pushed the platform update (v$from → v$to)."
      else
        echo "   ⚠️  Committed the platform update but could not push — run: git push"
      fi
    else
      echo "   ⚠️  Could not commit the synced files — commit them by hand: git add -A && git commit"
    fi
  fi
  if [ -n "$wf" ]; then
    echo "   ℹ️  Workflow files changed too and Codespaces cannot push those — commit them from your machine:"
    printf '%s\n' "$wf" | sed 's/^/       /'
  fi
}

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
    ENGINE_OUT=$(mktemp)
    PRE_STATUS=$(git status --porcelain --untracked-files=all 2>/dev/null || true)
    if bash scripts/apply-updates.sh 2>&1 | tee "$ENGINE_OUT"; then
      # A MAJOR release is not applied without opt-in (the AI rules, snippets
      # and harness would change under a project in flight); the additive
      # security/platform files were synced. Tell the user once, briefly after.
      if grep -q "^MAJOR_HELD|" "$ENGINE_OUT"; then
        HELD_TO=$(grep "^MAJOR_HELD|" "$ENGINE_OUT" | head -1 | cut -d'|' -f3)
        echo ""
        echo "🛑 Template v$HELD_TO is a MAJOR release — held back; your project stays on $LOCAL."
        echo "   Platform security updates were applied. New AI rules/snippets/harness were NOT."
        if grep -q "^MIGRATION_NEEDED|" "$ENGINE_OUT"; then
          echo "   This project uses a retired stack ($(grep "^MIGRATION_NEEDED|" "$ENGINE_OUT" | head -1 | cut -d'|' -f2))."
          echo "   Ask your AI assistant: 'migrate to the supported stack' (see .template-migration-needed)."
        else
          echo "   When ready: ask your AI assistant to 'accept the major template update', or run"
          echo "       TEMPLATE_ACCEPT_MAJOR=1 bash scripts/apply-updates.sh"
        fi
      fi
      auto_commit_platform_update "$LOCAL" "$LATEST"
    else
      echo "❌ The update engine failed — see the output above."
      echo "   This repo is still on $LOCAL and is NOT receiving platform security fixes."
      echo "   Ask your AI assistant: 'the template update failed, can you fix it?'"
    fi
    rm -f "$ENGINE_OUT"
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

