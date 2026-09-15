/**
 * Unit tests for the WORKSPACE ENV FILE spawn-message section.
 *
 * Module under test:
 *   chat/server/agent/prompt-builder/core.js (buildWorkspaceEnvFileSection)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// paths.js reads WORKSPACE_DIR at module-eval time. Set it BEFORE any import
// chain that touches it.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-builder-env-test-'));
process.env.WORKSPACE_DIR = WS;

const { buildWorkspaceEnvFileSection } = await import('../../server/agent/prompt-builder/core.js');

after(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

const ENV_PATH = path.join(WS, '.env');

test('no .env file → null', () => {
  fs.rmSync(ENV_PATH, { force: true });
  assert.equal(buildWorkspaceEnvFileSection('integration'), null);
});

test('non-integration scope → null even when .env exists', () => {
  fs.writeFileSync(ENV_PATH, 'MGA_API_KEY=x\nMGA_BASE_URL=y\nMGA_ASSISTANT_ID=z\n');
  assert.equal(buildWorkspaceEnvFileSection('backend'), null);
  assert.equal(buildWorkspaceEnvFileSection('frontend'), null);
});

test('integration scope + MGA vars → section lists actual names and the passthrough entries', () => {
  fs.writeFileSync(ENV_PATH, 'MGA_API_KEY=x\nMGA_BASE_URL=y\nMGA_ASSISTANT_ID=z\nMGA_ASSISTANT_ID_REVIEWER=w\n');
  const s = buildWorkspaceEnvFileSection('integration');
  assert.match(s, /^=== WORKSPACE ENV FILE ===/);
  assert.match(s, /MGA_API_KEY, MGA_BASE_URL, MGA_ASSISTANT_ID, MGA_ASSISTANT_ID_REVIEWER/);
  assert.match(s, /env_file/);
  assert.match(s, /MGA_ASSISTANT_ID_REVIEWER=\$\{MGA_ASSISTANT_ID_REVIEWER\}/);
  assert.match(s, /even if no sibling report mentions them/);
  assert.doesNotMatch(s, /POSTGRES_DB/);
});

test('DATABASE_* and VECTORDB_* keys → reference wiring for each db service, no MGA line', () => {
  fs.writeFileSync(ENV_PATH, '# header\nDATABASE_NAME=myapp\nDATABASE_USER=u\nDATABASE_PASSWORD=p\nVECTORDB_NAME=v\nVECTORDB_USER=vu\nVECTORDB_PASSWORD=vp\n');
  const s = buildWorkspaceEnvFileSection('integration');
  assert.match(s, /POSTGRES_PASSWORD: \$\{DATABASE_PASSWORD\}/);
  assert.match(s, /POSTGRES_PASSWORD: \$\{VECTORDB_PASSWORD\}/);
  assert.match(s, /DATABASE_HOST=database/);
  assert.match(s, /VECTORDB_HOST=vectordb/);
  assert.doesNotMatch(s, /MGA_/);
  assert.doesNotMatch(s, /\bp\b/, 'values never appear in the prompt');
});

test('.env with comments only → null', () => {
  fs.writeFileSync(ENV_PATH, '# nothing yet\n');
  assert.equal(buildWorkspaceEnvFileSection('integration'), null);
});
