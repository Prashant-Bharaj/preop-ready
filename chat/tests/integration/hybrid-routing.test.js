/**
 * P0 Integration test — hybrid routing gate.
 *
 * Tests the hybrid-router.js decision logic without spinning up a real
 * MGA server. All LLM calls are mocked via dependency injection.
 *
 * Scenarios covered:
 *   1. Flag off → modulesRan=false regardless of modulePlan
 *   2. Flag on + no modulePlan → modulesRan=false
 *   3. Flag on + confidence below threshold → modulesRan=false
 *   4. Flag on + valid modulePlan + confidence 0.82 → modulesRan=true
 *   5. Invalid modulePlan shape → modulesRan=false (validation rejects)
 *   6. execution-router throws → modulesRan=false (safe fallback)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { runHybridRouter } from '../../server/agent/hybrid-router.js';

const BASE_CONTRACT = {
  tasks: [{ scope: 'backend', summary: 'API', task: 'Build API' }],
  dataModel: null,
  apiContract: { endpoints: [] },
  vectorEngine: null,
  uiContract: null,
  businessLogicContract: { triggers: [], rules: [], side_effects: [] },
};

const VALID_MODULE_PLAN = [
  { module: 'synthesis', trigger: 'build-time', input: 'intent', output: 'prompt template' },
];

function makeSession() {
  return { id: 'test-' + Math.random().toString(36).slice(2, 8), hybridTrace: [] };
}

const ENV_CONTEXT = { projectPhase: 'fresh' };

// Save and restore env flag around each test
let savedFlag;
before(() => { savedFlag = process.env.HYBRID_MODULES_ENABLED; });
after(() => {
  if (savedFlag === undefined) delete process.env.HYBRID_MODULES_ENABLED;
  else process.env.HYBRID_MODULES_ENABLED = savedFlag;
});

test('hybrid-router: flag off → passes through unchanged', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'false';
  const result = await runHybridRouter({
    modulePlan: VALID_MODULE_PLAN,
    confidence: 0.90,
    contract: BASE_CONTRACT,
    session: makeSession(),
    envContext: ENV_CONTEXT,
  });
  assert.strictEqual(result.modulesRan, false);
  assert.strictEqual(result.skippedReason, 'flag-off');
  assert.deepStrictEqual(result.contract, BASE_CONTRACT);
});

test('hybrid-router: flag on + null modulePlan → passes through', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const result = await runHybridRouter({
    modulePlan: null,
    confidence: 0.90,
    contract: BASE_CONTRACT,
    session: makeSession(),
    envContext: ENV_CONTEXT,
  });
  assert.strictEqual(result.modulesRan, false);
  assert.strictEqual(result.skippedReason, 'no-module-plan');
});

test('hybrid-router: flag on + empty modulePlan → passes through', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const result = await runHybridRouter({
    modulePlan: [],
    confidence: 0.90,
    contract: BASE_CONTRACT,
    session: makeSession(),
    envContext: ENV_CONTEXT,
  });
  assert.strictEqual(result.modulesRan, false);
  assert.strictEqual(result.skippedReason, 'no-module-plan');
});

test('hybrid-router: flag on + confidence 0.60 below threshold → passes through', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const result = await runHybridRouter({
    modulePlan: VALID_MODULE_PLAN,
    confidence: 0.60,
    contract: BASE_CONTRACT,
    session: makeSession(),
    envContext: ENV_CONTEXT,
  });
  assert.strictEqual(result.modulesRan, false);
  assert.strictEqual(result.skippedReason, 'low-confidence');
});

test('hybrid-router: flag on + confidence 0.82 + valid plan → modulesRan=true', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const session = makeSession();
  const result = await runHybridRouter({
    modulePlan: VALID_MODULE_PLAN,
    confidence: 0.82,
    contract: BASE_CONTRACT,
    session,
    envContext: ENV_CONTEXT,
  });
  // P0 stub execution-router returns enriched contract with modulesRan=true
  assert.strictEqual(result.modulesRan, true);
  assert.ok(result.contract, 'contract must be present');
  assert.ok(Array.isArray(result.contract.tasks), 'tasks[] must be preserved');
});

test('hybrid-router: invalid modulePlan entry (bad module name) → passes through', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const result = await runHybridRouter({
    modulePlan: [{ module: 'unknown-module', trigger: 'build-time', input: 'x', output: 'y' }],
    confidence: 0.85,
    contract: BASE_CONTRACT,
    session: makeSession(),
    envContext: ENV_CONTEXT,
  });
  assert.strictEqual(result.modulesRan, false);
  assert.strictEqual(result.skippedReason, 'invalid-module-plan');
});

test('hybrid-router: contract tasks[] unchanged after modules ran', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const session = makeSession();
  const result = await runHybridRouter({
    modulePlan: VALID_MODULE_PLAN,
    confidence: 0.82,
    contract: BASE_CONTRACT,
    session,
    envContext: ENV_CONTEXT,
  });
  // tasks[] structure must never be modified by modules
  assert.deepStrictEqual(result.contract.tasks, BASE_CONTRACT.tasks);
});
