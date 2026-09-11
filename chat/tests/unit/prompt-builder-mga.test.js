/**
 * Unit tests for the MGA ENV FILE spawn-message section.
 *
 * Module under test:
 *   chat/server/agent/prompt-builder/core.js (buildMgaEnvFileSection)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// paths.js reads WORKSPACE_DIR at module-eval time. Set it BEFORE any import
// chain that touches it.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-builder-mga-test-'));
process.env.WORKSPACE_DIR = WS;

const { buildMgaEnvFileSection } = await import('../../server/agent/prompt-builder/core.js');

after(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

const ENV_PATH = path.join(WS, '.env');

test('no .env file → null', () => {
  fs.rmSync(ENV_PATH, { force: true });
  assert.equal(buildMgaEnvFileSection('integration'), null);
});

test('non-integration scope → null even when .env exists', () => {
  fs.writeFileSync(ENV_PATH, 'MGA_API_KEY=x\nMGA_BASE_URL=y\nMGA_ASSISTANT_ID=z\n');
  assert.equal(buildMgaEnvFileSection('backend'), null);
  assert.equal(buildMgaEnvFileSection('frontend'), null);
});

test('integration scope + .env → section lists actual MGA var names', () => {
  fs.writeFileSync(ENV_PATH, 'MGA_API_KEY=x\nMGA_BASE_URL=y\nMGA_ASSISTANT_ID=z\nMGA_ASSISTANT_ID_REVIEWER=w\n');
  const s = buildMgaEnvFileSection('integration');
  assert.match(s, /^=== MGA ENV FILE ===/);
  assert.match(s, /MGA_API_KEY, MGA_BASE_URL, MGA_ASSISTANT_ID, MGA_ASSISTANT_ID_REVIEWER/);
  assert.match(s, /env_file/);
  assert.match(s, /even if no sibling report mentions them/);
});

test('.env without MGA vars → null (no false trigger on app-only env files)', () => {
  fs.writeFileSync(ENV_PATH, 'POSTGRES_PASSWORD=x\n# comment\n');
  assert.equal(buildMgaEnvFileSection('integration'), null);
});
