/**
 * execute_command permission gate: shell FD redirects are not file writes.
 *
 * Module under test:
 *   chat/server/agent/tools/exec-tools.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toolExecuteCommand, stripFdRedirects } from '../../server/agent/tools/exec-tools.js';

const check = (command, scope, workspaceDir) => toolExecuteCommand.checkPermissions({ command }, { workspaceDir, scope });

test('stripFdRedirects drops /dev/null and fd-to-fd redirects, keeps file redirects', () => {
  assert.equal(stripFdRedirects('psql -c x 2>/dev/null'), 'psql -c x ');
  assert.equal(stripFdRedirects('cmd >/dev/null 2>&1 | tail'), 'cmd   | tail');
  assert.equal(stripFdRedirects('cmd &>/dev/null'), 'cmd ');
  assert.equal(stripFdRedirects('npm run build > build.log'), 'npm run build > build.log');
});

test("observed live: schema proof with 2>/dev/null is allowed; real writes outside the scope still denied", () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-perm-'));
  try {
    const proof = "docker compose exec database psql -U myapp_user -d myapp -c '\\d notes' 2>/dev/null";
    assert.equal(check(proof, 'backend', wd).verdict, 'allow');
    assert.equal(check('docker compose logs backend 2>&1 | tail -20', 'backend', wd).verdict, 'allow');
    assert.equal(check('npm run build > backend/build.log', 'backend', wd).verdict, 'allow');
    const cross = check('echo x > database/init/99_hack.sql', 'backend', wd);
    assert.equal(cross.verdict, 'deny');
    assert.match(cross.reason, /database\/init\/99_hack\.sql/);
    assert.equal(check('rm -rf .github/workflows', 'backend', wd).verdict, 'deny');
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
  }
});
