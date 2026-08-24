/**
 * Unit tests for the post-compose endpoint probe.
 *
 * Module under test:
 *   chat/server/reconciler/endpoint-probe.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  buildProbePlan,
  bodyContainsId,
  deriveSamplePayload,
  classifyProbeOutcome,
  probeApiEndpoints,
  checkComposeHealthAfterProbe,
  formatProbeFailures,
} from '../../server/reconciler/endpoint-probe.js';

// ── buildProbePlan ────────────────────────────────────────────────────────

test('plan orders POST → GET (collection before :id) → PUT → DELETE', () => {
  const plan = buildProbePlan({
    endpoints: [
      { method: 'DELETE', path: '/tasks/:id' },
      { method: 'GET', path: '/tasks/:id' },
      { method: 'GET', path: '/tasks' },
      { method: 'PUT', path: '/tasks/:id' },
      { method: 'POST', path: '/tasks' },
    ],
  });
  assert.deepEqual(plan.map((s) => `${s.method} ${s.path}`), [
    'POST /tasks',
    'GET /tasks',
    'GET /tasks/:id',
    'PUT /tasks/:id',
    'DELETE /tasks/:id',
  ]);
});

test('plan tolerates empty/missing contracts and unknown methods', () => {
  assert.deepEqual(buildProbePlan(null), []);
  assert.deepEqual(buildProbePlan({ endpoints: [{ method: 'OPTIONS', path: '/x' }] }), []);
});

// ── deriveSamplePayload ───────────────────────────────────────────────────

test('payload derivation across field shapes; optionals omitted', () => {
  const body = deriveSamplePayload({
    title: 'string',
    email: 'string required',
    note: 'string optional',
    count: { type: 'number' },
    active: 'boolean',
    tags: 'array',
    meta: { type: 'object', optional: true },
    due_date: 'string',
    owner_id: 'string',          // bare FK — omitted (guessed id fails FK validation)
    plant_area_id: 'number required', // explicit required FK — kept
  });
  assert.deepEqual(body, {
    title: 'probe-sample',
    email: 'probe@example.com',
    count: 1,
    active: true,
    tags: [],
    due_date: '2026-01-01',
    plant_area_id: 1,
  });
});

// ── classifyProbeOutcome ──────────────────────────────────────────────────

test('pass/fail matrix', () => {
  for (const status of [200, 201, 204, 301, 400, 401, 403, 404, 422]) {
    assert.equal(classifyProbeOutcome({ status }), 'pass', `status ${status}`);
  }
  for (const status of [500, 502, 503]) {
    assert.equal(classifyProbeOutcome({ status }), 'fail', `status ${status}`);
  }
  assert.equal(classifyProbeOutcome({ error: 'ECONNREFUSED' }), 'fail');
});

// ── probeApiEndpoints against a scripted local server ─────────────────────

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('end-to-end: id capture, 5xx detection, 404-passes', async () => {
  const seen = [];
  const { server, url } = await startServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/api/tasks') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42, title: 'probe-sample' }));
    } else if (req.url === '/api/tasks/42') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } else if (req.url === '/api/broken') {
      res.writeHead(502);
      res.end('Bad Gateway');
    } else if (req.url === '/api/missing/1') {
      res.writeHead(404);
      res.end('{}');
    } else {
      res.writeHead(200);
      res.end('{}');
    }
  });
  try {
    const result = await probeApiEndpoints({
      baseUrl: url,
      apiContract: {
        endpoints: [
          { method: 'POST', path: '/tasks', request: { title: 'string' } },
          { method: 'GET', path: '/tasks/:id' },
          { method: 'GET', path: '/broken' },
          { method: 'GET', path: '/missing/:id' },
        ],
      },
      timeouts: { requestMs: 2000, aiRequestMs: 2000, totalMs: 20000 },
    });
    assert.equal(result.probed, 4);
    assert.equal(result.passed, 3);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, '/broken');
    assert.equal(result.failed[0].status, 502);
    // POST captured id=42 and the parameterized GET used it.
    assert.ok(seen.includes('GET /api/tasks/42'), `saw: ${seen.join(', ')}`);
  } finally {
    server.close();
  }
});

test('connection refused fails after one retry; filter re-probes a subset', async () => {
  const result = await probeApiEndpoints({
    baseUrl: 'http://127.0.0.1:1', // nothing listens here
    apiContract: { endpoints: [{ method: 'GET', path: '/items' }] },
    timeouts: { requestMs: 500, aiRequestMs: 500, totalMs: 5000 },
  });
  assert.equal(result.failed.length, 1);
  assert.ok(result.failed[0].error, 'connection error recorded');

  const filtered = await probeApiEndpoints({
    baseUrl: 'http://127.0.0.1:1',
    apiContract: { endpoints: [{ method: 'GET', path: '/items' }, { method: 'GET', path: '/other' }] },
    filter: (s) => s.path === '/items',
    timeouts: { requestMs: 500, aiRequestMs: 500, totalMs: 5000 },
  });
  assert.equal(filtered.probed, 1);
});

// ── compose health + formatting ───────────────────────────────────────────

test('checkComposeHealthAfterProbe flags non-running services from JSON-lines ps', () => {
  const runComposeImpl = () => ({
    ok: true,
    stdout: [
      JSON.stringify({ Service: 'frontend', State: 'running' }),
      JSON.stringify({ Service: 'backend', State: 'exited' }),
    ].join('\n'),
  });
  const r = checkComposeHealthAfterProbe(runComposeImpl);
  assert.deepEqual(r.crashed, [{ service: 'backend', state: 'exited' }]);
});

test('formatProbeFailures renders endpoints, crash info, and log tail with byte cap', () => {
  const out = formatProbeFailures(
    [{ method: 'POST', path: '/recipes/generate', status: 502, error: null, bodySnippet: '<html>502' }],
    { logsTail: 'ENOTFOUND mga.platform.bayer.com', crashed: [{ service: 'backend', state: 'exited' }] },
  );
  assert.match(out, /POST \/recipes\/generate — HTTP 502/);
  assert.match(out, /backend \(exited\)/);
  assert.match(out, /ENOTFOUND/);
  const capped = formatProbeFailures(
    Array.from({ length: 200 }, (_, i) => ({ method: 'GET', path: `/x/${i}`, status: 500, bodySnippet: 'y'.repeat(200) })),
    { maxBytes: 2000 },
  );
  assert.ok(Buffer.byteLength(capped, 'utf-8') <= 2100);
});

// ── POST-then-GET persistence round-trip ──────────────────────────────────

test('persistence: created id missing from collection GET → flagged, not passed', async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/analyses') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 7, root_causes: ['x'] }));
    } else if (req.method === 'GET' && req.url === '/api/analyses') {
      // The silent-failure shape observed live: 200, but the write never landed.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ analyses: [], total: 0 }));
    } else {
      res.writeHead(200);
      res.end('{}');
    }
  });
  try {
    const result = await probeApiEndpoints({
      baseUrl: url,
      apiContract: { endpoints: [
        { method: 'POST', path: '/analyses', request: { description: 'string required' } },
        { method: 'GET', path: '/analyses' },
      ] },
      timeouts: { requestMs: 2000, aiRequestMs: 2000, totalMs: 20000 },
    });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, '/analyses');
    assert.match(result.failed[0].error, /^persistence: created id 7/);
    assert.equal(result.passed, 1); // only the POST
  } finally {
    server.close();
  }
});

test('persistence: collection containing the created row passes (nested + wrapped)', async () => {
  const { server, url } = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/analyses') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 9 } }));
    } else if (req.method === 'GET' && req.url === '/api/analyses') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ analyses: [{ id: 3 }, { id: 9, description: 'later' }], total: 2 }));
    } else {
      res.writeHead(200);
      res.end('{}');
    }
  });
  try {
    const result = await probeApiEndpoints({
      baseUrl: url,
      apiContract: { endpoints: [
        { method: 'POST', path: '/analyses', request: { description: 'string required' } },
        { method: 'GET', path: '/analyses' },
      ] },
      timeouts: { requestMs: 2000, aiRequestMs: 2000, totalMs: 20000 },
    });
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
    assert.equal(result.passed, 2);
  } finally {
    server.close();
  }
});

test('bodyContainsId: shapes and string/number id equivalence', () => {
  assert.equal(bodyContainsId([{ id: 5 }], '5'), true);
  assert.equal(bodyContainsId({ items: [{ id: '5' }] }, 5), true);
  assert.equal(bodyContainsId({ nested: { deep: [{ id: 5 }] } }, 5), true);
  assert.equal(bodyContainsId({ items: [{ id: 4 }] }, 5), false);
  assert.equal(bodyContainsId(null, 5), false);
  assert.equal(bodyContainsId('5', 5), false);
});
