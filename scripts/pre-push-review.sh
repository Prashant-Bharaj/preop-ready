#!/usr/bin/env bash
# ============================================================================
# Pre-push audit gate — ATTESTATION CHECK (fail-open)
# ----------------------------------------------------------------------------
# The deep security/perf/style audit runs DURING development (on demand via
# /audit or the `audit` skill; Stop-hook triggered only when the automatic
# gate is enabled — see scripts/audit/) and records an attestation for the
# exact tree it reviewed. This hook does NOT re-audit; it just checks that
# attestation, and only when the automatic gate is enabled (AUDIT_AUTO=1 or a
# .audit-auto marker at the repo root). Otherwise it allows silently.
#
#   • PASS attestation matches the tree being pushed  → allow instantly.
#   • FAIL attestation (Critical/High unresolved)     → BLOCK (git push --no-verify to override).
#   • stale / missing attestation                     → WARN + allow (fail-open).
#
# On-demand run:  scripts/audit/run.sh    (or /audit inside Claude Code)
# Installed as .git/hooks/pre-push by scripts/install-hooks.sh.
# ============================================================================
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ "${AUDIT_AUTO:-0}" != "1" ] && [ ! -f "$REPO_ROOT/.audit-auto" ]; then
  exit 0   # automatic gate off — audit on demand only
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

if [ -f "$STATE" ]; then
  ATT_HASH="$(audit_json_get "$STATE" treeHash)"
  VERDICT="$(audit_json_get "$STATE" verdict)"
  if [ "$ATT_HASH" = "$CUR" ]; then
    case "$VERDICT" in
      PASS)
        echo "[pre-push audit] ✅ attestation PASS for the tree you're pushing — allow."
        exit 0 ;;
      FAIL)
        C="$(audit_json_get "$STATE" critical)"; H="$(audit_json_get "$STATE" high)"
        echo ""
        echo "[pre-push audit] ❌ BLOCKED — last audit FAILED for THIS tree (${C:-?} critical, ${H:-?} high)."
        echo "   Report: $(audit_report_file)"
        echo "   Fix the findings and re-audit (/audit), or override: git push --no-verify"
        exit 1 ;;
    esac
  fi
fi

# Stale or missing attestation → FAIL-OPEN (warn, allow).
echo ""
echo "[pre-push audit] ⚠️  No fresh audit attestation for the tree you're pushing."
echo "   The code changed since the last recorded audit (or none exists yet)."
echo "   Recommended: run /audit in Claude Code (or scripts/audit/run.sh) before pushing."
echo "   Allowing the push (fail-open)."
exit 0
