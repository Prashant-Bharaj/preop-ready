/**
 * P1 Integration test — hybrid trace.
 *
 * Verifies that:
 *   1. A full hybrid run (modules enabled + valid plan + confidence >= 0.75)
 *      populates session.hybridTrace with one entry per module.
 *   2. trace-store helpers (getTrace, appendTraceStep, clearTrace) work correctly.
 *   3. completion-policy evaluates success/failure correctly.
 *
 * No real MGA calls — execution-router's loadSpecialist P0 stub returns
 * empty outputs so no LLM is involved in this test.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { runHybridRouter } from '../../server/agent/hybrid-router.js';
import { appendTraceStep, getTrace, clearTrace } from '../../server/agent/orchestrator/trace-store.js';
import { evaluateCompletion } from '../../server/agent/orchestrator/completion-policy.js';

const BASE_CONTRACT = {
  tasks: [{ scope: 'backend', summary: 'API', task: 'Build API' }],
  dataModel: null,
  apiContract: { endpoints: [] },
  vectorEngine: null,
  uiContract: null,
  businessLogicContract: { triggers: [], rules: [], side_effects: [] },
};

const MODULE_PLAN = [
  { module: 'synthesis', trigger: 'build-time', input: 'intent + category list', output: 'LLM prompt template' },
  { module: 'policy-checker', trigger: 'build-time', input: 'category list', output: 'compliance flags' },
];

function makeSession() {
  return { id: 'trace-test-' + Math.random().toString(36).slice(2, 8), hybridTrace: [] };
}

let savedFlag;
before(() => { savedFlag = process.env.HYBRID_MODULES_ENABLED; });
after(() => {
  if (savedFlag === undefined) delete process.env.HYBRID_MODULES_ENABLED;
  else process.env.HYBRID_MODULES_ENABLED = savedFlag;
});

// ── trace-store unit tests ────────────────────────────────────────────────────

test('trace-store: appendTraceStep adds entry with correct shape', () => {
  const session = makeSession();
  appendTraceStep(session, {
    module: 'synthesis',
    input: 'test input',
    output: '{"promptTemplate":"test"}',
    durationMs: 120,
    status: 'completed',
  });
  const trace = getTrace(session);
  assert.strictEqual(trace.length, 1);
  assert.strictEqual(trace[0].module, 'synthesis');
  assert.strictEqual(trace[0].status, 'completed');
  assert.strictEqual(typeof trace[0].ts, 'number');
  assert.strictEqual(trace[0].durationMs, 120);
});

test('trace-store: getTrace returns a copy (mutations do not affect session)', () => {
  const session = makeSession();
  appendTraceStep(session, { module: 'retrieval', status: 'completed' });
  const trace = getTrace(session);
  trace.push({ module: 'fake' });
  assert.strictEqual(session.hybridTrace.length, 1); // session unchanged
});

test('trace-store: clearTrace resets to empty array', () => {
  const session = makeSession();
  appendTraceStep(session, { module: 'synthesis', status: 'completed' });
  clearTrace(session);
  assert.deepStrictEqual(getTrace(session), []);
});

test('trace-store: getTrace on session with no hybridTrace returns empty array', () => {
  const session = { id: 'no-trace' }; // no hybridTrace field
  assert.deepStrictEqual(getTrace(session), []);
});

// ── completion-policy unit tests ──────────────────────────────────────────────

test('completion-policy: all modules succeeded → complete=true', () => {
  const result = evaluateCompletion(MODULE_PLAN, {
    synthesis: { promptTemplate: 'test' },
    'policy-checker': { flags: [] },
  });
  assert.strictEqual(result.complete, true);
  assert.deepStrictEqual(result.failed, []);
});

test('completion-policy: one module null → complete=false with failed list', () => {
  const result = evaluateCompletion(MODULE_PLAN, {
    synthesis: { promptTemplate: 'test' },
    'policy-checker': null,
  });
  assert.strictEqual(result.complete, false);
  assert.deepStrictEqual(result.failed, ['policy-checker']);
});

test('completion-policy: empty modulePlan → complete=true', () => {
  const result = evaluateCompletion([], {});
  assert.strictEqual(result.complete, true);
});

// ── Hybrid trace population via execution-router ─────────────────────────────

test('hybrid run populates hybridTrace with one entry per module', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const session = makeSession();

  const result = await runHybridRouter({
    modulePlan: MODULE_PLAN,
    confidence: 0.85,
    contract: BASE_CONTRACT,
    session,
    envContext: {},
  });

  // modulesRan=true when flag on + valid plan + confidence >= 0.75
  assert.strictEqual(result.modulesRan, true);

  // hybridTrace should have one entry per module in the plan
  const trace = getTrace(session);
  assert.ok(trace.length >= MODULE_PLAN.length,
    `expected ${MODULE_PLAN.length} trace entries, got ${trace.length}`);

  const moduleNames = trace.map(s => s.module);
  for (const entry of MODULE_PLAN) {
    assert.ok(moduleNames.includes(entry.module),
      `expected module "${entry.module}" in trace`);
  }

  // Each entry must have required fields
  for (const step of trace) {
    assert.ok(typeof step.module === 'string', 'step.module must be string');
    assert.ok(typeof step.status === 'string', 'step.status must be string');
    assert.ok(typeof step.ts === 'number', 'step.ts must be number');
  }
});

test('hybrid trace is NOT populated when flag off', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'false';
  const session = makeSession();

  await runHybridRouter({
    modulePlan: MODULE_PLAN,
    confidence: 0.85,
    contract: BASE_CONTRACT,
    session,
    envContext: {},
  });

  // No modules ran → hybridTrace stays empty (not touched by hybrid-router when flag off)
  const trace = getTrace(session);
  assert.strictEqual(trace.length, 0);
});
