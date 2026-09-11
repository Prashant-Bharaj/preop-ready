/**
 * Credential resolution order, incl. the portal-injected codespace secret.
 *
 * Module under test:
 *   chat/server/core/auth.js (resolveCredentials)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCredentials, DEFAULT_MGA_BASE_URL } from '../../server/core/auth.js';

const noFile = path.join(os.tmpdir(), `no-secrets-${process.pid}.json`);

test('portal secret alone configures the harness against the platform MGA endpoint', () => {
  const c = resolveCredentials({ env: { MYGENASSIST_API_KEY: 'mga-test' }, secretsPath: noFile });
  assert.equal(c.source, 'codespace-secret');
  assert.equal(c.apiKey, 'mga-test');
  assert.equal(c.baseUrl, DEFAULT_MGA_BASE_URL);
  assert.ok(typeof c.model === 'string' && c.model.length > 0);
  assert.equal(c.mode, 'beginner');
});

test('saved settings beat the portal secret; explicit env beats both; nothing → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
  try {
    const file = path.join(dir, 'secrets.json');
    fs.writeFileSync(file, JSON.stringify({ baseUrl: 'https://saved.example/api', apiKey: 'saved-key', model: 'm1' }));
    const saved = resolveCredentials({ env: { MYGENASSIST_API_KEY: 'mga-test' }, secretsPath: file });
    assert.equal(saved.source, 'file');
    assert.equal(saved.apiKey, 'saved-key');

    const envc = resolveCredentials({ env: { OPENAI_COMPAT_BASE_URL: 'https://env.example', OPENAI_COMPAT_API_KEY: 'env-key', MYGENASSIST_API_KEY: 'mga-test' }, secretsPath: file });
    assert.equal(envc.source, 'env');
    assert.equal(envc.apiKey, 'env-key');

    assert.equal(resolveCredentials({ env: {}, secretsPath: noFile }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
