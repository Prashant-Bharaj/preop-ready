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
