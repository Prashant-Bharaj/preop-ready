#!/usr/bin/env bash
# Deep audit for a PLAIN TERMINAL (outside a live Claude Code session): run on
# demand, or by the pre-push gate (scripts/pre-push-review.sh) before a push.
# Inside a session, prefer the /audit command — `claude -p` refuses to run nested.
#
# Runs headless Claude Code against the deep-audit playbook: review, fix every
# Critical/High/Medium, re-audit until only Low remain, record the attestation
# (scripts/audit/lib.sh). Fixes are committed so the attested tree is pushable.
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

cd "$REPO_ROOT" && AUDIT_BASE="$BASE" claude -p "Perform the deep audit now, following the playbook at scripts/audit/deep-audit.md exactly: fan out review + verify subagents per scripts/audit/reviewer-prompt.md over the code changed vs $BASE, fix every surviving Critical/High/Medium finding, commit the fixes (files by name, message 'fix(security): audit round <n>'), re-audit, and repeat until only Low findings remain or a round makes no progress. Then record the verdict with scripts/audit/lib.sh audit_write_state and write the report. End with the rounds, what was fixed, the verdict and counts."
