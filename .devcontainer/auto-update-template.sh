#!/usr/bin/env bash
# Auto-check and apply template updates on Codespace start

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
