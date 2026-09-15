/**
 * workspace-env — the gitignored workspace-root .env every writer goes
 * through (pre-stage, credential validator, MGA provisioning).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  upsertEnvFile, readEnvFile, ensureWorkspaceEnv, canonicalEnvEntries, WORKSPACE_ENV_HEADER, workspaceDbCredentials,
} from '../../server/core/workspace-env.js';
import { LOCAL_DB_CREDENTIALS, LOCAL_VECTORDB_CREDENTIALS } from '../../server/config/defaults.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wsenv-'));

test('upsertEnvFile creates, replaces in place, appends, keeps unrelated lines', () => {
  const file = path.join(tmp(), '.env');
  assert.deepEqual(upsertEnvFile(file, { A: '1', B: '2' }, { header: '# h' }), ['A', 'B']);
  assert.equal(fs.readFileSync(file, 'utf-8'), '# h\nA=1\nB=2\n');
  fs.appendFileSync(file, '# keep me\nexport C=3\n');
  assert.deepEqual(upsertEnvFile(file, { B: '22', D: '4' }), ['B', 'D']);
  assert.equal(fs.readFileSync(file, 'utf-8'), '# h\nA=1\nB=22\n# keep me\nexport C=3\nD=4\n');
  assert.deepEqual(upsertEnvFile(file, { A: '1' }), []);          // unchanged value → nothing written
  assert.deepEqual(readEnvFile(file), { A: '1', B: '22', C: '3', D: '4' });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('dropPrefix replaces the whole MGA_* set (the provisioning merge)', () => {
  const file = path.join(tmp(), '.env');
  fs.writeFileSync(file, 'DATABASE_NAME=myapp\nMGA_API_KEY=old\nMGA_ASSISTANT_ID_X=stale\n');
  upsertEnvFile(file, { MGA_API_KEY: 'new', MGA_ASSISTANT_ID: 'id' }, { dropPrefix: 'MGA_' });
  assert.deepEqual(readEnvFile(file), { DATABASE_NAME: 'myapp', MGA_API_KEY: 'new', MGA_ASSISTANT_ID: 'id' });
});

test('canonicalEnvEntries mirrors the fixed local credentials', () => {
  assert.deepEqual(canonicalEnvEntries(), {});
  assert.deepEqual(canonicalEnvEntries({ database: true }), {
    DATABASE_NAME: LOCAL_DB_CREDENTIALS.name, DATABASE_USER: LOCAL_DB_CREDENTIALS.user, DATABASE_PASSWORD: LOCAL_DB_CREDENTIALS.password,
  });
  assert.equal(canonicalEnvEntries({ vectordb: true }).VECTORDB_USER, LOCAL_VECTORDB_CREDENTIALS.user);
});

test('ensureWorkspaceEnv adds missing keys only and always leaves a file behind', () => {
  const dir = tmp();
  const first = ensureWorkspaceEnv(dir, { database: true });
  assert.deepEqual(first.added, ['DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD']);
  assert.match(fs.readFileSync(first.path, 'utf-8'), new RegExp(`^${WORKSPACE_ENV_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
  fs.appendFileSync(first.path, 'DATABASE_PASSWORD=mine\n');
  const second = ensureWorkspaceEnv(dir, { database: true, vectordb: true });
  assert.deepEqual(second.added, ['VECTORDB_NAME', 'VECTORDB_USER', 'VECTORDB_PASSWORD']);
  assert.equal(readEnvFile(second.path).DATABASE_PASSWORD, 'mine');
  const empty = ensureWorkspaceEnv(tmp());
  assert.deepEqual(empty.added, []);
  assert.ok(fs.existsSync(empty.path), 'a backend-only app still gets the file env_file points at');
});

test('workspaceDbCredentials prefers the .env values, falls back to canonical', () => {
  const dir = tmp();
  assert.deepEqual(workspaceDbCredentials(dir), LOCAL_DB_CREDENTIALS);
  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_NAME=cockpit\nDATABASE_USER=cockpit_user\n');
  const c = workspaceDbCredentials(dir);
  assert.equal(c.name, 'cockpit'); assert.equal(c.user, 'cockpit_user'); assert.equal(c.password, LOCAL_DB_CREDENTIALS.password); assert.equal(c.host, 'database');
});
