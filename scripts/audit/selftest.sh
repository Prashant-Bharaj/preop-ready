#!/usr/bin/env bash
# Hermetic self-test for the audit PLUMBING: lib.sh attestation, the pre-push
# gate decisions, the Stop-hook trigger logic, and the .claude installer merge.
# Builds a throwaway git repo so it never touches your real attestation, hooks,
# or remotes. Does NOT run the LLM audit itself — that is exercised live via
# /audit. Exit 0 = all plumbing tests pass.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
AUDIT_DIR="$REPO_ROOT/scripts/audit"
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cd "$T"
git init -q; git config user.email t@t; git config user.name t
git commit -q --allow-empty -m base
git update-ref refs/remotes/origin/master HEAD     # fake origin/master = base
mkdir -p scripts/audit
cp "$AUDIT_DIR/lib.sh" "$AUDIT_DIR/stop-hook.sh" "$AUDIT_DIR/install-claude-hooks.sh" scripts/audit/
cp "$REPO_ROOT/scripts/pre-push-review.sh" scripts/
echo "console.log(1)" > app.js; git add app.js; git commit -q -m change   # reviewable diff vs origin/master
. scripts/audit/lib.sh

echo "pre-push gate:"
rm -f "$(audit_state_file)"
bash scripts/pre-push-review.sh >/dev/null 2>&1; [ $? -eq 0 ] && ok "no attestation → fail-open allow" || bad "fail-open allow"
audit_write_state FAIL 1 0 t; bash scripts/pre-push-review.sh >/dev/null 2>&1; [ $? -eq 1 ] && ok "FAIL attestation → block" || bad "FAIL block"
audit_write_state PASS 0 0 t; bash scripts/pre-push-review.sh >/dev/null 2>&1; [ $? -eq 0 ] && ok "PASS attestation → allow" || bad "PASS allow"
echo "x" >> app.js; bash scripts/pre-push-review.sh >/dev/null 2>&1; [ $? -eq 0 ] && ok "tree changed after PASS → stale → fail-open allow" || bad "stale allow"; git checkout -q app.js

echo "Stop-hook trigger:"
rm -f "$(audit_state_file)"
out=$(printf '{"stop_hook_active":true}'  | bash scripts/audit/stop-hook.sh); [ -z "$out" ] && ok "loop guard (active=true) → allow stop" || bad "loop guard"
out=$(printf '{"stop_hook_active":false}' | bash scripts/audit/stop-hook.sh); printf '%s' "$out" | grep -q '"decision":"block"' && ok "changed + no attestation → block (trigger audit)" || bad "trigger"
audit_write_state PASS 0 0 t
out=$(printf '{"stop_hook_active":false}' | bash scripts/audit/stop-hook.sh); [ -z "$out" ] && ok "current tree attested → allow stop" || bad "attested allow"

echo ".claude installer:"
mkdir -p .claude
printf '{"hooks":{"PostToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo hi"}]}]},"model":"opus"}' > .claude/settings.json
bash scripts/audit/install-claude-hooks.sh >/dev/null 2>&1
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json"));process.exit(s.hooks.PostToolUse&&s.model==="opus"&&s.hooks.Stop?.[0]?.hooks?.[0]?.command?.includes("stop-hook.sh")?0:1)' && ok "merges (preserves PostToolUse + model, adds Stop)" || bad "merge"
bash scripts/audit/install-claude-hooks.sh >/dev/null 2>&1
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json"));process.exit(s.hooks.Stop.length===1?0:1)' && ok "idempotent (1 Stop entry after re-run)" || bad "idempotent"

echo ""
[ $fail -eq 0 ] && echo "ALL PLUMBING TESTS PASSED ✓" || echo "SOME TESTS FAILED ✗"
exit $fail
