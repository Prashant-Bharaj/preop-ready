import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { compareScopes, _internals } from '../../server/reconciler/compare.js';
import { judgeExtras } from '../../server/reconciler/judge-extras.js';
import { formatHardFailDiagnostic, formatSoftDeviationNote } from '../../server/reconciler/format.js';

// ── normalizeRoutePath ────────────────────────────────────────────────

test('normalizeRoutePath: collapses Express :id and FastAPI {id}', () => {
  assert.equal(_internals.normalizeRoutePath('/users/:id'), '/users/:p');
  assert.equal(_internals.normalizeRoutePath('/users/{id}'), '/users/:p');
  assert.equal(_internals.normalizeRoutePath('/users/:userId/posts/:postId'), '/users/:p/posts/:p');
  assert.equal(_internals.normalizeRoutePath('/users/:param'), '/users/:p');
});

test('normalizeRoutePath: trailing slash dropped', () => {
  assert.equal(_internals.normalizeRoutePath('/users/'), '/users');
  assert.equal(_internals.normalizeRoutePath('/'), '/');
});

// ── compareScopes: route mismatches ───────────────────────────────────

test('compareScopes: exact match yields no mismatches or extras (with no contract)', () => {
  const result = compareScopes({
    extractedBackend: [
      { file: 'b.js', line: 1, method: 'GET', path: '/users', requestFields: null },
      { file: 'b.js', line: 2, method: 'POST', path: '/users', requestFields: ['name', 'email'] },
    ],
    extractedFrontend: [
      { file: 'f.jsx', line: 1, method: 'GET', path: '/users', requestFields: null, raw: '/api/users' },
      { file: 'f.jsx', line: 2, method: 'POST', path: '/users', requestFields: ['name', 'email'], raw: '/api/users' },
    ],
    extractedDb: [],
    routerContracts: {},
  });
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.extras.length, 0);
});

test('compareScopes: layered - frontend calls a path the contract has but backend missed -> HARD on backend', () => {
  // Layered precedence: equalizer is for SHAPE drift on agreed endpoints.
  // For PRESENCE, the router contract is authoritative — if it said the
  // endpoint should exist and backend missed it, backend deviates and the
  // build is functionally incomplete.
  const result = compareScopes({
    extractedBackend: [],
    // Introspection ran and the live router table is empty → POST /requests is
    // authoritatively absent, so the gap is HARD. (Without runtime evidence it
    // would be SOFT — see the graceful-fallback test below.)
    extractedBackendRuntime: [],
    extractedFrontend: [
      { file: 'f.jsx', line: 5, method: 'POST', path: '/requests', requestFields: ['employeeId'], raw: '/api/requests' },
    ],
    extractedDb: [],
    routerContracts: {
      apiContract: { endpoints: [{ method: 'POST', path: '/requests' }] },
    },
  });
  // Find the route-presence mismatch (there'll also be a coverage-gap-backend
  // soft entry from the third-pass check).
  const presence = result.mismatches.find(m => m.kind === 'backend-missing-contract-endpoint');
  assert.ok(presence, 'should produce a backend-missing-contract-endpoint mismatch');
  assert.equal(presence.scope, 'backend');
  assert.equal(presence.severity, 'hard', 'frontend depends on it -> hard');
  assert.match(presence.contract, /api_contract endpoint POST \/requests/);
});

test('compareScopes: missing endpoint is SOFT when runtime introspection was unavailable (graceful fallback)', () => {
  // Same gap as above but no live router table (introspection unavailable) —
  // we must NOT hard-block, since the route could be registered via a pattern
  // static extraction misses (the regex false-positive class).
  const result = compareScopes({
    extractedBackend: [],
    extractedBackendRuntime: null,
    extractedFrontend: [
      { file: 'f.jsx', line: 5, method: 'POST', path: '/requests', requestFields: ['x'], raw: '/api/requests' },
    ],
    extractedDb: [],
    routerContracts: { apiContract: { endpoints: [{ method: 'POST', path: '/requests' }] } },
  });
  const presence = result.mismatches.find(m => m.kind === 'backend-missing-contract-endpoint');
  assert.ok(presence, 'still surfaces the gap');
  assert.equal(presence.severity, 'soft', 'no runtime authority -> soft, never blocks');
});

test('compareScopes: helper-mounted route in the live table suppresses the false missing-endpoint', () => {
  // The ex-mediumhard regression: regex extraction missed a route mounted via a
  // helper, but the live router table has it → no mismatch at all.
  const result = compareScopes({
    extractedBackend: [], // regex saw nothing
    extractedBackendRuntime: [{ method: 'GET', path: '/admin/export/qa-logs' }],
    extractedFrontend: [
      { file: 'ExportButton.tsx', line: 20, method: 'GET', path: '/admin/export/qa-logs', requestFields: null, raw: '/api/admin/export/qa-logs' },
    ],
    extractedDb: [],
    routerContracts: { apiContract: { endpoints: [{ method: 'GET', path: '/admin/export/qa-logs' }] } },
  });
  const presence = result.mismatches.find(m => m.kind === 'backend-missing-contract-endpoint');
  assert.equal(presence, undefined, 'route exists in the live table → no missing-endpoint mismatch');
});

test('compareScopes: backend-as-truth - frontend fetch with no backend route is always frontend-deviates', () => {
  // Same rule applies regardless of contract presence — what matters is what
  // backend actually exposed.
  const result = compareScopes({
    extractedBackend: [],
    extractedFrontend: [
      { file: 'f.jsx', line: 5, method: 'GET', path: '/wat', requestFields: null, raw: '/api/wat' },
    ],
    extractedDb: [],
    routerContracts: { apiContract: { endpoints: [] } },
  });
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].scope, 'frontend');
  assert.equal(result.extras.length, 0);
});

test('compareScopes: backend extra route (not used by frontend, not in contract) becomes extra', () => {
  const result = compareScopes({
    extractedBackend: [
      { file: 'b.js', line: 1, method: 'GET', path: '/internal/metrics', requestFields: null },
      { file: 'b.js', line: 2, method: 'GET', path: '/health', requestFields: null }, // health is skipped
    ],
    extractedFrontend: [],
    extractedDb: [],
    routerContracts: { apiContract: { endpoints: [] } },
  });
  // /health is skipped (convention).
  assert.equal(result.extras.length, 1);
  assert.equal(result.extras[0].path, '/internal/metrics');
});

test('compareScopes: backend-as-truth - body field mismatch always blames frontend', () => {
  // Even when the contract perfectly matches the frontend's shape and backend
  // is the one using non-contract names, the equalizer rule says: backend
  // wins. Frontend must align to backend.
  const result = compareScopes({
    extractedBackend: [
      { file: 'b.js', line: 1, method: 'POST', path: '/requests', requestFields: ['emp_id', 'start', 'end'] },
    ],
    extractedFrontend: [
      { file: 'f.jsx', line: 1, method: 'POST', path: '/requests', requestFields: ['employeeId', 'startDate', 'endDate'], raw: '/api/requests' },
    ],
    extractedDb: [],
    routerContracts: {
      apiContract: {
        endpoints: [{
          method: 'POST', path: '/requests',
          request: { employeeId: 'string', startDate: 'string', endDate: 'string' },
        }],
      },
    },
  });
  assert.equal(result.mismatches.length, 1);
  const m = result.mismatches[0];
  assert.equal(m.kind, 'body-shape-mismatch');
  assert.equal(m.scope, 'frontend', 'backend-as-truth: frontend deviates regardless of contract alignment');
  assert.match(m.contract, /backend reads/);
});

test('compareScopes: parameterized paths match across stacks', () => {
  const result = compareScopes({
    extractedBackend: [
      { file: 'b.js', line: 1, method: 'DELETE', path: '/documents/:id', requestFields: null },
    ],
    extractedFrontend: [
      { file: 'f.jsx', line: 1, method: 'DELETE', path: '/documents/:param', requestFields: null, raw: '/api/documents/${id}' },
    ],
    extractedDb: [],
    routerContracts: {},
  });
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.extras.length, 0);
});

// ── compareScopes: empty-scope guard ──────────────────────────────────

test('compareScopes: docker-compose service references missing Dockerfile -> hard mismatch', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-empty-'));
  fs.writeFileSync(path.join(ws, 'docker-compose.yml'), `services:
  database:
    build:
      context: ./database
      dockerfile: Dockerfile
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
`);
  // Stage backend + database Dockerfiles; LEAVE frontend missing.
  fs.mkdirSync(path.join(ws, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'backend', 'Dockerfile'), 'FROM scratch\n');
  fs.mkdirSync(path.join(ws, 'database'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'database', 'Dockerfile'), 'FROM scratch\n');
  // frontend dir does not exist.

  try {
    const result = compareScopes({
      workspaceDir: ws,
      extractedBackend: [],
      extractedFrontend: [],
      extractedDb: [],
      routerContracts: {},
    });
    const empties = result.mismatches.filter(m => m.kind === 'empty-scope');
    assert.equal(empties.length, 1, 'frontend should be the only empty-scope mismatch');
    assert.equal(empties[0].scope, 'frontend');
    assert.equal(empties[0].severity, 'hard');
    assert.match(empties[0].file, /frontend\/Dockerfile/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('compareScopes: no docker-compose.yml -> empty-scope guard skipped silently', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-empty-'));
  try {
    const result = compareScopes({
      workspaceDir: ws,
      extractedBackend: [],
      extractedFrontend: [],
      extractedDb: [],
      routerContracts: {},
    });
    assert.equal(result.mismatches.length, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── compareScopes: coverage gaps ──────────────────────────────────────

test('compareScopes: contract endpoint nobody implements -> extra (not mismatch)', () => {
  // Aspirational endpoints (router promised, neither side uses) stay as
  // extras — judge classifies legitimate/noise. Surfacing them as mismatches
  // would bury real cross-scope drift in noise that nobody is acting on.
  const result = compareScopes({
    extractedBackend: [],
    extractedFrontend: [],
    extractedDb: [],
    routerContracts: {
      apiContract: { endpoints: [{ method: 'POST', path: '/requests' }] },
    },
  });
  assert.equal(result.mismatches.length, 0, 'no mismatches when nobody uses the endpoint');
  assert.equal(result.extras.filter(e => e.kind === 'coverage-gap-backend').length, 1);
});

test('compareScopes: /health and /ping skipped from coverage check', () => {
  const result = compareScopes({
    extractedBackend: [],
    extractedFrontend: [],
    extractedDb: [],
    routerContracts: {
      apiContract: { endpoints: [
        { method: 'GET', path: '/health' },
        { method: 'GET', path: '/ping' },
        { method: 'GET', path: '/users' },
      ] },
    },
  });
  // /users is a real coverage gap (extra); /health and /ping are conventions, skipped.
  const gaps = result.extras.filter(e => e.kind === 'coverage-gap-backend');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].path, '/users');
});

// ── judgeExtras ───────────────────────────────────────────────────────

test('judgeExtras: returns judgment per extra using injected judge', async () => {
  const extras = [
    { kind: 'backend-extra-route', scope: 'backend', method: 'GET', path: '/internal/metrics' },
    { kind: 'frontend-extra-fetch', scope: 'frontend', method: 'GET', path: '/api/wat' },
  ];
  const judge = async (_prompt) => 'legitimate';
  const judged = await judgeExtras(extras, {}, { judge });
  assert.equal(judged.length, 2);
  for (const j of judged) assert.equal(j.judgment, 'legitimate');
});

test('judgeExtras: parses mismatch:<id> response (batched JSON contract)', async () => {
  // judgeExtras now uses BATCHED_PROMPT and expects a JSON array response
  // with one verdict object per item. The verdict's mismatch:<id> token
  // is preserved verbatim (no case-folding in the batched parser).
  const judge = async () => JSON.stringify([
    { verdict: 'mismatch:post /requests', target: 'post /requests', reasoning: 'renamed in subagent' },
  ]);
  const [j] = await judgeExtras(
    [{ kind: 'frontend-extra-fetch', scope: 'frontend', path: '/req', method: 'POST' }],
    {},
    { judge },
  );
  assert.equal(j.judgment, 'mismatch:post /requests');
});

test('judgeExtras: judge throw -> safe fallback (legitimate for routes, noise for coverage)', async () => {
  const judge = async () => { throw new Error('mga down'); };
  const [route, coverage] = await judgeExtras(
    [
      { kind: 'backend-extra-route', scope: 'backend', method: 'GET', path: '/x' },
      { kind: 'coverage-gap-backend', scope: 'backend', method: 'POST', path: '/y' },
    ],
    {},
    { judge },
  );
  assert.equal(route.judgment, 'legitimate');
  assert.equal(coverage.judgment, 'noise');
});

test('judgeExtras: no extras -> empty array fast', async () => {
  const judged = await judgeExtras([], {});
  assert.deepEqual(judged, []);
});

test('judgeExtras: calls run in parallel (not sequentially)', async () => {
  // Each judge call sleeps 80ms. Sequential = 5 * 80 = 400ms; parallel ~= 80ms.
  // Allow generous slack (200ms) so the test is not flaky on loaded CI.
  const PER_CALL_MS = 80;
  const judge = async () => {
    await new Promise(r => setTimeout(r, PER_CALL_MS));
    return 'legitimate';
  };
  const extras = Array.from({ length: 5 }, (_, i) => ({
    kind: 'backend-extra-route', scope: 'backend', method: 'GET', path: `/x${i}`,
  }));
  const start = Date.now();
  const judged = await judgeExtras(extras, {}, { judge });
  const elapsed = Date.now() - start;
  assert.equal(judged.length, 5);
  // Sequential floor would be 5 * 80 = 400ms; parallel must be well below that.
  assert.ok(elapsed < 200, `expected parallel (<200ms), got ${elapsed}ms`);
  // Output ordering preserved.
  for (const [i, j] of judged.entries()) assert.equal(j.path, `/x${i}`);
});

test('judgeExtras: signal is plumbed and AbortError -> kind-aware fallback', async () => {
  // Judge respects the AbortSignal: aborts immediately on next tick to mimic
  // the production timeout path (real path is the 30s setTimeout calling
  // controller.abort(); we don't sleep 30s here). Proves the signal reaches
  // the judge AND that an AbortError funnels through the same kind-aware
  // fallback as any other thrown error (legit for routes, noise for coverage).
  let signalSeen = false;
  const judge = (_prompt, { signal } = {}) => new Promise((_resolve, reject) => {
    signalSeen = signal instanceof AbortSignal;
    queueMicrotask(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const judged = await judgeExtras(
    [
      { kind: 'backend-extra-route', scope: 'backend', method: 'GET', path: '/r' },
      { kind: 'coverage-gap-backend', scope: 'backend', method: 'POST', path: '/g' },
    ],
    {},
    { judge },
  );
  assert.ok(signalSeen, 'judgeExtras must pass an AbortSignal to the judge');
  assert.equal(judged.length, 2);
  assert.equal(judged[0].judgment, 'legitimate');
  assert.equal(judged[1].judgment, 'noise');
});

// ── format ────────────────────────────────────────────────────────────

test('formatHardFailDiagnostic: header + scope grouping + contract/actual markers', () => {
  const out = formatHardFailDiagnostic([
    { kind: 'route-missing-in-backend', scope: 'backend', severity: 'hard', method: 'POST', path: '/requests', file: 'backend/src/r.js', line: 34, contract: 'api_contract has POST /requests', actual: 'no matching route' },
    { kind: 'db-column-missing', scope: 'database', severity: 'hard', file: 'database/init/01.sql', contract: 'users.role required', actual: 'column missing' },
  ]);
  assert.match(out, /^\[reconciler\] HARD MISMATCHES/);
  assert.match(out, /scope=backend \(1 mismatch\)/);
  assert.match(out, /scope=database \(1 mismatch\)/);
  assert.match(out, /POST \/requests at backend\/src\/r\.js:34/);
  assert.match(out, /contract: /);
  assert.match(out, /actual:   /);
});

test('formatSoftDeviationNote: distinct header but same body shape', () => {
  const out = formatSoftDeviationNote([
    { kind: 'body-shape-mismatch', scope: 'backend', severity: 'soft', method: 'POST', path: '/x', file: 'b.js', line: 1, contract: 'a, b', actual: 'a, c' },
  ]);
  assert.match(out, /^\[reconciler\] SOFT DEVIATIONS/);
  assert.match(out, /scope=backend/);
});

test('compareScopes: helper-mounted route (runtime-only) missing from contract becomes extra', () => {
  // mountCsvExport(app, '/admin/export', fn) is invisible to the regex
  // extractor but present in the live router table. Contract adoption needs
  // it flagged — observed live: GET /admin/export could never be re-adopted.
  const result = compareScopes({
    extractedBackend: [
      { file: 'b.js', line: 1, method: 'GET', path: '/whoami', requestFields: null },
    ],
    extractedFrontend: [
      { file: 'f.jsx', line: 1, method: 'GET', path: '/admin/export', requestFields: null, raw: '/api/admin/export' },
    ],
    extractedDb: [],
    extractedBackendRuntime: [
      { method: 'GET', path: '/whoami' },
      { method: 'GET', path: '/admin/export' },
    ],
    routerContracts: { apiContract: { endpoints: [{ method: 'GET', path: '/whoami' }] } },
  });
  const extra = result.extras.find((e) => e.path === '/admin/export');
  assert.ok(extra, 'runtime-only route missing from contract must be an extra');
  assert.equal(extra.kind, 'backend-extra-route');
  assert.equal(extra.calledByFrontend, true);
  assert.equal(extra.evidence, '(live router table):0');
  // and no false "frontend fetches a route backend lacks" mismatch
  assert.equal(result.mismatches.filter((m) => m.path === '/admin/export').length, 0);
});
