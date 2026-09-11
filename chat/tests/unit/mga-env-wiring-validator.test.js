// mga-env-wiring-validator.test.js — deterministic compose env wiring.
//
// An iterate that introduces the app's first AI feature doesn't re-dispatch
// integration, so MGA_* credentials written to .env never reached the
// backend container (observed live). The validator patches env_file into
// the backend service pre-compose; these tests pin idempotence and the
// no-op conditions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyMgaEnvWiringFix } from '../../server/validators/docker/mga-env-wiring-validator.js';

const COMPOSE = `services:
  database:
    image: postgres:16
  backend:
    build:
      context: ./backend
    environment:
      DATABASE_HOST: database
  frontend:
    build:
      context: ./frontend
`;

function ws({ env = null, compose = COMPOSE } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mga-wiring-'));
  if (env != null) writeFileSync(path.join(dir, '.env'), env);
  if (compose != null) writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  return dir;
}

test('adds env_file to backend when .env has MGA_* and compose lacks wiring', () => {
  const dir = ws({ env: 'MGA_API_KEY=abc\nMGA_BASE_URL=https://chat.int.bayer.com/api/v2\nMGA_ASSISTANT_ID=xyz\n' });
  const r = applyMgaEnvWiringFix(dir);
  assert.equal(r.applied, true);
  const out = readFileSync(path.join(dir, 'docker-compose.yml'), 'utf-8');
  assert.match(out, /backend:[\s\S]*env_file:[\s\S]*\.env/);
  // other services untouched
  assert.ok(!/database:[\s\S]{0,80}env_file/.test(out));
  // idempotent — second run is a no-op
  const r2 = applyMgaEnvWiringFix(dir);
  assert.equal(r2.applied, false);
});

test('no-op without MGA_* in .env, without .env, or with existing wiring', () => {
  assert.equal(applyMgaEnvWiringFix(ws({ env: 'DATABASE_URL=x\n' })).applied, false);
  assert.equal(applyMgaEnvWiringFix(ws({})).applied, false);
  const wired = COMPOSE.replace('    environment:', '    env_file:\n      - .env\n    environment:');
  assert.equal(applyMgaEnvWiringFix(ws({ env: 'MGA_API_KEY=a\n', compose: wired })).applied, false);
});

test('no-op on unparseable compose or missing backend service', () => {
  assert.equal(applyMgaEnvWiringFix(ws({ env: 'MGA_API_KEY=a\n', compose: 'services: [not: valid: yaml' })).applied, false);
  assert.equal(applyMgaEnvWiringFix(ws({ env: 'MGA_API_KEY=a\n', compose: 'services:\n  web:\n    image: nginx\n' })).applied, false);
});
