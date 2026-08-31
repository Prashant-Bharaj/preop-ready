#!/usr/bin/env bash
# Register the audit Stop hook + /audit command in the developer's (gitignored)
# .claude/ config. Tracked in the repo so every clone gets the trigger at setup
# WITHOUT committing personal .claude/ files. Idempotent and non-destructive:
# it MERGES into an existing .claude/settings.json (never clobbers other hooks)
# and no-ops if our hook is already present. Called from devcontainer.json's
# postStartCommand after install-hooks.sh.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0
command -v node >/dev/null 2>&1 || { echo "[audit-setup] node not found — skipping .claude registration."; exit 0; }

mkdir -p .claude/commands

# 1) Merge the Stop hook into .claude/settings.json (create if missing).
node - <<'NODE'
const fs = require('fs');
const path = '.claude/settings.json';
const HOOK_CMD = '"${CLAUDE_PROJECT_DIR}"/scripts/audit/stop-hook.sh';

let settings = {};
if (fs.existsSync(path)) {
  try {
    settings = JSON.parse(fs.readFileSync(path, 'utf8')) || {};
  } catch {
    console.error('[audit-setup] .claude/settings.json is not valid JSON — leaving it untouched.');
    process.exit(0);
  }
}
settings.hooks = settings.hooks || {};
const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];

const already = stop.some((entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('scripts/audit/stop-hook.sh'))
);
if (already) {
  console.log('[audit-setup] Stop hook already registered — no change.');
  process.exit(0);
}

stop.push({
  hooks: [{
    type: 'command',
    command: HOOK_CMD,
    timeout: 30,
    statusMessage: 'Checking audit attestation…',
  }],
});
settings.hooks.Stop = stop;
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
console.log('[audit-setup] Registered audit Stop hook in .claude/settings.json.');
NODE

# 2) Write the /audit command if absent (don't overwrite a customized one).
if [ ! -f .claude/commands/audit.md ]; then
  cat > .claude/commands/audit.md <<'CMD'
---
description: Run the deep security/performance/style audit on changed code and record the attestation
---
Run the deep audit now, in-session, using the Agent tool. Follow the playbook in
@scripts/audit/deep-audit.md exactly:

- Scope to code changed vs `origin/master` (plus uncommitted), dropping `docs/**` and `*.md`.
- Fan out review subagents by area/dimension, each following @scripts/audit/reviewer-prompt.md.
- Verify each surviving Critical/High with a separate adversarial subagent (this is how false positives get caught).
- Record the verdict: `source scripts/audit/lib.sh; audit_write_state <PASS|FAIL> <critical> <high> "<note>"`, and write the full report to the path from `audit_report_file`.

Do NOT fix anything unless I ask. End with a short summary: verdict, counts, the
findings that matter most, and the report path.

$ARGUMENTS
CMD
  echo "[audit-setup] Wrote .claude/commands/audit.md."
else
  echo "[audit-setup] .claude/commands/audit.md already present — no change."
fi
