#!/usr/bin/env bash
# Interactive: connect Claude Code to Bayer myGenAssist.
# Prompts for your API key (hidden), then hands off to setup-claude-router.sh
# which writes the config and starts the router. Run it any time to
# re-enter a key (e.g. after a Codespace rebuild or a key rotation).
#
#   mga-login                        (alias registered by setup-claude-router.sh)
#   bash .devcontainer/mga-login.sh  (equivalent)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

read -r -s -p "Paste your myGenAssist API key (mga-...): " MYGENASSIST_API_KEY
echo
if [ -z "$MYGENASSIST_API_KEY" ]; then
  echo "❌ No key entered — nothing changed."
  exit 1
fi

export MYGENASSIST_API_KEY
bash "$SCRIPT_DIR/setup-claude-router.sh"
