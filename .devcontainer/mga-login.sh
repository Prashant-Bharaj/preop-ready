#!/usr/bin/env bash
# Interactive: connect Claude Code to Bayer myGenAssist.
# Prompts for your API key (shown as ***), then hands off to setup-claude-router.sh
# which writes the config and starts the router. Run it any time to re-enter a key
# (e.g. after a Codespace rebuild or a key rotation).
#
#   mga-login                        (alias registered by setup-claude-router.sh)
#   bash .devcontainer/mga-login.sh  (equivalent)

# Fail fast — this script handles an API key. The read loop below is the only
# place a non-zero status is expected, and it sits in a `while` condition,
# which set -e does not act on.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read the key with '*' masking. Plain `read -s` shows nothing at all, which
# makes people think the terminal froze; this echoes a '*' per character.
printf "Paste your myGenAssist API key (mga-...): "
MYGENASSIST_API_KEY=""
while IFS= read -r -s -n1 _ch; do
  [ -z "$_ch" ] && break                                # Enter/newline ends input
  if [ "$_ch" = $'\177' ] || [ "$_ch" = $'\b' ]; then   # backspace erases last char
    if [ -n "$MYGENASSIST_API_KEY" ]; then
      MYGENASSIST_API_KEY="${MYGENASSIST_API_KEY%?}"
      printf '\b \b'
    fi
  else
    MYGENASSIST_API_KEY="${MYGENASSIST_API_KEY}${_ch}"
    printf '*'
  fi
done
printf '\n'

if [ -z "$MYGENASSIST_API_KEY" ]; then
  echo "❌ No key entered — nothing changed."
  exit 1
fi

export MYGENASSIST_API_KEY
bash "$SCRIPT_DIR/setup-claude-router.sh"
