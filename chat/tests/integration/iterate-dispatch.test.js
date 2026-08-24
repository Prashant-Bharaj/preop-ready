/**
 * W2.DISPATCH — end-to-end iterate dispatch test.
 *
 * Hand-crafts mocked router emits + a synthetic session, then invokes the
 * dispatch selector and asserts behaviour:
 *
 *   Single-scope iterate ("make button bigger" → frontend-only):
 *     - dispatchIterate picks direct subagent spawn (no orchestrator call)
 *     - reuses session.coderConversationIds.frontend when pre-populated
 *     - emits a fresh subagent spawn when no prior convo
 *     - persists returned conversation_id back to coderConversationIds[scope]
 *
 *   Multi-scope iterate ("add admin role" → database + backend + frontend):
 *     - dispatchIterate picks orchestrator-with-diffs path
 *     - passes iterate.contractDiffs + affectedScopes through to orchestrator
 *     - unaffected scopes are NOT in the dispatch task set
 *
 *   Scope-gated diffs:
 *     - buildIterateDiffsBlock includes the right slice per scope
 *
 * This is a UNIT-shaped test: it does not call the live MGA router — that
 * would be hours of latency + tokens per CI run. The router's emit-shape is
 * already covered by `chat/server/agent/__tests__/router-mga.test.js` and
 * by W2.ROUTER's commit verification. Here we validate the dispatch
 * SELECTOR — the piece W2.DISPATCH actually owns.
 *
 * Live MGA exercise: a complementary script lives at
 * `chat/scripts/test-iterate-dispatch-live.js` (run on demand).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// paths.js reads WORKSPACE_DIR at module-eval time. Pin it to an empty temp
// dir BEFORE importing routes.js — otherwise a generated app sitting in the
// real workspace root (.harness/contracts.json, scope dirs from a local
// build) leaks into the dispatch-scope assertions.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-dispatch-test-'));
process.env.WORKSPACE_DIR = WS;

const { dispatchIterate, buildIterateDiffsBlock } = await import('../../server/session/routes.js');

// Mocked envContext sufficient to satisfy dispatchIterate's calls.
const ENV_CONTEXT = {
  projectPhase: 'building',
  hasStructure: { frontend: true, backend: true, database: true },
};

// Helper: synthetic session object matching the shape dispatchIterate reads.
function makeSession({ coderConvos = {} } = {}) {
  return {
    id: 'test-session-' + Math.random().toString(36).slice(2, 8),
    coderConversationIds: { ...coderConvos },
    coderTokenTotals: null,
    iterationQueue: [],
    lastActiveSubagentScope: null,
    cancelled: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Single-scope iterate — frontend only ("make submit button bigger")
// ─────────────────────────────────────────────────────────────────────────
test('dispatchIterate: single-scope (frontend) → direct subagent spawn, reuses coderConversationIds.frontend', async () => {
  const session = makeSession({ coderConvos: { frontend: 'frontend-convo-abc' } });

  // Mocked routerResult — simulates router emit for "make the submit button bigger"
  const routerResult = {
    action: 'iterate',
    affectedScopes: ['frontend'],
    contractDiffs: { ui_contract: { components: [{ name: 'SubmitButton', size: 'large' }] } },
    message: 'Make the submit button bigger',
    tasks: [{ scope: 'frontend', summary: 'Increase submit button size', task: 'Update the submit button styling so the button renders larger (use the existing variant prop or extend it).' }],
  };

  // Capture calls.
  let runCustomAgentCalls = 0;
  let buildDispatchCalls = 0;
  let observedConvoId = null;
  let observedScope = null;
  let observedMessage = null;

  const result = await dispatchIterate(session, routerResult, ENV_CONTEXT, [], {
    runCustomAgentFn: async (sessionId, message, opts) => {
      runCustomAgentCalls += 1;
      observedConvoId = opts.conversationId;
      observedScope = opts.scope;
      observedMessage = message;
      // Simulated successful run — emit a NEW conversation_id (the typical
      // MGA pattern: the assistant might rotate convo ids on continuation).
      return { exitCode: 0, conversationId: 'frontend-convo-abc-next' };
    },
    runBuildDispatchFn: async () => {
      buildDispatchCalls += 1;
      return { exitCode: 0 };
    },
  });

  assert.equal(result.exitCode, 0, 'dispatch should succeed');
  assert.equal(runCustomAgentCalls, 1, 'single-scope path → exactly 1 subagent spawn');
  assert.equal(buildDispatchCalls, 0, 'single-scope path → build-dispatcher NOT called');
  assert.equal(observedScope, 'frontend', 'spawned with scope=frontend');
  assert.equal(observedConvoId, 'frontend-convo-abc', 'reused prior coderConversationIds.frontend');
  // Persisted-back convo id:
  assert.equal(session.coderConversationIds.frontend, 'frontend-convo-abc-next',
    'updated coderConversationIds.frontend with returned id');
  // Last-active scope set on success:
  assert.equal(session.lastActiveSubagentScope, 'frontend', 'set lastActiveSubagentScope=frontend');
  // Iterate-diffs block injected into the spawn message:
  assert.match(observedMessage, /=== ITERATE DIFFS ===/, 'spawn message includes ITERATE DIFFS block');
  assert.match(observedMessage, /Increase submit button size|Make the submit button bigger/i,
    'spawn message references the iteration intent');
  // Scope-gated: ui_contract slice IS present (frontend scope).
  assert.match(observedMessage, /ui_contract diff/, 'frontend slice → ui_contract diff present');
});

test('dispatchIterate: single-scope, no prior coderConversationIds → fresh subagent spawn (null convo)', async () => {
  const session = makeSession({ coderConvos: {} });
  const routerResult = {
    action: 'iterate',
    affectedScopes: ['frontend'],
    contractDiffs: {},
    message: 'tweak header copy',
    tasks: [{ scope: 'frontend', summary: 'Update header copy', task: 'Change header text.' }],
  };
  let observedConvoId = 'sentinel-not-called';
  await dispatchIterate(session, routerResult, ENV_CONTEXT, [], {
    runCustomAgentFn: async (_sid, _msg, opts) => {
      observedConvoId = opts.conversationId;
      return { exitCode: 0, conversationId: 'fresh-convo' };
    },
    runBuildDispatchFn: async () => { throw new Error('orchestrator must not be called'); },
  });
  assert.equal(observedConvoId, null, 'no prior convo → conversationId passed as null');
  assert.equal(session.coderConversationIds.frontend, 'fresh-convo',
    'returned convo id persisted on first single-scope dispatch');
});

// ─────────────────────────────────────────────────────────────────────────
// Multi-scope iterate — admin role ("add admin role")
// ─────────────────────────────────────────────────────────────────────────
test('dispatchIterate: multi-scope (database+backend+frontend) → orchestrator-with-diffs, unaffected scopes skipped', async () => {
  const session = makeSession({ coderConvos: { frontend: 'F1', backend: 'B1' } });

  // Mocked routerResult — simulates emit for "add an admin role"
  const routerResult = {
    action: 'iterate',
    affectedScopes: ['database', 'backend', 'frontend'],
    contractDiffs: {
      data_model: { tables: [{ name: 'users', columns: [{ name: 'role', type: 'text' }] }] },
      api_contract: { endpoints: [{ method: 'POST', path: '/admin/promote' }] },
      ui_contract: { components: [{ name: 'AdminBadge' }] },
    },
    message: 'Add an admin role',
    tasks: [
      { scope: 'database', summary: 'Add role column', task: 'ALTER TABLE users ADD COLUMN role text DEFAULT \'user\';' },
      { scope: 'backend', summary: 'Admin endpoints', task: 'POST /admin/promote' },
      { scope: 'frontend', summary: 'Admin badge', task: 'Show AdminBadge for admin users' },
    ],
  };

  let runCustomAgentCalls = 0;
  let orchestratorCalledWith = null;

  const result = await dispatchIterate(session, routerResult, ENV_CONTEXT, [], {
    runCustomAgentFn: async () => {
      runCustomAgentCalls += 1;
      return { exitCode: 0, conversationId: 'unused' };
    },
    runBuildDispatchFn: async (tasks, env, sess, opts) => {
      orchestratorCalledWith = { tasks, env, sess, opts };
      return { exitCode: 0 };
    },
  });

  assert.equal(result.exitCode, 0, 'multi-scope dispatch should succeed');
  assert.equal(runCustomAgentCalls, 0, 'multi-scope path → direct subagent NOT called');
  assert.ok(orchestratorCalledWith, 'orchestrator was invoked');
  // Orchestrator received exactly the affected scopes' tasks:
  const scopes = orchestratorCalledWith.tasks.map(t => t.scope).sort();
  assert.deepEqual(scopes, ['backend', 'database', 'frontend'].sort(),
    'orchestrator tasks cover exactly the affected_scopes');
  // Unaffected scopes (vectordb, integration) are NOT in the dispatch set:
  assert.ok(!scopes.includes('vectordb'), 'vectordb (unaffected) not dispatched');
  assert.ok(!scopes.includes('integration'), 'integration (unaffected) not dispatched');
  // Iterate payload threaded through:
  assert.ok(orchestratorCalledWith.opts.iterate, 'orchestrator opts.iterate present');
  assert.equal(orchestratorCalledWith.opts.iterate.summary, 'Add an admin role',
    'iterate.summary forwarded');
  assert.deepEqual(orchestratorCalledWith.opts.iterate.affectedScopes,
    ['database', 'backend', 'frontend'],
    'iterate.affectedScopes forwarded');
  // ContractDiffs forwarded:
  assert.ok(orchestratorCalledWith.opts.iterate.contractDiffs.data_model,
    'data_model diff forwarded');
  assert.ok(orchestratorCalledWith.opts.iterate.contractDiffs.api_contract,
    'api_contract diff forwarded');
});

// ─────────────────────────────────────────────────────────────────────────
// Scope-gating in buildIterateDiffsBlock
// ─────────────────────────────────────────────────────────────────────────
test('buildIterateDiffsBlock: frontend scope sees ui_contract + api_contract, NOT data_model', () => {
  const diffs = {
    data_model: { tables: ['users'] },
    api_contract: { endpoints: ['/admin'] },
    ui_contract: { components: ['AdminBadge'] },
  };
  const block = buildIterateDiffsBlock('frontend', 'Add admin role', diffs);
  assert.match(block, /ui_contract diff/, 'frontend → ui_contract present');
  assert.match(block, /api_contract diff/, 'frontend → api_contract present');
  assert.doesNotMatch(block, /data_model diff/, 'frontend → data_model NOT present');
});

test('buildIterateDiffsBlock: database scope sees data_model only', () => {
  const diffs = {
    data_model: { tables: ['users'] },
    api_contract: { endpoints: ['/admin'] },
    ui_contract: { components: ['AdminBadge'] },
  };
  const block = buildIterateDiffsBlock('database', 'Add admin role', diffs);
  assert.match(block, /data_model diff/, 'database → data_model present');
  assert.doesNotMatch(block, /api_contract diff/, 'database → api_contract NOT present');
  assert.doesNotMatch(block, /ui_contract diff/, 'database → ui_contract NOT present');
});

test('buildIterateDiffsBlock: backend scope sees data_model + api_contract + business_logic + vector_engine', () => {
  const diffs = {
    data_model: { tables: ['users'] },
    api_contract: { endpoints: ['/admin'] },
    ui_contract: { components: ['AdminBadge'] },
    business_logic_contract: { rules: ['only-admin'] },
    vector_engine: 'pgvector',
  };
  const block = buildIterateDiffsBlock('backend', 'Add admin', diffs);
  assert.match(block, /data_model diff/);
  assert.match(block, /api_contract diff/);
  assert.match(block, /business_logic_contract diff/);
  assert.match(block, /vector_engine diff/);
  assert.doesNotMatch(block, /ui_contract diff/, 'backend → ui_contract NOT present');
});

test('buildIterateDiffsBlock: empty contractDiffs still emits framing for cosmetic changes', () => {
  const block = buildIterateDiffsBlock('frontend', 'tweak copy', {});
  assert.match(block, /=== ITERATE DIFFS ===/);
  assert.match(block, /tweak copy/);
  // No diff slices present:
  assert.doesNotMatch(block, /data_model diff|api_contract diff|ui_contract diff/);
});
