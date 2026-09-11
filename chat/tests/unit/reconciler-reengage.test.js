import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNarrowDirective, reengageScopeForMismatch } from '../../server/reconciler/reengage.js';

// ── buildNarrowDirective ──────────────────────────────────────────────

test('buildNarrowDirective: header + mismatch list + FULL router contracts (not sliced)', () => {
  // Updated: directive now includes FULL contracts (not slices) so the
  // re-engaged scope sees the entire contract surface and won't invent
  // identifiers. See t39 (2026-05-09) cascade for why slices were a bug.
  const out = buildNarrowDirective(
    'backend',
    [{
      kind: 'body-shape-mismatch',
      scope: 'backend',
      severity: 'soft',
      method: 'POST',
      path: '/requests',
      file: 'backend/src/routes.js',
      line: 34,
      contract: 'body { employeeId, startDate, endDate }',
      actual: 'body { emp_id, start, end }',
    }],
    {
      apiContract: {
        endpoints: [
          { method: 'POST', path: '/requests', request: { employeeId: 'string' } },
          { method: 'GET', path: '/users', request: {} },
        ],
      },
      dataModel: {
        tables: [{ name: 'requests', columns: [{ name: 'id' }, { name: 'employee_id' }] }],
      },
    },
  );
  assert.match(out, /CROSS-SCOPE RECONCILER - BACKEND RE-ENGAGE/);
  assert.match(out, /POST \/requests at backend\/src\/routes\.js:34/);
  assert.match(out, /expected: body \{ employeeId/);
  assert.match(out, /actual:   body \{ emp_id/);
  assert.match(out, /ROUTER CONTRACTS \(FULL/);
  // Backend gets dataModel + apiContract in full (not sliced).
  assert.match(out, /"path": "\/requests"/);
  assert.match(out, /"path": "\/users"/, 'full contract should include unrelated endpoints too');
  assert.match(out, /"name": "requests"/);
  assert.match(out, /"name": "employee_id"/);
});

test('buildNarrowDirective: scope-gated contract picking', () => {
  // Frontend should NOT see dataModel; database should NOT see apiContract.
  const frontendOut = buildNarrowDirective(
    'frontend',
    [{ kind: 'frontend-fetch-no-backend-route', scope: 'frontend', method: 'GET', path: '/x', file: 'f.jsx', line: 1 }],
    {
      apiContract: { endpoints: [{ method: 'GET', path: '/users' }] },
      dataModel: { tables: [{ name: 'users', columns: [{ name: 'id' }] }] },
      uiContract: { primary_view: 'list', primary_action: 'add', components: [{ name: 'UserList' }] },
    },
  );
  assert.match(frontendOut, /apiContract/);
  assert.match(frontendOut, /uiContract/);
  assert.doesNotMatch(frontendOut, /dataModel/, 'frontend does not need dataModel');

  const databaseOut = buildNarrowDirective(
    'database',
    [{ kind: 'db-column-missing', scope: 'database', file: 'db.sql' }],
    {
      apiContract: { endpoints: [{ method: 'GET', path: '/users' }] },
      dataModel: { tables: [{ name: 'users', columns: [] }] },
    },
  );
  assert.match(databaseOut, /dataModel/);
  assert.doesNotMatch(databaseOut, /apiContract/, 'database does not need apiContract');
});

test('buildNarrowDirective: includes original task spec when tasks present', () => {
  const out = buildNarrowDirective(
    'backend',
    [{ kind: 'backend-missing-contract-endpoint', scope: 'backend', method: 'GET', path: '/x' }],
    {
      tasks: [
        { scope: 'backend', summary: 'Tasks API', task: 'Build CRUD endpoints for tasks.' },
        { scope: 'frontend', summary: 'Tasks UI', task: 'Show list of tasks.' },
      ],
    },
  );
  assert.match(out, /ORIGINAL TASK \(this scope\)/);
  assert.match(out, /Summary: Tasks API/);
  assert.match(out, /Build CRUD endpoints for tasks/);
  assert.doesNotMatch(out, /Tasks UI/, 'should only include this scope task');
});

test('buildNarrowDirective: includes current workspace state for sibling scopes', () => {
  const out = buildNarrowDirective(
    'backend',
    [{ kind: 'backend-missing-contract-endpoint', scope: 'backend', method: 'POST', path: '/users' }],
    { apiContract: { endpoints: [{ method: 'POST', path: '/users' }] } },
    {
      extractedDb: [{ table: 'users', columns: [{ name: 'id' }, { name: 'email' }] }],
      extractedFrontend: [{ method: 'POST', path: '/users', requestFields: ['email', 'name'] }],
      extractedBackend: [],
    },
  );
  assert.match(out, /CURRENT WORKSPACE STATE/);
  assert.match(out, /users\(id, email\)/);
  assert.match(out, /Frontend fetches your scope must serve/);
  assert.match(out, /POST \/users.*body: \{ email, name \}/);
});

test('buildNarrowDirective: empty mismatches still produces task framing', () => {
  // Defensive — caller normally won't pass [] but the helper shouldn't blow up.
  const out = buildNarrowDirective('frontend', [], {});
  assert.match(out, /FRONTEND RE-ENGAGE/);
});

// ── reengageScopeForMismatch ──────────────────────────────────────────

test('reengageScopeForMismatch: empty mismatches -> no dispatch', async () => {
  let called = 0;
  const runner = async () => { called++; return {}; };
  const r = await reengageScopeForMismatch('backend', [], { id: 's' }, { runCustomAgent: runner });
  assert.equal(called, 0);
  assert.equal(r.reengagedTurns, 0);
});

test('reengageScopeForMismatch: dispatches with fresh conversation and scope', async () => {
  const calls = [];
  const runner = async (sessionId, prompt, opts) => {
    calls.push({ sessionId, prompt, opts });
    return { exitCode: 0, conversationId: 'conv-new', completionText: 'Resolved.', runTokenTotals: { turns: 2 } };
  };
  const session = { id: 'sess-1' };
  const r = await reengageScopeForMismatch(
    'backend',
    [{ kind: 'route-missing-in-backend', scope: 'backend', method: 'POST', path: '/requests' }],
    session,
    { runCustomAgent: runner },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'sess-1');
  assert.equal(calls[0].opts.conversationId, null, 'always fresh conversation');
  assert.equal(calls[0].opts.scope, 'backend');
  assert.match(calls[0].prompt, /BACKEND RE-ENGAGE/);
  assert.equal(r.reengagedTurns, 2);
  assert.equal(r.exitCode, 0);
  assert.equal(session.coderConversationIds.backend, 'conv-new');
});

test('reengageScopeForMismatch: runner throws -> returns error result, no rethrow', async () => {
  const runner = async () => { throw new Error('mga down'); };
  const r = await reengageScopeForMismatch(
    'frontend',
    [{ kind: 'frontend-extra-fetch', scope: 'frontend' }],
    { id: 's' },
    { runCustomAgent: runner },
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.error, 'mga down');
});

test('reengageScopeForMismatch: accumulate hook is invoked with session + result', async () => {
  const runner = async () => ({ exitCode: 0, completionText: 'ok', runTokenTotals: { turns: 1 } });
  let acc = null;
  const accumulate = (sess, res) => { acc = { sessionId: sess.id, exitCode: res.exitCode }; };
  await reengageScopeForMismatch(
    'database',
    [{ kind: 'db-column-missing', scope: 'database' }],
    { id: 'sess-x' },
    { runCustomAgent: runner, accumulateTotals: accumulate },
  );
  assert.deepEqual(acc, { sessionId: 'sess-x', exitCode: 0 });
});
