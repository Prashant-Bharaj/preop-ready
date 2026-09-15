#!/usr/bin/env bash
# Claude Code Stop hook — the "after every relevant action" audit trigger.
#
# OFF by default: the automatic gate only runs when AUDIT_AUTO=1 is set or the
# marker file .audit-auto exists at the repo root (per-developer, gitignored).
# The audit itself stays available on demand: /audit in Claude Code, the
# `audit` skill, or scripts/audit/run.sh.
#
# When enabled and a turn ends with tracked CODE changed since the last audit
# attestation, ask the agent (via a block decision) to run the deep audit
# before stopping. Otherwise let it stop. Fast + read-only.
#
# Registered per-developer in .claude/settings.json (gitignored). The SCRIPT is
# tracked so the whole team shares one implementation; only the registration is
# local. Reads the Stop event JSON on stdin.
set -uo pipefail

INPUT="$(cat)"

# Loop guard: if we already blocked once in this stop-cycle, let the agent stop.
if printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ "${AUDIT_AUTO:-0}" != "1" ] && [ ! -f "$REPO_ROOT/.audit-auto" ]; then
  exit 0   # automatic gate off — audit on demand only
fi
# shellcheck source=scripts/audit/lib.sh
. "$REPO_ROOT/scripts/audit/lib.sh" 2>/dev/null || exit 0

BASE="${AUDIT_BASE:-origin/master}"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || BASE="master"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || exit 0

# Only care about reviewable code changes (committed vs base, or uncommitted).
CHANGED="$(git diff --name-only "$BASE"...HEAD 2>/dev/null | grep -vaE '^docs/|\.md$' || true)"
WORKING="$(git diff --name-only 2>/dev/null | grep -vaE '^docs/|\.md$' || true)"
if [ -z "$CHANGED$WORKING" ]; then
  exit 0   # nothing to audit → allow stop
fi

# Current tree already attested (PASS or FAIL for this exact tree)? Don't
# re-trigger — the agent stops so the user (or the fix loop) can act.
STATE="$(audit_state_file)"
CUR="$(audit_tree_hash)"
if [ -f "$STATE" ] && [ "$(audit_json_get "$STATE" treeHash)" = "$CUR" ]; then
  exit 0
fi

# Fresh code with no attestation → ask the agent to audit before finishing.
REASON="Tracked code changed since the last security audit and there is no attestation for the current tree. Before finishing, run the deep audit: follow scripts/audit/deep-audit.md — fan out review + verify subagents over the changed files per scripts/audit/reviewer-prompt.md, then record the verdict with 'source scripts/audit/lib.sh; audit_write_state <PASS|FAIL> <critical> <high> \"<note>\"'. Do NOT fix anything unless the user asks. If you have just completed this audit in this turn, you may stop."
node -e 'process.stdout.write(JSON.stringify({ decision: "block", reason: process.argv[1] }))' "$REASON"
exit 0
