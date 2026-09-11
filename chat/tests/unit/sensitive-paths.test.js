/**
 * Security regression: credential/secret paths must never be readable.
 *
 * The harness keeps its live MGA key at <WORKSPACE_DIR>/.chat/secrets.json and
 * app builds may write MGA_API_KEY into a workspace .env — both INSIDE the
 * workspace, so plain containment checks pass them. `isSensitiveWorkspacePath`
 * is the single deny predicate shared by the HTTP file viewer
 * (routes/uploads.js) and the agent read_file tool (agent/tools/file-tools.js).
 *
 * This pins: (1) the predicate's positive/negative table, and (2) that
 * read_file actually refuses a secret path before touching the filesystem,
 * while still serving ordinary files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isSensitiveWorkspacePath } from '../../server/core/sensitive-paths.js';
import { toolReadFile } from '../../server/agent/tools/file-tools.js';

// Hermetic temp workspace — deliberately NOT the shared createTestWorkspace
// helper, whose cleanup shells out to `docker ps` (adds seconds + a Docker
// dependency this pure security unit test has no need for).
async function makeWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sensitive-paths-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('isSensitiveWorkspacePath: denies credential/secret paths, allows normal files', () => {
  const denied = [
    '.chat/secrets.json',      // the live MGA key
    '.chat/transcripts/x.json',
    'backend/.env',
    '.env',
    '.env.production',
    'secrets.json',
    'config/secret.yaml',
    '.git/config',
    '.ssh/id_rsa',
    'a/b/id_ed25519.pub',
    'certs/server.pem',
    'app.key',
    '.npmrc',
    'sub/.netrc',
    '.kube/config',
    '.docker/config.json',
    '.chat/secrets.json.bak',  // backup copy of the secret
  ];
  const allowed = [
    'backend/src/index.ts',
    'frontend/app.tsx',
    'docs/README.md',
    'context/data.csv',
    'database/schema.sql',
    'environment.ts',          // not an env file — must not false-positive
    'secretsanta.json',        // 'secrets' + 'anta' (no dot) — must not match
  ];
  for (const p of denied) assert.equal(isSensitiveWorkspacePath(p), true, `should deny: ${p}`);
  for (const p of allowed) assert.equal(isSensitiveWorkspacePath(p), false, `should allow: ${p}`);
});

test('toolReadFile: refuses .chat/secrets.json (credential path)', async () => {
  await assert.rejects(
    () => toolReadFile({ path: '.chat/secrets.json' }, { workspaceDir: '/tmp/whatever' }),
    /not allowed \(credential\/secret path\)/,
    'read_file must reject the harness credential store',
  );
});

test('toolReadFile: refuses a workspace .env', async () => {
  await assert.rejects(
    () => toolReadFile({ path: 'backend/.env' }, { workspaceDir: '/tmp/whatever' }),
    /not allowed \(credential\/secret path\)/,
  );
});

test('toolReadFile: refuses an innocuously-named symlink pointing at a secret', async () => {
  const ws = await makeWorkspace();
  try {
    await mkdir(path.join(ws.dir, '.chat'), { recursive: true });
    await writeFile(path.join(ws.dir, '.chat', 'secrets.json'), '{"apiKey":"LIVE-KEY"}');
    // A symlink whose NAME is innocuous but whose target is the secret store.
    await symlink(path.join(ws.dir, '.chat', 'secrets.json'), path.join(ws.dir, 'notes.txt'));
    await assert.rejects(
      () => toolReadFile({ path: 'notes.txt' }, { workspaceDir: ws.dir }),
      /not allowed \(credential\/secret path\)/,
      'a symlink to the secret must be refused after real-path resolution',
    );
  } finally {
    await ws.cleanup();
  }
});

test('toolReadFile: still reads an ordinary workspace file', async () => {
  const ws = await makeWorkspace();
  try {
    const rel = 'backend/app.ts';
    await mkdir(path.join(ws.dir, 'backend'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend', 'app.ts'), 'export const x = 1;\n');
    const out = await toolReadFile({ path: rel }, { workspaceDir: ws.dir });
    assert.match(out, /export const x = 1;/, 'normal files must remain readable');
  } finally {
    await ws.cleanup();
  }
});
