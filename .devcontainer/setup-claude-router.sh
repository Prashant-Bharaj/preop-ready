#!/usr/bin/env bash
# Compatibility shim. Claude Code now talks to myGenAssist directly (native
# gateway mode) — see setup-claude-code.sh. This file keeps the old name alive
# because auto-update-template.sh / apply-updates.sh in repos that have not
# synced yet still call it by path on Codespace start.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-claude-code.sh" "$@"
