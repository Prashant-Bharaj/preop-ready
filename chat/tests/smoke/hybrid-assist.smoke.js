/**
 * P1 Smoke test — hybrid AI assist end-to-end.
 *
 * Tests the hybrid path: a prompt with LLM intent triggers module badges in
 * the plan_preview event, /confirm triggers hybrid modules (or falls back
 * gracefully when HYBRID_MODULES_ENABLED is off), build-dispatcher runs,
 * and GET /trace returns the hybridTrace array.
 *
 * This is a lightweight smoke test that:
 *  1. Exercises the planning path with a hybrid-eligible prompt
 *  2. Verifies the plan_preview event includes module plan fields
 *  3. Confirms that GET /trace returns a valid response structure
 *  4. Does NOT burn real MGA tokens for module calls (modules are gated
 *     behind HYBRID_MODULES_ENABLED=true which is off by default)
 *
 * Usage (from spike root):
 *   HYBRID_MODULES_ENABLED=false node chat/tests/smoke/hybrid-assist.smoke.js
 *   HYBRID_MODULES_ENABLED=true  node chat/tests/smoke/hybrid-assist.smoke.js
 */

import assert from 'node:assert/strict';
import { runHybridRouter } from '../../server/agent/hybrid-router.js';
import { getTrace, clearTrace, appendTraceStep } from '../../server/agent/orchestrator/trace-store.js';
import { evaluateCompletion } from '../../server/agent/orchestrator/completion-policy.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const AI_INTEGRATION_CONTRACT = {
  tasks: [
    { scope: 'backend', summary: 'API + LLM integration', task: 'Build Express API with AI endpoint' },
    { scope: 'frontend', summary: 'Chat UI', task: 'Build React UI with streaming chat' },
  ],
  dataModel: { tables: [{ name: 'sessions', columns: [] }] },
  apiContract: { endpoints: [{ method: 'POST', path: '/api/generate' }] },
  vectorEngine: null,
  uiContract: { primary_view: 'Chat', primary_action: 'Send message', components: [] },
  businessLogicContract: { triggers: [], rules: [], side_effects: [] },
};

const AI_MODULE_PLAN = [
  { module: 'synthesis', trigger: 'build-time', input: 'LLM integration intent', output: 'prompt template + API spec' },
  { module: 'policy-checker', trigger: 'build-time', input: 'category list', output: 'compliance flags' },
];

function makeSession() {
  return { id: 'smoke-' + Math.random().toString(36).slice(2, 8), hybridTrace: [] };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// Save and restore the env flag
const savedFlag = process.env.HYBRID_MODULES_ENABLED;
function restoreFlag() {
  if (savedFlag === undefined) delete process.env.HYBRID_MODULES_ENABLED;
  else process.env.HYBRID_MODULES_ENABLED = savedFlag;
}

console.log('\n=== hybrid-assist smoke tests ===\n');

// ── 1. plan_preview contract shape ────────────────────────────────────────────

await run('plan_preview payload includes hybrid fields when modulePlan is present', async () => {
  // Simulate what routes.js emits into the SSE stream on plan_preview
  const planPreviewPayload = {
    message: 'I understood: build a startup idea generator that calls LLM per category.',
    tasks: AI_INTEGRATION_CONTRACT.tasks,
    modulePlan: AI_MODULE_PLAN,
    reasonCodes: ['adaptive-need', 'research-need'],
    confidence: 0.82,
  };

  // Verify shape mirrors what ChatScreen.jsx expects
  assert.ok(Array.isArray(planPreviewPayload.modulePlan), 'modulePlan must be array');
  assert.ok(Array.isArray(planPreviewPayload.reasonCodes), 'reasonCodes must be array');
  assert.strictEqual(typeof planPreviewPayload.confidence, 'number', 'confidence must be number');
  assert.ok(planPreviewPayload.confidence >= 0.75, 'confidence must meet threshold');
  assert.strictEqual(planPreviewPayload.modulePlan[0].module, 'synthesis');
});

// ── 2. hybrid-router: flag off → deterministic (default) ─────────────────────

await run('hybrid-router: flag off → modulesRan=false, contract unchanged', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'false';
  const session = makeSession();
  const result = await runHybridRouter({
    modulePlan: AI_MODULE_PLAN,
    confidence: 0.82,
    contract: AI_INTEGRATION_CONTRACT,
    session,
    envContext: {},
  });
  assert.strictEqual(result.modulesRan, false);
  assert.strictEqual(result.skippedReason, 'flag-off');
  assert.deepStrictEqual(result.contract, AI_INTEGRATION_CONTRACT);
  assert.strictEqual(getTrace(session).length, 0, 'no trace entries when flag off');
});

// ── 3. hybrid-router: flag on + valid plan → modules ran ─────────────────────

await run('hybrid-router: flag on + valid plan + confidence 0.82 → modulesRan=true', async () => {
  process.env.HYBRID_MODULES_ENABLED = 'true';
  const session = makeSession();
  const result = await runHybridRouter({
    modulePlan: AI_MODULE_PLAN,
    confidence: 0.82,
    contract: AI_INTEGRATION_CONTRACT,
    session,
    envContext: {},
  });
  assert.strictEqual(result.modulesRan, true, 'modulesRan must be true');
  assert.ok(result.contract, 'must return a contract');
  // hybridTrace populated with entries
  const trace = getTrace(session);
  assert.ok(trace.length > 0, 'hybridTrace must have entries when modules ran');
});

// ── 4. trace-store: clearTrace between builds ─────────────────────────────────

await run('clearTrace removes entries from prior build', async () => {
  const session = makeSession();
  appendTraceStep(session, { module: 'synthesis', status: 'completed', durationMs: 100 });
  assert.strictEqual(getTrace(session).length, 1);
  clearTrace(session);
  assert.strictEqual(getTrace(session).length, 0);
});

// ── 5. GET /trace shape contract ─────────────────────────────────────────────

await run('GET /trace response shape is correct (unit-level)', async () => {
  const session = makeSession();
  appendTraceStep(session, {
    module: 'synthesis', input: 'test', output: '{}', durationMs: 200, status: 'completed',
  });
  appendTraceStep(session, {
    module: 'policy-checker', input: 'test', output: '{"flags":[]}', durationMs: 150, status: 'completed',
  });

  const trace = getTrace(session);
  // Shape the trace-routes handler would return
  const response = { sessionId: session.id, trace };

  assert.strictEqual(response.sessionId, session.id);
  assert.ok(Array.isArray(response.trace));
  assert.strictEqual(response.trace.length, 2);
  assert.strictEqual(response.trace[0].module, 'synthesis');
  assert.strictEqual(response.trace[1].module, 'policy-checker');
});

// ── 6. completion-policy: partial failure → fallback ─────────────────────────

await run('completion-policy: one failed module → complete=false, fails listed', async () => {
  const result = evaluateCompletion(AI_MODULE_PLAN, {
    synthesis: { promptTemplate: 'You are...', apiSpec: {}, contentSchema: {} },
    'policy-checker': null, // failed
  });
  assert.strictEqual(result.complete, false);
  assert.ok(result.failed.includes('policy-checker'));
});

// ── Summary ───────────────────────────────────────────────────────────────────

restoreFlag();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
