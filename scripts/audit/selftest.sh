#!/usr/bin/env bash
# Hermetic self-test for the audit PLUMBING: lib.sh attestation, the pre-push
# gate decisions (default on, opt-out, Claude Code hold, automation fail-open),
# and the .claude installer merge.
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
cd "$T" || exit 1
git init -q; git config user.email t@t; git config user.name t
git commit -q --allow-empty -m base
git update-ref refs/remotes/origin/master HEAD     # fake origin/master = base
mkdir -p scripts/audit
cp "$AUDIT_DIR/lib.sh" "$AUDIT_DIR/install-claude-hooks.sh" scripts/audit/
cp "$REPO_ROOT/scripts/pre-push-review.sh" scripts/
echo "console.log(1)" > app.js; git add app.js; git commit -q -m change   # reviewable diff vs origin/master
. scripts/audit/lib.sh
# The gate must never reach the "run the audit inline" branch here: stderr is
# redirected (not a tty) and CLAUDECODE is cleared unless a test sets it.
prepush() { env -u CLAUDECODE "$@" bash scripts/pre-push-review.sh >/dev/null 2>&1; }

echo "attestation:"
audit_write_state FAIL 1 2 3 "n"; [ "$(audit_json_get "$(audit_state_file)" medium)" = "3" ] && ok "medium count recorded (4-arg numeric form)" || bad "medium"
audit_write_state PASS 0 0 "legacy note"; [ "$(audit_json_get "$(audit_state_file)" note)" = "legacy note" ] && [ "$(audit_json_get "$(audit_state_file)" medium)" = "0" ] && ok "legacy 4th-arg note still works" || bad "legacy note"

echo "gate off by default:"
rm -f "$(audit_state_file)" .audit-auto
prepush CLAUDECODE=1; [ $? -eq 0 ] && ok "no attestation, no opt-in → push allowed (gate off)" || bad "default off"
prepush AUDIT_AUTO=1 CLAUDECODE=1; [ $? -eq 1 ] && ok "AUDIT_AUTO=1 enables the gate" || bad "env opt-in"
touch .audit-auto   # enable the gate for the tests below

echo "pre-push gate (opted in):"
rm -f "$(audit_state_file)"
prepush CLAUDECODE=1; [ $? -eq 1 ] && ok "no attestation in Claude Code → push held (trigger audit loop)" || bad "claude hold"
prepush; [ $? -eq 0 ] && ok "no attestation, automation (no tty, no session) → fail-open allow" || bad "automation allow"
audit_write_state FAIL 0 0 1 t; prepush CLAUDECODE=1; [ $? -eq 1 ] && ok "FAIL attestation (medium left) → block" || bad "FAIL block"
audit_write_state PASS 0 0 0 t; prepush CLAUDECODE=1; [ $? -eq 0 ] && ok "PASS attestation → allow" || bad "PASS allow"
echo "x" >> app.js; git add app.js; git commit -q -m more; prepush CLAUDECODE=1; [ $? -eq 1 ] && ok "tree changed after PASS → stale → held again" || bad "stale hold"
git checkout -q HEAD~1 -- app.js; git commit -q -am docs-revert >/dev/null 2>&1 || true
rm -f "$(audit_state_file)"; git checkout -q -b docsonly; git update-ref refs/remotes/origin/master HEAD; echo d > README.md; git add README.md; git commit -q -m docs
prepush CLAUDECODE=1; [ $? -eq 0 ] && ok "docs-only diff vs base → allow" || bad "docs-only allow"

echo "scope:"
printf 'auto_update:\n  - path: "scripts/"\n    is_directory: true\n  - path: "chat/"\n  - path: "scripts/only.sh"\nauto_update_major:\n  - path: ".platform-rules/"\ncleanup:\n  - path: "old"\n' > .template-manifest.yml
git remote add origin https://github.com/bayer-int/dd-my-project.git
out=$(printf 'backend/src/a.ts\nchat/server/x.js\nscripts/only.sh\n.platform-rules/y.md\ndocs/z.txt\nREADME.md\n.template-version\nfrontend/App.tsx\n' | audit_reviewable | tr '\n' ' ')
[ "$out" = "backend/src/a.ts frontend/App.tsx " ] && ok "project: platform-owned + docs dropped, app code kept ($out)" || bad "project scope: $out"
git remote set-url origin https://github.com/bayer-int/dd-template-repository.git
out=$(printf 'chat/server/x.js\nscripts/only.sh\nREADME.md\n' | audit_reviewable | tr '\n' ' ')
[ "$out" = "chat/server/x.js scripts/only.sh " ] && ok "template repo: platform files are the code under review ($out)" || bad "template scope: $out"
git remote remove origin; rm -f .template-manifest.yml

echo ".claude installer:"
mkdir -p .claude
printf '{"hooks":{"PostToolUse":[{"matcher":"Write","hooks":[{"type":"command","command":"echo hi"}]}],"Stop":[{"hooks":[{"type":"command","command":"\\"${CLAUDE_PROJECT_DIR}\\"/scripts/audit/stop-hook.sh"}]}]},"model":"opus"}' > .claude/settings.json
bash scripts/audit/install-claude-hooks.sh >/dev/null 2>&1
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json"));process.exit(s.hooks.PostToolUse&&s.model==="opus"&&s.hooks.SessionStart?.[0]?.hooks?.[0]?.command?.includes("check-template-pr.sh")?0:1)' && ok "merges (preserves PostToolUse + model, adds SessionStart)" || bad "merge"
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json"));process.exit(s.hooks.Stop===undefined?0:1)' && ok "retires the legacy audit Stop hook" || bad "retire Stop"
bash scripts/audit/install-claude-hooks.sh >/dev/null 2>&1
node -e 'const s=JSON.parse(require("fs").readFileSync(".claude/settings.json"));process.exit(s.hooks.SessionStart.length===1?0:1)' && ok "idempotent (1 SessionStart entry after re-run)" || bad "idempotent"

echo ""
[ $fail -eq 0 ] && echo "ALL PLUMBING TESTS PASSED ✓" || echo "SOME TESTS FAILED ✗"
exit $fail
