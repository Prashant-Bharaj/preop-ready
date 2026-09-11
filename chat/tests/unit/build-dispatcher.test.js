/**
 * Unit tests for chat/server/agent/coordinator/build-dispatcher.js.
 *
 * We test the pure helper `computeDispatchOrder` exhaustively here.
 * The full `runBuildDispatch` function spawns real subagents via MGA and
 * is exercised by the smoke battery — not unit-tested.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeDispatchOrder } from '../../server/agent/coordinator/build-dispatcher.js';
import { CANONICAL_SCOPE_ORDER } from '../../server/agent/coordinator/scope-order.js';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical order
// ─────────────────────────────────────────────────────────────────────────────

test('canonical order: full 5-scope build dispatches db→vdb→be→fe→int', () => {
  const tasks = [
    { scope: 'database' },
    { scope: 'vectordb' },
    { scope: 'backend' },
    { scope: 'frontend' },
    { scope: 'integration' },
  ];
  assert.deepEqual(computeDispatchOrder(tasks), [
    'database', 'vectordb', 'backend', 'frontend', 'integration',
  ]);
});

test('canonical order: 4-scope CRUD (no vectordb) maintains relative order', () => {
  const tasks = [
    { scope: 'database' },
    { scope: 'backend' },
    { scope: 'frontend' },
    { scope: 'integration' },
  ];
  assert.deepEqual(computeDispatchOrder(tasks), [
    'database', 'backend', 'frontend', 'integration',
  ]);
});

test('canonical order: tasks in wrong order still produce canonical dispatch', () => {
  const tasks = [
    { scope: 'integration' },
    { scope: 'frontend' },
    { scope: 'backend' },
    { scope: 'database' },
    { scope: 'vectordb' },
  ];
  assert.deepEqual(computeDispatchOrder(tasks), [
    'database', 'vectordb', 'backend', 'frontend', 'integration',
  ]);
});

test('canonical order: includes only scopes actually in tasks[]', () => {
  const tasks = [{ scope: 'backend' }, { scope: 'frontend' }];
  assert.deepEqual(computeDispatchOrder(tasks), ['backend', 'frontend']);
});

test('canonical order: single scope works (e.g. integration-only iterate)', () => {
  const tasks = [{ scope: 'backend' }];
  assert.deepEqual(computeDispatchOrder(tasks), ['backend']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Iterate-mode filtering
// ─────────────────────────────────────────────────────────────────────────────

test('iterate: filters to affected_scopes preserving canonical order', () => {
  const tasks = [
    { scope: 'database' },
    { scope: 'backend' },
    { scope: 'frontend' },
    { scope: 'integration' },
  ];
  const iterate = { affectedScopes: ['frontend', 'backend'] };
  assert.deepEqual(computeDispatchOrder(tasks, iterate), ['backend', 'frontend']);
});

test('iterate: single affected scope produces a single-element list', () => {
  const tasks = [
    { scope: 'database' },
    { scope: 'backend' },
    { scope: 'frontend' },
    { scope: 'integration' },
  ];
  const iterate = { affectedScopes: ['backend'] };
  assert.deepEqual(computeDispatchOrder(tasks, iterate), ['backend']);
});

test('iterate: affected_scopes not in tasks[] are dropped silently', () => {
  const tasks = [
    { scope: 'database' },
    { scope: 'backend' },
  ];
  // 'frontend' is in affected_scopes but not in tasks[] — dispatch order skips it
  const iterate = { affectedScopes: ['backend', 'frontend'] };
  assert.deepEqual(computeDispatchOrder(tasks, iterate), ['backend']);
});

test('iterate: empty affected_scopes treated as no-iterate (returns full natural order)', () => {
  const tasks = [{ scope: 'database' }, { scope: 'backend' }];
  // Defensive — runtime won't call with this, but ensure we don't accidentally
  // dispatch nothing when affected_scopes is an empty array
  assert.deepEqual(computeDispatchOrder(tasks, { affectedScopes: [] }), ['database', 'backend']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('edge: empty tasks → empty dispatch order', () => {
  assert.deepEqual(computeDispatchOrder([], null), []);
});

test('edge: tasks=null → empty dispatch order', () => {
  assert.deepEqual(computeDispatchOrder(null, null), []);
});

test('edge: tasks with invalid scope are dropped from order', () => {
  const tasks = [
    { scope: 'database' },
    { scope: 'banana' },     // not canonical
    { scope: 'backend' },
    { scope: 'fullstack' },  // forbidden in two-agent contract; filtered out
  ];
  assert.deepEqual(computeDispatchOrder(tasks), ['database', 'backend']);
});

test('edge: tasks with missing/undefined scope are skipped', () => {
  const tasks = [
    { scope: 'database' },
    { /* no scope */ },
    { scope: null },
    { scope: 'backend' },
  ];
  assert.deepEqual(computeDispatchOrder(tasks), ['database', 'backend']);
});

test('edge: duplicate scopes deduplicate in dispatch order', () => {
  const tasks = [
    { scope: 'backend' },
    { scope: 'backend' },
    { scope: 'frontend' },
  ];
  assert.deepEqual(computeDispatchOrder(tasks), ['backend', 'frontend']);
});

test('edge: iterate with all scopes filtered out → empty order', () => {
  const tasks = [{ scope: 'database' }, { scope: 'backend' }];
  const iterate = { affectedScopes: ['frontend', 'integration'] };
  assert.deepEqual(computeDispatchOrder(tasks, iterate), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Smoke: CANONICAL_SCOPE_ORDER constant
// ─────────────────────────────────────────────────────────────────────────────

test('CANONICAL_SCOPE_ORDER: matches the 5 canonical scopes in expected order', () => {
  assert.deepEqual(CANONICAL_SCOPE_ORDER, [
    'database',
    'vectordb',
    'backend',
    'frontend',
    'integration',
  ]);
});

test('CANONICAL_SCOPE_ORDER: is frozen (immutable)', () => {
  assert.ok(Object.isFrozen(CANONICAL_SCOPE_ORDER));
});
