#!/usr/bin/env bash
# On-demand deep audit for a PLAIN TERMINAL (outside a live Claude Code session).
# Inside a session, prefer the /audit command — `claude -p` refuses to run nested.
#
# Runs headless Claude Code against the deep-audit playbook, which fans out
# review + verify subagents and records the attestation (scripts/audit/lib.sh).
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
PLAYBOOK="$REPO_ROOT/scripts/audit/deep-audit.md"
BASE="${AUDIT_BASE:-origin/master}"

if [ -n "${CLAUDECODE:-}" ]; then
  echo "You're inside a Claude Code session — run the /audit command instead"
  echo "('claude -p' can't launch nested). See $PLAYBOOK."
  exit 2
fi
command -v claude >/dev/null 2>&1 || { echo "'claude' (Claude Code) not found on PATH."; exit 127; }

cd "$REPO_ROOT" && AUDIT_BASE="$BASE" claude -p "Perform the deep audit now, following the playbook at scripts/audit/deep-audit.md exactly (fan out review + verify subagents per scripts/audit/reviewer-prompt.md over the code changed vs $BASE, then record the verdict with scripts/audit/lib.sh audit_write_state and write the report). Do not fix anything. End with the verdict and counts."
