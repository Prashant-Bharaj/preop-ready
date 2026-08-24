/**
 * Unit tests for the workspace-root MGA env reader.
 *
 * Module under test:
 *   chat/server/core/app-secrets-scaffold.js (readWorkspaceMgaEnv)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { readWorkspaceMgaEnv } from '../../server/core/app-secrets-scaffold.js';

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeWorkspace(envContent) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mga-env-reader-test-'));
  roots.push(root);
  if (envContent !== null) fs.writeFileSync(path.join(root, '.env'), envContent);
  return root;
}

test('missing .env → present:false', () => {
  const r = readWorkspaceMgaEnv(makeWorkspace(null));
  assert.deepEqual(r, { present: false, baseUrl: null, apiKeySet: false, assistants: [] });
});

test('full MGA .env with namespaced assistant parses to shape', () => {
  const r = readWorkspaceMgaEnv(makeWorkspace([
    'MGA_API_KEY=mga-secret-value-123',
    'MGA_BASE_URL=https://chat.int.bayer.com/api/v2',
    'MGA_ASSISTANT_ID=abc-123',
    'MGA_ASSISTANT_ID_REVIEWER=def-456',
  ].join('\n')));
  assert.equal(r.present, true);
  assert.equal(r.apiKeySet, true);
  assert.equal(r.baseUrl, 'https://chat.int.bayer.com/api/v2');
  assert.deepEqual(r.assistants, [
    { envVar: 'MGA_ASSISTANT_ID', id: 'abc-123', set: true },
    { envVar: 'MGA_ASSISTANT_ID_REVIEWER', id: 'def-456', set: true },
  ]);
});

test('the API key value is never present in the returned object', () => {
  const r = readWorkspaceMgaEnv(makeWorkspace('MGA_API_KEY=mga-secret-value-123\nMGA_ASSISTANT_ID=abc\n'));
  assert.ok(!JSON.stringify(r).includes('mga-secret-value-123'));
});

test('empty values report unset', () => {
  const r = readWorkspaceMgaEnv(makeWorkspace('MGA_API_KEY=\nMGA_ASSISTANT_ID=\n'));
  assert.equal(r.present, true);
  assert.equal(r.apiKeySet, false);
  assert.deepEqual(r.assistants, [{ envVar: 'MGA_ASSISTANT_ID', id: '', set: false }]);
});

test('.env without MGA vars → present:false', () => {
  const r = readWorkspaceMgaEnv(makeWorkspace('POSTGRES_PASSWORD=x\n# comment\n'));
  assert.equal(r.present, false);
});
