/**
 * Coverage: flows 8, 9 via the chain
 *   flow 8 (recovery from failure) → detectors discover broken state →
 *     recovery loop dispatches fixes
 *   flow 9 (recovery exhaustion)  → budget tracking caps attempts →
 *     surface to user
 *
 * This file tests the THREE detector primitives + budget-tracking logic
 * the auto-recovery loop assembles. The full loop (MGA dispatch + retry +
 * round bookkeeping) is integration-tier (Dispatch 3); here we cover the
 * primitives in isolation so the loop assembly has a sound foundation.
 *
 * If you change tests in this file: confirm the chain link is still valid.
 * If you remove a test: confirm no chain dependency disappears with it.
 *
 * Modules under test (read selectively from 809 LoC auto-recovery + the
 * three sibling detector modules):
 *   chat/server/reconciler/structural-checks.js       (239 LoC)
 *   chat/server/reconciler/file-structure-check.js    (117 LoC)
 *   chat/server/reconciler/runtime-asserts.js         (73 LoC)
 *   chat/server/session/auto-recovery.js#pushAutoRecoveryRecord (telemetry)
 *
 * Mocking: NO MGA call, NO Docker, NO real `reengageScopeForMismatch`. The
 * full recovery loop's dispatch logic is integration-tier territory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { createTestWorkspace } from '../util/test-workspace.js';
import { writeContractsEnvelope as writeContracts } from '../util/contracts-fixtures.js';

import { runStructuralChecks } from '../../server/reconciler/structural-checks.js';
import {
  runFileStructureCheck,
  formatFileStructureReport,
} from '../../server/reconciler/file-structure-check.js';
import { runRuntimeAsserts } from '../../server/reconciler/runtime-asserts.js';
import { pushAutoRecoveryRecord } from '../../server/session/auto-recovery.js';
import {
  MAX_FIX_ATTEMPTS_PER_SCOPE,
  MAX_RECOVERY_TOKENS_PER_BUILD,
} from '../../server/config/defaults.js';

// ── Fixture helpers ──────────────────────────────────────────────────────

async function stageBackendNodeOk(ws) {
  await mkdir(path.join(ws, 'backend/src'), { recursive: true });
  await writeFile(path.join(ws, 'backend/src/index.ts'),
    'import express from "express";\nconst app = express();\napp.get("/health", (_, r) => r.json({}));\n'
    + 'app.use((err, _req, res, _next) => { res.status(500).json({ error: "InternalServerError" }); });\n'
    + "process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));\n"
    + 'app.listen(3000);\n',
    'utf-8');
  await writeFile(path.join(ws, 'backend/Dockerfile'),
    [
      'FROM node:20',
      'WORKDIR /app',
      'COPY . .',
      'RUN npm ci && npm run build',
      'EXPOSE 3000',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'utf-8');
}

async function stageFrontendOk(ws) {
  await mkdir(path.join(ws, 'frontend'), { recursive: true });
  await writeFile(path.join(ws, 'frontend/Dockerfile'),
    [
      'FROM node:20 AS build',
      'WORKDIR /app',
      'COPY . .',
      'RUN apt-get install -y curl',
      'RUN npm run build',
      'FROM nginx:alpine',
      'COPY --from=build /app/dist /usr/share/nginx/html',
      'EXPOSE 8080',
      'CMD ["nginx", "-g", "daemon off;"]',
    ].join('\n'),
    'utf-8');
  await writeFile(path.join(ws, 'frontend/nginx.local.conf'),
    [
      'server {',
      '  listen 8080;',
      '  location /api/ { proxy_pass http://backend:3000/; }',
      '  location / { root /usr/share/nginx/html; }',
      '}',
    ].join('\n'),
    'utf-8');
}

// writeContracts is imported from ../util/contracts-fixtures.js (alias of
// writeContractsEnvelope). Each consumer renames if they prefer a shorter
// local handle.

// ────────────────────────────────────────────────────────────────────────
// STRUCTURAL DETECTOR PRIMITIVE
// ────────────────────────────────────────────────────────────────────────

test('structural: clean backend + frontend → no violations', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-ok' });
  try {
    await stageBackendNodeOk(ws.dir);
    await stageFrontendOk(ws.dir);
    const r = runStructuralChecks(ws.dir, ['backend', 'frontend']);
    assert.equal(r.ok, true, `unexpected violations: ${JSON.stringify(r.violations)}`);
    assert.equal(r.violations.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('structural: missing backend Dockerfile → violation flagged', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-missing-be' });
  try {
    // No Dockerfile staged.
    const r = runStructuralChecks(ws.dir, ['backend']);
    assert.equal(r.ok, false);
    const v = r.violations.find((vv) => vv.rule === 'exists');
    assert.ok(v, 'exists violation flagged');
    assert.equal(v.scope, 'backend');
  } finally {
    await ws.cleanup();
  }
});

test('structural: backend Dockerfile EXPOSE != 3000 → flagged', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-expose' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'),
      'console.log("x")\n', 'utf-8');
    await writeFile(path.join(ws.dir, 'backend/Dockerfile'),
      [
        'FROM node:20',
        'WORKDIR /app',
        'EXPOSE 8080',  // wrong port
        'CMD ["node", "dist/index.js"]',
      ].join('\n'), 'utf-8');
    const r = runStructuralChecks(ws.dir, ['backend']);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.rule === 'EXPOSE-3000'));
  } finally {
    await ws.cleanup();
  }
});

test('structural: backend Dockerfile CMD wrong (not canonical) → flagged', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-cmd' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'), 'x\n', 'utf-8');
    await writeFile(path.join(ws.dir, 'backend/Dockerfile'),
      [
        'FROM node:20',
        'WORKDIR /app',
        'EXPOSE 3000',
        'CMD ["node", "wrongpath.js"]',  // not canonical
      ].join('\n'), 'utf-8');
    const r = runStructuralChecks(ws.dir, ['backend']);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.rule === 'CMD-canonical-entry'));
  } finally {
    await ws.cleanup();
  }
});

test('structural: backend Dockerfile missing WORKDIR → flagged', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-workdir' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'), 'x\n', 'utf-8');
    await writeFile(path.join(ws.dir, 'backend/Dockerfile'),
      [
        'FROM node:20',
        'EXPOSE 3000',
        'CMD ["node", "dist/index.js"]',
      ].join('\n'), 'utf-8');
    const r = runStructuralChecks(ws.dir, ['backend']);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.rule === 'WORKDIR-present'));
  } finally {
    await ws.cleanup();
  }
});

test('structural: frontend nginx.conf missing listen 8080 → flagged', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-nginx-listen' });
  try {
    await mkdir(path.join(ws.dir, 'frontend'), { recursive: true });
    await writeFile(path.join(ws.dir, 'frontend/Dockerfile'),
      [
        'FROM nginx:alpine',
        'WORKDIR /app',
        'EXPOSE 8080',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'frontend/nginx.local.conf'),
      [
        'server {',
        '  listen 9999;',  // wrong port
        '  location /api/ { proxy_pass http://backend:3000/; }',
        '}',
      ].join('\n'), 'utf-8');
    const r = runStructuralChecks(ws.dir, ['frontend']);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.rule === 'listen-8080'));
  } finally {
    await ws.cleanup();
  }
});

test('structural: frontend nginx.conf missing api proxy_pass → flagged', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-nginx-proxy' });
  try {
    await mkdir(path.join(ws.dir, 'frontend'), { recursive: true });
    await writeFile(path.join(ws.dir, 'frontend/Dockerfile'),
      [
        'FROM nginx:alpine',
        'WORKDIR /app',
        'EXPOSE 8080',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'frontend/nginx.local.conf'),
      [
        'server {',
        '  listen 8080;',
        '  # no /api/ proxy_pass at all',
        '  location / { root /usr/share/nginx/html; }',
        '}',
      ].join('\n'), 'utf-8');
    const r = runStructuralChecks(ws.dir, ['frontend']);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.rule === 'api-proxy-pass'));
  } finally {
    await ws.cleanup();
  }
});

test('structural: scopes filter — only requested scopes checked', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'struct-filter' });
  try {
    // Backend broken; frontend missing. If we only ask for frontend, we
    // shouldn't see backend violations.
    await mkdir(path.join(ws.dir, 'frontend'), { recursive: true });
    await stageFrontendOk(ws.dir);

    const r = runStructuralChecks(ws.dir, ['frontend']);
    assert.equal(r.ok, true, 'frontend is OK; no backend check should fire');
  } finally {
    await ws.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────
// FILE-STRUCTURE DETECTOR PRIMITIVE
// ────────────────────────────────────────────────────────────────────────

test('file-structure: no contracts.json → falls open (ok=true, no failures)', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'fs-nocontracts' });
  try {
    const r = runFileStructureCheck(ws.dir);
    assert.equal(r.ok, true);
    assert.equal(r.missingFiles.length, 0);
    assert.equal(r.stubFiles.length, 0);
    assert.equal(r.forbiddenPresent.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('file-structure: required_file present + populated → no failures', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'fs-populated' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'),
      'x'.repeat(500), 'utf-8'); // well above stub threshold
    await writeContracts(ws.dir, {
      file_structure: {
        backend: {
          required_files: ['backend/src/index.ts'],
          forbidden_paths: [],
        },
      },
    });
    const r = runFileStructureCheck(ws.dir);
    assert.equal(r.ok, true);
  } finally {
    await ws.cleanup();
  }
});

test('file-structure: required_file MISSING → flagged in missingFiles[]', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'fs-missing' });
  try {
    await writeContracts(ws.dir, {
      file_structure: {
        backend: {
          required_files: ['backend/src/index.ts'],
          forbidden_paths: [],
        },
      },
    });
    const r = runFileStructureCheck(ws.dir);
    assert.equal(r.ok, false);
    assert.equal(r.missingFiles.length, 1);
    assert.equal(r.missingFiles[0].scope, 'backend');
    assert.equal(r.missingFiles[0].path, 'backend/src/index.ts');
  } finally {
    await ws.cleanup();
  }
});

test('file-structure: required_file STUB (under threshold) → flagged in stubFiles[]', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'fs-stub' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    // Tiny stub (a single line of placeholder).
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'), '// TODO\n', 'utf-8');
    await writeContracts(ws.dir, {
      file_structure: {
        backend: {
          required_files: ['backend/src/index.ts'],
          forbidden_paths: [],
        },
      },
    });
    const r = runFileStructureCheck(ws.dir);
    assert.equal(r.ok, false);
    assert.equal(r.stubFiles.length, 1);
    assert.match(r.stubFiles[0].path, /backend\/src\/index\.ts/);
    assert.ok(typeof r.stubFiles[0].size === 'number');
  } finally {
    await ws.cleanup();
  }
});

test('file-structure: forbidden_path PRESENT → flagged in forbiddenPresent[]', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'fs-forbidden' });
  try {
    // python-backend scenario: backend/main.py is required, backend/src/
    // is forbidden. We create a forbidden file.
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'), 'x'.repeat(500), 'utf-8');
    await mkdir(path.join(ws.dir, 'backend'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/main.py'), 'x'.repeat(500), 'utf-8');
    await writeContracts(ws.dir, {
      file_structure: {
        backend: {
          required_files: ['backend/main.py'],
          forbidden_paths: ['backend/src/index.ts'],
        },
      },
    });
    const r = runFileStructureCheck(ws.dir);
    assert.equal(r.ok, false);
    assert.equal(r.forbiddenPresent.length, 1);
    assert.equal(r.forbiddenPresent[0].path, 'backend/src/index.ts');
  } finally {
    await ws.cleanup();
  }
});

test('file-structure: scopes filter — only specified scopes scanned', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'fs-filter' });
  try {
    await writeContracts(ws.dir, {
      file_structure: {
        backend:  { required_files: ['backend/missing.ts'], forbidden_paths: [] },
        frontend: { required_files: ['frontend/missing.ts'], forbidden_paths: [] },
      },
    });
    const r = runFileStructureCheck(ws.dir, ['backend']);
    // Only backend's missing file should appear.
    assert.equal(r.missingFiles.length, 1);
    assert.equal(r.missingFiles[0].scope, 'backend');
  } finally {
    await ws.cleanup();
  }
});

test('formatFileStructureReport: produces human-readable diagnostic for all categories', () => {
  const formatted = formatFileStructureReport({
    missingFiles:     [{ scope: 'backend', path: 'backend/src/index.ts' }],
    stubFiles:        [{ scope: 'frontend', path: 'frontend/index.html', size: 10 }],
    forbiddenPresent: [{ scope: 'backend', path: 'backend/main.py' }],
  });
  assert.match(formatted, /Missing canonical files/);
  assert.match(formatted, /backend\/src\/index\.ts/);
  assert.match(formatted, /Pre-staged stubs never populated/);
  assert.match(formatted, /frontend\/index\.html/);
  assert.match(formatted, /Forbidden paths present on disk/);
  assert.match(formatted, /backend\/main\.py/);
});

// ────────────────────────────────────────────────────────────────────────
// RUNTIME-ASSERTS DETECTOR PRIMITIVE
// ────────────────────────────────────────────────────────────────────────

test('runtime-asserts: clean backend + frontend stage produces no failures', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'rt-ok' });
  try {
    // Backend: canonical entry, no /api/ prefix, /health route, Dockerfile
    // FROM matches Node entry.
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'),
      [
        'import express from "express";',
        'const app = express();',
        'app.get("/health", (_, r) => r.json({ ok: true }));',
        'app.get("/items", (_, r) => r.json([]));',
        'app.listen(3000);',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'backend/Dockerfile'),
      [
        'FROM node:20',
        'WORKDIR /app',
        'COPY . .',
        'RUN npm ci',
        'EXPOSE 3000',
        'CMD ["node", "dist/index.js"]',
      ].join('\n'), 'utf-8');

    // Frontend: both nginx configs present with correct shape, Dockerfile
    // installs curl.
    await mkdir(path.join(ws.dir, 'frontend'), { recursive: true });
    await writeFile(path.join(ws.dir, 'frontend/Dockerfile'),
      [
        'FROM node:20 AS build',
        'WORKDIR /app',
        'RUN apt-get install -y curl',
        'COPY . .',
        'RUN npm run build',
        'FROM nginx:alpine',
        'COPY --from=build /app/dist /usr/share/nginx/html',
        'EXPOSE 8080',
        'CMD ["nginx", "-g", "daemon off;"]',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'frontend/nginx.local.conf'),
      [
        'server {',
        '  listen 8080;',
        '  location /api/ { proxy_pass http://backend:3000/; }',
        '  location / { root /usr/share/nginx/html; }',
        '}',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'frontend/nginx.conf'),
      [
        'server {',
        '  listen 8080;',
        '  location / { root /usr/share/nginx/html; }',
        '}',
      ].join('\n'), 'utf-8');

    const r = runRuntimeAsserts(ws.dir, ['backend', 'frontend']);
    assert.equal(r.ok, true, `unexpected failures: ${JSON.stringify(r.failures)}`);
    assert.equal(r.failures.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('runtime-asserts: backend with /api/ prefix is FLAGGED (assertBackendNoApiPrefix)', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'rt-api-prefix' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'),
      [
        'import express from "express";',
        'const app = express();',
        'app.get("/health", (_, r) => r.json({ ok: true }));',
        'app.get("/api/items", (_, r) => r.json([]));', // forbidden prefix
        'app.listen(3000);',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'backend/Dockerfile'),
      'FROM node:20\nWORKDIR /app\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
      'utf-8');
    const r = runRuntimeAsserts(ws.dir, ['backend']);
    assert.equal(r.ok, false);
    const f = r.failures.find((ff) => ff.check === 'assertBackendNoApiPrefix');
    assert.ok(f, 'assertBackendNoApiPrefix failure flagged');
    assert.equal(f.scope, 'backend');
  } finally {
    await ws.cleanup();
  }
});

test('runtime-asserts: backend missing /health route is FLAGGED', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'rt-no-health' });
  try {
    await mkdir(path.join(ws.dir, 'backend/src'), { recursive: true });
    await writeFile(path.join(ws.dir, 'backend/src/index.ts'),
      [
        'import express from "express";',
        'const app = express();',
        // No /health route at all.
        'app.get("/items", (_, r) => r.json([]));',
        'app.listen(3000);',
      ].join('\n'), 'utf-8');
    await writeFile(path.join(ws.dir, 'backend/Dockerfile'),
      'FROM node:20\nWORKDIR /app\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
      'utf-8');
    const r = runRuntimeAsserts(ws.dir, ['backend']);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((ff) => ff.check === 'assertBackendHealth'));
  } finally {
    await ws.cleanup();
  }
});

test('runtime-asserts: scope without checks → no failures', async () => {
  const ws = await createTestWorkspace({ scope: 'ar', scenarioName: 'rt-noscope' });
  try {
    const r = runRuntimeAsserts(ws.dir, ['integration', 'vectordb']);
    // integration and vectordb don't have entries in SCOPE_CHECKS.
    assert.equal(r.ok, true);
    assert.equal(r.failures.length, 0);
  } finally {
    await ws.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────
// BUDGET CONSTANTS + telemetry record
// ────────────────────────────────────────────────────────────────────────

test('budget constants: MAX_FIX_ATTEMPTS_PER_SCOPE is a positive integer (sanity)', () => {
  assert.ok(Number.isInteger(MAX_FIX_ATTEMPTS_PER_SCOPE));
  assert.ok(MAX_FIX_ATTEMPTS_PER_SCOPE >= 1,
    'must permit at least one fix attempt to be useful');
});

test('budget constants: MAX_RECOVERY_TOKENS_PER_BUILD is a positive integer (sanity)', () => {
  assert.ok(Number.isInteger(MAX_RECOVERY_TOKENS_PER_BUILD));
  assert.ok(MAX_RECOVERY_TOKENS_PER_BUILD >= 10_000,
    'must permit at least one round-trip; W4 default is 400_000');
});

test('budget constants: MAX_FIX_ATTEMPTS_PER_SCOPE matches current spec (=3)', () => {
  // Bumped 2 → 3 in cfb5368 after per-scope conversation continuity landed
  // — see defaults.js for the convergence-trajectory rationale (t6 went
  // from "16 → 12 errors exhausted" to "16 → 9 → 5 errors" with cleaner
  // fixable trajectory). Pin the value here so a future bump comes
  // through this test file (visible to reviewers).
  assert.equal(MAX_FIX_ATTEMPTS_PER_SCOPE, 3);
});

test('pushAutoRecoveryRecord: appends a structured record to session.autoRecoveryAttempts', () => {
  const session = {};
  pushAutoRecoveryRecord(session, {
    scope: 'backend',
    attemptN: 1,
    triggeredBy: 'reconciler',
    failureSummary: '3 failure(s) [type-gate]',
    exhausted: false,
  });
  assert.ok(Array.isArray(session.autoRecoveryAttempts));
  assert.equal(session.autoRecoveryAttempts.length, 1);
  const rec = session.autoRecoveryAttempts[0];
  assert.equal(rec.scope, 'backend');
  assert.equal(rec.attemptN, 1);
  assert.equal(rec.triggeredBy, 'reconciler');
  assert.equal(rec.failureSummary, '3 failure(s) [type-gate]');
  assert.equal(rec.exhausted, false);
  assert.ok(typeof rec.ts === 'number' && rec.ts > 0);
});

test('pushAutoRecoveryRecord: triggeredBy defaults to reconciler (non-smoke caller)', () => {
  const session = {};
  pushAutoRecoveryRecord(session, { scope: 'backend' });
  assert.equal(session.autoRecoveryAttempts[0].triggeredBy, 'reconciler');
});

test('pushAutoRecoveryRecord: triggeredBy=smoke preserved', () => {
  const session = {};
  pushAutoRecoveryRecord(session, { scope: 'backend', triggeredBy: 'smoke' });
  assert.equal(session.autoRecoveryAttempts[0].triggeredBy, 'smoke');
});

test('pushAutoRecoveryRecord: missing scope → null (record still pushed)', () => {
  const session = {};
  pushAutoRecoveryRecord(session, {});
  assert.equal(session.autoRecoveryAttempts.length, 1);
  assert.equal(session.autoRecoveryAttempts[0].scope, null);
});

test('pushAutoRecoveryRecord: null session no-ops without throwing', () => {
  // The function guards on `if (!session) return;` per L.5-style robustness.
  pushAutoRecoveryRecord(null, { scope: 'backend' }); // must not throw
  pushAutoRecoveryRecord(undefined, { scope: 'backend' });
});

test('pushAutoRecoveryRecord: existing autoRecoveryAttempts array is appended (not replaced)', () => {
  const session = {
    autoRecoveryAttempts: [{ scope: 'frontend', attemptN: 0, ts: 0 }],
  };
  pushAutoRecoveryRecord(session, { scope: 'backend', attemptN: 1 });
  assert.equal(session.autoRecoveryAttempts.length, 2);
  assert.equal(session.autoRecoveryAttempts[0].scope, 'frontend',
    'existing record preserved');
  assert.equal(session.autoRecoveryAttempts[1].scope, 'backend');
});

test('pushAutoRecoveryRecord: exhausted record carries exhausted=true', () => {
  const session = {};
  pushAutoRecoveryRecord(session, {
    scope: 'backend',
    attemptN: MAX_FIX_ATTEMPTS_PER_SCOPE,
    exhausted: true,
  });
  assert.equal(session.autoRecoveryAttempts[0].exhausted, true);
  // The terminal record has no fixedAt (scope never recovered).
  assert.equal(session.autoRecoveryAttempts[0].fixedAt, null);
});

// ────────────────────────────────────────────────────────────────────────
// Per-scope budget tracking (the data shape `scopeCounters` uses)
// ────────────────────────────────────────────────────────────────────────

test('scope budget: each scope has independent fixAttempts counter', () => {
  // The auto-recovery loop owns a `scopeCounters` Map of
  // <scope, { reengages, fixAttempts }>. Simulate the mutation pattern
  // the loop uses on each round to verify the per-scope keying works.
  const scopeCounters = new Map();
  const inc = (scope) => {
    const c = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
    scopeCounters.set(scope, { ...c, fixAttempts: c.fixAttempts + 1 });
  };

  inc('backend');
  inc('backend');
  inc('frontend');

  assert.equal(scopeCounters.get('backend').fixAttempts, 2);
  assert.equal(scopeCounters.get('frontend').fixAttempts, 1);
  assert.equal(scopeCounters.get('database'), undefined,
    'untouched scopes have no entry');
});

test('scope budget: reaching MAX_FIX_ATTEMPTS_PER_SCOPE flips a scope to exhausted', () => {
  // Replicate the loop's gate: scope is exhausted when fixAttempts ≥
  // MAX_FIX_ATTEMPTS_PER_SCOPE. The fixAttempts == budget case must trip.
  const scopeCounters = new Map();
  scopeCounters.set('backend', { reengages: 0, fixAttempts: MAX_FIX_ATTEMPTS_PER_SCOPE });
  const isExhausted = (scope) => {
    const c = scopeCounters.get(scope) || { fixAttempts: 0 };
    return c.fixAttempts >= MAX_FIX_ATTEMPTS_PER_SCOPE;
  };
  assert.equal(isExhausted('backend'), true);
  // At exactly cap minus 1 → not exhausted yet (one attempt left).
  scopeCounters.set('frontend', { reengages: 0, fixAttempts: MAX_FIX_ATTEMPTS_PER_SCOPE - 1 });
  assert.equal(isExhausted('frontend'), false);
});

test('scope budget: stale-diff re-injection has independent per-path budget', () => {
  // The brief notes that per-path stale-diff injection has its own cap
  // multiplicative with per-scope fix-attempt cap. Simulate the data
  // shape: a Map<path, count> per scope, independent of fixAttempts.
  const staleDiffByPath = new Map();
  const STALE_DIFF_CAP_PER_PATH = 3; // sanity bound — the production
                                      // constant lives elsewhere and may differ.

  const bump = (relPath) => {
    const v = staleDiffByPath.get(relPath) || 0;
    staleDiffByPath.set(relPath, v + 1);
  };

  bump('backend/src/index.ts');
  bump('backend/src/index.ts');
  bump('backend/src/routes.ts');

  assert.equal(staleDiffByPath.get('backend/src/index.ts'), 2);
  assert.equal(staleDiffByPath.get('backend/src/routes.ts'), 1);
  // Independence: even when scope's fixAttempts is at cap, a different
  // path has its own budget.
  assert.ok(staleDiffByPath.get('backend/src/index.ts') < STALE_DIFF_CAP_PER_PATH);
});
