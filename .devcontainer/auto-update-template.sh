#!/usr/bin/env bash
# Auto-check and apply template updates on Codespace start.
# Also activates Claude Code (see the migration bridge below).

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

RESULT=$(bash scripts/check-updates.sh 2>/dev/null)

case "$RESULT" in
  UP_TO_DATE)
    echo "✅ Template is up to date."
    ;;
  UPDATE_AVAILABLE*)
    LOCAL=$(echo "$RESULT" | cut -d'|' -f2)
    LATEST=$(echo "$RESULT" | cut -d'|' -f3)
    echo "📦 Update available: $LOCAL → $LATEST"
    echo "   Applying updates..."
    bash scripts/apply-updates.sh
    ;;
  *)
    echo "⚠️  Could not check for updates (network issue or not in Codespaces)."
    ;;
esac

# Handle open Dependabot PRs: auto-merge green patch/minor, surface the rest
if [ -f scripts/check-dependabot-prs.sh ]; then
  bash scripts/check-dependabot-prs.sh || true
fi

# Bring the working tree up to date with merged updates (security fixes etc.).
# Fast-forward only, and only on the default branch — local work is never
# overwritten; if the pull can't apply cleanly it just reports and moves on.
DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
if [ -n "$DEFAULT_BRANCH" ] && [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
  BEFORE=$(git rev-parse HEAD 2>/dev/null)
  if git pull --ff-only origin "$DEFAULT_BRANCH" >/dev/null 2>&1; then
    AFTER=$(git rev-parse HEAD 2>/dev/null)
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
