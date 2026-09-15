#!/usr/bin/env bash
# ============================================================================
# Pre-push audit gate — the deep audit runs BEFORE code leaves the machine
# ----------------------------------------------------------------------------
# ON BY DEFAULT. The audit (scripts/audit/) reviews the code changed vs
# origin/master, fixes every Critical/High/Medium finding, re-audits, and
# repeats until only Low findings remain; then it records an attestation for
# the exact tree it reviewed. This hook checks that attestation and, when
# there is none, triggers the audit:
#
#   • PASS attestation for the current tree  → allow instantly.
#   • FAIL attestation for the current tree  → BLOCK (git push --no-verify to override).
#   • no / stale attestation:
#       inside Claude Code (CLAUDECODE set)  → hold the push and ask the agent to run
#                                              the audit loop (/audit), then push again.
#       interactive terminal with `claude`   → run scripts/audit/run.sh now, then re-check.
#       automation (no terminal, no claude)  → WARN + allow (fail-open) — never runs an
#                                              LLM pass from a script or CI (the platform
#                                              update commits push this way).
#
# Opt out per project with a `.audit-off` file at the repo root (gitignored) or
# AUDIT_AUTO=0. Docs/markdown-only pushes never gate.
# Installed as .git/hooks/pre-push by scripts/install-hooks.sh.
# ============================================================================
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ "${AUDIT_AUTO:-1}" = "0" ] || [ -f "$REPO_ROOT/.audit-off" ]; then
  exit 0   # opted out — audit on demand only
fi
# shellcheck source=scripts/audit/lib.sh
. "$REPO_ROOT/scripts/audit/lib.sh" 2>/dev/null || { echo "[pre-push audit] lib missing — skipping."; exit 0; }

BASE="${AUDIT_BASE:-origin/master}"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || BASE="master"
git rev-parse --verify "$BASE" >/dev/null 2>&1 || { echo "[pre-push audit] no base ref — skipping."; exit 0; }

# Nothing reviewable? (docs/markdown-only diffs don't gate.)
CHANGED="$(git diff --name-only "$BASE"...HEAD 2>/dev/null | grep -vaE '^docs/|\.md$' || true)"
if [ -z "$CHANGED" ]; then
  echo "[pre-push audit] no reviewable code changes vs $BASE — allow."
  exit 0
fi

STATE="$(audit_state_file)"
CUR="$(audit_tree_hash)"

# Verdict recorded for the CURRENT tree: PASS, FAIL, or NONE (missing/stale/skipped).
attested_verdict() {
  [ -f "$STATE" ] || { echo NONE; return; }
  [ "$(audit_json_get "$STATE" treeHash)" = "$CUR" ] || { echo NONE; return; }
  case "$(audit_json_get "$STATE" verdict)" in
    PASS) echo PASS ;;
    FAIL) echo FAIL ;;
    *)    echo NONE ;;
  esac
}

block_on_fail() {
  local c h m
  c="$(audit_json_get "$STATE" critical)"; h="$(audit_json_get "$STATE" high)"; m="$(audit_json_get "$STATE" medium)"
  echo ""
  echo "[pre-push audit] ❌ BLOCKED — the audit could not get this tree clean (${c:-?} critical, ${h:-?} high, ${m:-?} medium left)."
  echo "   Report: $(audit_report_file)"
  echo "   Fix the remaining findings and re-run /audit, or override: git push --no-verify"
  exit 1
}

case "$(attested_verdict)" in
  PASS) echo "[pre-push audit] ✅ attestation PASS for the tree you're pushing — allow."; exit 0 ;;
  FAIL) block_on_fail ;;
esac

# No fresh attestation → trigger the audit loop.
if [ -n "${CLAUDECODE:-}" ]; then
  # A git hook can't launch the audit inside a live session (claude -p refuses
  # to nest), so hold the push and hand the job to the agent that ran it.
  echo ""
  echo "[pre-push audit] ⛔ Push held: the code being pushed has no audit attestation."
  echo "   Run the deep audit now, in-session: follow scripts/audit/deep-audit.md (the /audit command) —"
  echo "   review, fix every Critical/High/Medium finding, re-audit until only Low remain, record the"
  echo "   verdict with 'source scripts/audit/lib.sh; audit_write_state PASS 0 0 0 \"<note>\"', commit the"
  echo "   fixes, then run the same git push again. Do not bypass it with --no-verify."
  exit 1
fi

if [ -t 2 ] && command -v claude >/dev/null 2>&1; then
  echo "[pre-push audit] Running the deep audit before this push (scripts/audit/run.sh)…"
  bash "$REPO_ROOT/scripts/audit/run.sh" || true
  case "$(attested_verdict)" in
    PASS) echo "[pre-push audit] ✅ audit PASS — allow."; exit 0 ;;
    FAIL) block_on_fail ;;
  esac
  echo "[pre-push audit] ⚠️  The audit recorded no PASS/FAIL for this tree (skipped or diff too large) — allowing (fail-open)."
  echo "   Note: if the audit committed fixes, push again to include them."
  exit 0
fi

echo ""
echo "[pre-push audit] ⚠️  No fresh audit attestation for the code you're pushing."
echo "   Run /audit in Claude Code (or scripts/audit/run.sh) and push again to record one."
echo "   Allowing the push (fail-open)."
exit 0
