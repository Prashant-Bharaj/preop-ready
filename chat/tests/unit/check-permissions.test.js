/**
 * Coverage: flows 5, 8, 10 via the chain
 *   flow 10 → checkPermissions hard-denies illegal paths (primary surface)
 *   flow  8 → recovery dispatch writes routed through checkPermissions
 *   flow  5 → investigator path denies via the same gate cascade
 *
 * This file tests the checkWritePermission 6-gate cascade end-to-end.
 * Tests serve flows 5, 8, 10 by ensuring every gate denies what it
 * should AND lets through what it should AND the ordering is correct
 * (first deny wins, by gate order).
 *
 * If you change tests in this file: confirm the chain link is still valid.
 * If you remove a test: confirm no chain dependency disappears with it.
 *
 * Module under test: chat/server/agent/tools/util/check-permissions.js (250 LoC).
 * Cascade (per the docstring at the top of that file):
 *   (a) Workspace escape — defensive redundant check
 *   (b) Protected files  — .github/workflows/, .template-version,
 *                          .template-manifest.yml, .gitignore, .env*
 *   (c) forbidden_paths  — from .harness/contracts.json#file_structure[scope]
 *   (d) generated_dirs   — backend/src/generated/, etc.
 *   (e) Scope folder lockdown — `<scope>/` only, with vectordb/integration carve-outs
 *   (f) Default — allow
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestWorkspace } from '../util/test-workspace.js';
import { writeContractsEnvelope } from '../util/contracts-fixtures.js';
import {
  checkWritePermission,
  invalidateContractsCache,
} from '../../server/agent/tools/util/check-permissions.js';

// Convention note: check-permissions.js reads `envelope.data.fileStructure`
// (camelCase only — see line 148 of check-permissions.js). The on-disk
// envelope is written via `setOrchestrationContext` using the camelCase
// convention. The on-disk shape used by reconciler / file-structure-check
// reads BOTH camelCase and snake_case (see `getField` in those modules);
// check-permissions does NOT. We write camelCase here to match the production
// path. If a future PR adds tolerant snake_case reading to check-permissions,
// replicate the snake variant in a sibling test.
// The shared writeContractsEnvelope helper in tests/util/contracts-fixtures.js
// best-effort-invalidates the check-permissions cache so a workspace whose
// contracts have been read once picks up the new envelope.

// ── Defensive: missing ctx / missing workspaceDir ────────────────────────

test('checkWritePermission: missing ctx returns deny', () => {
  const r = checkWritePermission('/tmp/foo/bar.txt', null);
  assert.equal(r.verdict, 'deny');
  assert.match(r.reason, /workspaceDir is required/);
});

test('checkWritePermission: ctx without workspaceDir returns deny', () => {
  const r = checkWritePermission('/tmp/foo/bar.txt', {});
  assert.equal(r.verdict, 'deny');
});

// ── (a) Workspace escape — defensive redundant check ─────────────────────

test('Gate (a) escape: absolute path outside workspaceDir is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'escape-abs' });
  try {
    const r = checkWritePermission('/etc/passwd', { workspaceDir: ws.dir, scope: 'backend' });
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /escapes workspace/i);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (a) escape: sibling-of-workspace path (one dir up) is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'escape-sib' });
  try {
    const sibling = path.join(path.dirname(ws.dir), 'siblingfile.txt');
    const r = checkWritePermission(sibling, { workspaceDir: ws.dir, scope: 'backend' });
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /escapes workspace/i);
  } finally {
    await ws.cleanup();
  }
});

// ── (b) Protected files ──────────────────────────────────────────────────

test('Gate (b) protected: .github/workflows/* is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'gh-workflows' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.github/workflows/deploy.yml'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /protected platform file/i);
    assert.match(r.reason, /\.github\/workflows\//);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (b) protected: .template-version is denied (exact match)', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'tmpl-ver' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.template-version'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /protected platform file/i);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (b) protected: .template-manifest.yml is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'tmpl-manifest' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.template-manifest.yml'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (b) protected: .gitignore is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'gitignore' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.gitignore'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (b) protected: .env at workspace root is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'env-root' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.env'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /\.env\*/);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (b) protected: .env.local is denied (env-glob pattern)', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'env-local' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.env.local'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (b) protected: .env.example is denied (banned by the platform rules, gitignored)', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'env-example' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.env.example'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'deny', '.env.example must never be written — .env is the only env file');
    assert.match(r.reason, /\.env\*/);
  } finally {
    await ws.cleanup();
  }
});

// ── (c) forbidden_paths from contracts.json ──────────────────────────────

test('Gate (c) forbidden_paths: Python-backend scope denies backend/src/index.ts', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'fp-python' });
  try {
    await writeContractsEnvelope(ws.dir, {
      fileStructure: {
        backend: {
          language: 'python',
          forbidden_paths: ['backend/src/index.ts', 'backend/src/index.js'],
        },
      },
    });
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/index.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /forbidden_paths/);
    assert.match(r.reason, /contracts\.json/);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (c) forbidden_paths: Node-backend scope denies backend/main.py', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'fp-node' });
  try {
    await writeContractsEnvelope(ws.dir, {
      fileStructure: {
        backend: {
          language: 'node',
          forbidden_paths: ['backend/main.py', 'backend/requirements.txt'],
        },
      },
    });
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/main.py'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /forbidden_paths/);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (c) forbidden_paths: path not in list is allowed (when otherwise unblocked)', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'fp-pass' });
  try {
    await writeContractsEnvelope(ws.dir, {
      fileStructure: {
        backend: {
          language: 'node',
          forbidden_paths: ['backend/main.py'],
        },
      },
    });
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/index.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'allow', 'paths absent from forbidden_paths fall through to allow');
  } finally {
    await ws.cleanup();
  }
});

// ── (d) generated_dirs ───────────────────────────────────────────────────

test('Gate (d) generated_dirs: backend/src/generated/ is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'gen-be-node' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/generated/contracts.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /harness-managed generated/i);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (d) generated_dirs: backend/generated/ (python) is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'gen-be-py' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/generated/models.py'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /generated/i);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (d) generated_dirs: frontend/src/generated/ is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'gen-fe' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'frontend/src/generated/contracts.ts'),
      { workspaceDir: ws.dir, scope: 'frontend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /generated/i);
  } finally {
    await ws.cleanup();
  }
});

// ── (d2) Platform-locked pre-staged files ────────────────────────────────

test('Gate (d2) platform-locked: pre-staged mga-client.ts is denied when on disk', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'mga-locked' });
  try {
    const abs = path.join(ws.dir, 'backend/src/lib/mga-client.ts');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// pre-staged');
    const r = checkWritePermission(abs, { workspaceDir: ws.dir, scope: 'backend' });
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /pre-staged platform helper/i);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (d2) platform-locked: staged migration runner is denied, but backend/migrations/*.sql stays writable', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'migrate-locked' });
  try {
    const runner = path.join(ws.dir, 'backend/src/lib/migrate.ts');
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(runner, '// staged by pre-stage');
    const denied = checkWritePermission(runner, { workspaceDir: ws.dir, scope: 'backend' });
    assert.equal(denied.verdict, 'deny');
    assert.match(denied.reason, /pre-staged platform helper/i);
    // The backend scope owns migration files (iterate schema changes).
    const migration = checkWritePermission(
      path.join(ws.dir, 'backend/migrations/001_add_projects.sql'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(migration.verdict, 'allow');
    // The database scope is fenced out of backend/ — which is why it reports DDL instead of writing.
    const fenced = checkWritePermission(
      path.join(ws.dir, 'backend/migrations/001_add_projects.sql'),
      { workspaceDir: ws.dir, scope: 'database' },
    );
    assert.equal(fenced.verdict, 'deny');
    assert.match(fenced.reason, /may only write under 'database\/'/);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (d2) platform-locked: mga-client.ts is allowed when NOT pre-staged', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'mga-unlocked' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/lib/mga-client.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'allow');
  } finally {
    await ws.cleanup();
  }
});

// ── (e) Scope folder lockdown ────────────────────────────────────────────

test('Gate (e) scope-lock: backend writing to backend/ is allowed', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'scope-be-ok' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/routes.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'allow');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (e) scope-lock: backend writing to frontend/ is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'scope-be-fe' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'frontend/src/App.tsx'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /Scope 'backend'/);
    assert.match(r.reason, /attempted: 'frontend\/src\/App\.tsx'/);
  } finally {
    await ws.cleanup();
  }
});

test('Gate (e) scope-lock: frontend writing to backend/ is denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'scope-fe-be' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/index.ts'),
      { workspaceDir: ws.dir, scope: 'frontend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /Scope 'frontend'/);
  } finally {
    await ws.cleanup();
  }
});

// Cross-scope carve-outs

test('Gate (e) carve-out: vectordb scope MAY write backend/vectordb-connections.ts', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'carve-vdb' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/vectordb-connections.ts'),
      { workspaceDir: ws.dir, scope: 'vectordb' },
    );
    assert.equal(r.verdict, 'allow', 'vectordb scope carve-out for the connection helper');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (e) carve-out: integration scope MAY write docker-compose.yml at root', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'carve-compose' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'docker-compose.yml'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'allow');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (e) carve-out: integration scope MAY write frontend/nginx.local.conf', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'carve-nginx' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'frontend/nginx.local.conf'),
      { workspaceDir: ws.dir, scope: 'integration' },
    );
    assert.equal(r.verdict, 'allow');
  } finally {
    await ws.cleanup();
  }
});

test('Gate (e) carve-out: vectordb writing OTHER backend files is still denied', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'carve-vdb-other' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/routes.ts'),
      { workspaceDir: ws.dir, scope: 'vectordb' },
    );
    assert.equal(r.verdict, 'deny', 'carve-out is precise — only the agreed path is allowed');
  } finally {
    await ws.cleanup();
  }
});

// ── Scope-undefined behavior (gate (e) skipped) ──────────────────────────

test('checkWritePermission: no scope ctx → scope-lock gate skipped, write to anywhere allowed', async () => {
  // Orchestrator context (no scope set) — gate (e) noops, gates (a)-(d)
  // still fire. Used by the orchestrator agent when it writes coordination
  // files at workspace root.
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'noscope' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'docs/scratch.md'),
      { workspaceDir: ws.dir },
    );
    assert.equal(r.verdict, 'allow');
  } finally {
    await ws.cleanup();
  }
});

// ── Gate ordering: first deny wins ───────────────────────────────────────

test('Gate ordering: protected file beats scope-lock (earlier gate wins)', async () => {
  // backend scope writing .gitignore — both gates would deny, but gate (b)
  // protected-files fires first; the message must reflect the protected reason.
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'order-prot' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, '.gitignore'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /protected platform file/i,
      'gate (b) protected-files message wins over gate (e) scope-lock');
  } finally {
    await ws.cleanup();
  }
});

test('Gate ordering: forbidden_paths beats scope-lock when both apply', async () => {
  // backend scope, language=python, forbidden_paths includes backend/src/index.ts.
  // Scope-lock would NOT deny (the file is under backend/). But forbidden_paths
  // does — and the message should reflect that gate, not scope-lock.
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'order-fp' });
  try {
    await writeContractsEnvelope(ws.dir, {
      fileStructure: {
        backend: {
          language: 'python',
          forbidden_paths: ['backend/src/index.ts'],
        },
      },
    });
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/src/index.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /forbidden_paths/);
  } finally {
    await ws.cleanup();
  }
});

test('Gate ordering: generated_dirs beats scope-lock when both apply', async () => {
  // Frontend scope writing into frontend/src/generated/ — scope-lock would
  // allow (under frontend/) but generated_dirs denies. Message should
  // reflect generated_dirs.
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'order-gen' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'frontend/src/generated/foo.ts'),
      { workspaceDir: ws.dir, scope: 'frontend' },
    );
    assert.equal(r.verdict, 'deny');
    assert.match(r.reason, /generated/i);
  } finally {
    await ws.cleanup();
  }
});

// ── (f) Default — allow ──────────────────────────────────────────────────

test('Gate (f) default: scope writes to its own folder with clean path is allowed', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'default-allow' });
  try {
    const r = checkWritePermission(
      path.join(ws.dir, 'frontend/src/components/Button.tsx'),
      { workspaceDir: ws.dir, scope: 'frontend' },
    );
    assert.equal(r.verdict, 'allow');
    assert.equal(r.reason, null);
  } finally {
    await ws.cleanup();
  }
});

// ── Contracts cache: invalidation behavior ───────────────────────────────

test('Contracts cache: invalidateContractsCache re-reads after contracts.json change', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'cache' });
  try {
    // First: no forbidden_paths → write allowed.
    await writeContractsEnvelope(ws.dir, {
      fileStructure: { backend: { language: 'node', forbidden_paths: [] } },
    });
    const r1 = checkWritePermission(
      path.join(ws.dir, 'backend/foo.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r1.verdict, 'allow');

    // Now add the path to forbidden_paths and invalidate. Second call must
    // see the new list (deny).
    await writeContractsEnvelope(ws.dir, {
      fileStructure: { backend: { language: 'node', forbidden_paths: ['backend/foo.ts'] } },
    });
    // writeContractsEnvelope already calls invalidateContractsCache, but
    // call again to assert it's explicitly the invalidation that exposes
    // the new state.
    invalidateContractsCache(ws.dir);

    const r2 = checkWritePermission(
      path.join(ws.dir, 'backend/foo.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r2.verdict, 'deny', 'after invalidation the new forbidden_paths is honored');
  } finally {
    await ws.cleanup();
  }
});

test('Contracts cache: invalidate with no argument clears all entries', async () => {
  const wsA = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'cache-all-a' });
  const wsB = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'cache-all-b' });
  try {
    await writeContractsEnvelope(wsA.dir, {
      fileStructure: { backend: { language: 'node', forbidden_paths: ['backend/a.ts'] } },
    });
    await writeContractsEnvelope(wsB.dir, {
      fileStructure: { backend: { language: 'node', forbidden_paths: ['backend/b.ts'] } },
    });
    // Prime both caches.
    checkWritePermission(path.join(wsA.dir, 'backend/a.ts'), { workspaceDir: wsA.dir, scope: 'backend' });
    checkWritePermission(path.join(wsB.dir, 'backend/b.ts'), { workspaceDir: wsB.dir, scope: 'backend' });
    // Global invalidate (no arg).
    invalidateContractsCache();
    // After global invalidate, both should still read their (unchanged) on-disk
    // values and deny their respective forbidden paths.
    const rA = checkWritePermission(path.join(wsA.dir, 'backend/a.ts'), { workspaceDir: wsA.dir, scope: 'backend' });
    const rB = checkWritePermission(path.join(wsB.dir, 'backend/b.ts'), { workspaceDir: wsB.dir, scope: 'backend' });
    assert.equal(rA.verdict, 'deny');
    assert.equal(rB.verdict, 'deny');
  } finally {
    await wsA.cleanup();
    await wsB.cleanup();
  }
});

test('Contracts cache: missing contracts.json falls open (no forbidden_paths gate)', async () => {
  const ws = await createTestWorkspace({ scope: 'check-perm', scenarioName: 'no-contracts' });
  try {
    // No contracts.json written. forbidden_paths gate must not fire.
    const r = checkWritePermission(
      path.join(ws.dir, 'backend/foo.ts'),
      { workspaceDir: ws.dir, scope: 'backend' },
    );
    assert.equal(r.verdict, 'allow', 'pre-finalization (no contracts.json) falls through to allow');
  } finally {
    await ws.cleanup();
  }
});
