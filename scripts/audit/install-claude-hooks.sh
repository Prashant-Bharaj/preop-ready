#!/usr/bin/env bash
# Register the /audit command + the SessionStart hook in the developer's
# (gitignored) .claude/ config, and retire the old audit Stop hook. The audit's
# automatic trigger is the pre-push gate (scripts/pre-push-review.sh, opt-in
# with a .audit-auto marker at the repo root or AUDIT_AUTO=1); /audit and the
# `audit` skill run it on demand. Tracked in the repo so every clone
# gets the same setup WITHOUT committing personal .claude/ files. Idempotent
# and non-destructive: it MERGES into an existing .claude/settings.json (never
# clobbers other hooks) and no-ops when nothing changes. Called from
# devcontainer.json's postStartCommand after install-hooks.sh.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0
command -v node >/dev/null 2>&1 || { echo "[audit-setup] node not found — skipping .claude registration."; exit 0; }

mkdir -p .claude/commands

# 1) Merge our hooks into .claude/settings.json (create if missing):
#    - SessionStart: platform template status (open sync PR / outdated sync
#      workflow / version) printed into Claude's context so the first reply
#      can act on it — the same check the rules ask every AI tool to run.
#    - Retired: the audit Stop hook (scripts/audit/stop-hook.sh) — the audit is
#      now triggered by the pre-push gate, so any old registration is removed.
node - <<'NODE'
const fs = require('fs');
const path = '.claude/settings.json';

const WANTED = [
  {
    event: 'SessionStart',
    matcher: 'startup|resume|clear',
    marker: 'scripts/check-template-pr.sh',
    hook: {
      type: 'command',
      command: '"${CLAUDE_PROJECT_DIR}"/scripts/check-template-pr.sh',
      timeout: 30,
      statusMessage: 'Checking for platform template updates…',
    },
  },
];
const RETIRED = ['scripts/audit/stop-hook.sh'];

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

const usesMarker = (entry, marker) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(marker));

let changed = false;
for (const event of Object.keys(settings.hooks)) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const kept = list.filter((entry) => !RETIRED.some((m) => usesMarker(entry, m)));
  if (kept.length === list.length) continue;
  if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  changed = true;
  console.log(`[audit-setup] Removed the retired audit ${event} hook from .claude/settings.json.`);
}
for (const w of WANTED) {
  const list = Array.isArray(settings.hooks[w.event]) ? settings.hooks[w.event] : [];
  if (list.some((entry) => usesMarker(entry, w.marker))) {
    console.log(`[audit-setup] ${w.event} hook already registered — no change.`);
    continue;
  }
  const entry = { hooks: [w.hook] };
  if (w.matcher) entry.matcher = w.matcher;
  list.push(entry);
  settings.hooks[w.event] = list;
  changed = true;
  console.log(`[audit-setup] Registered ${w.event} hook in .claude/settings.json.`);
}
if (changed) fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
NODE

# 2) Write the /audit command if absent (don't overwrite a customized one).
if [ ! -f .claude/commands/audit.md ]; then
  cat > .claude/commands/audit.md <<'CMD'
---
description: Audit the changed code, fix every Critical/High/Medium finding, re-audit until only Low remain, record the attestation
---
Run the deep audit loop now, in-session, using the Agent tool. Follow the playbook
in @scripts/audit/deep-audit.md exactly:

- Scope to code changed vs `origin/master` (plus uncommitted), dropping `docs/**` and `*.md`.
- Fan out review subagents by area/dimension, each following @scripts/audit/reviewer-prompt.md.
- Verify each surviving Critical/High/Medium with a separate adversarial subagent (this is how false positives get caught).
- Fix every finding that survives, commit the fixes (files by name), and audit again — repeat until a round leaves only Low findings, or stop when a round makes no progress.
- Record the verdict: `source scripts/audit/lib.sh; audit_write_state <PASS|FAIL> <critical> <high> <medium> "<note>"`, and write the full report to the path from `audit_report_file`.

End with a short summary: rounds, what was fixed, the verdict, the Low notes, and
the report path.

$ARGUMENTS
CMD
  echo "[audit-setup] Wrote .claude/commands/audit.md."
else
  echo "[audit-setup] .claude/commands/audit.md already present — no change."
fi
