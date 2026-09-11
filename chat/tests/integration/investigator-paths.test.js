/**
 * Coverage: flow 5 (Bug report → investigator) via chain
 *   flow 5 → user reports symptom → investigator phase runs (read-only) →
 *           parses + validates structured JSON report → decideInvestigatorBranch
 *           gates on confidence threshold → high-conf auto_fix synthesizes a
 *           routerResult and dispatchIterate fires; low-conf surface emits
 *           a diagnosis to the user → INVESTIGATING phase machine hard-guards
 *           write/exec/spawn tools (flow 10 chain, primitive denial)
 *
 * Migrated from `tests/agents/test-investigator-paths.js` (Dispatch 3 — original
 * was a scripted `process.exit(N)` driver). Same code paths exercised, same
 * assertions made; the wrapping is mechanical.
 *
 * Integration tier: real `routes.js` exports (tryParseInvestigatorReport,
 * validateInvestigatorReport, runInvestigatorPhase, decideInvestigatorBranch,
 * dispatchIterate) and `phase.js` PhaseStateMachine. MGA is intercepted via the
 * deps-injection slot (runCustomAgentFn) rather than the mock layer — that
 * slot was the brief-stated test seam in W3.INVEST, and the original driver
 * relied on it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryParseInvestigatorReport,
  validateInvestigatorReport,
  runInvestigatorPhase,
  decideInvestigatorBranch,
  dispatchIterate,
} from '../../server/session/routes.js';
import { PhaseStateMachine, PHASES, resolvePhaseAssistant } from '../../server/agent/loop/phase.js';
import { INVESTIGATOR_AUTO_FIX_CONFIDENCE } from '../../server/config/defaults.js';

// ── Synthetic investigator completionText payloads ───────────────────────

const HIGH_CONF_REPORT = {
  root_cause: 'The /health route in backend/src/index.ts returns a 500 because the handler dereferences pool.query without awaiting it; the test harness sees an unresolved Promise serialised as undefined and Express responds with status 500.',
  affected_scopes: ['backend'],
  confidence: 0.85,
  recommended_fix: {
    scope: 'backend',
    description: 'In backend/src/index.ts /health handler, await pool.query before returning the response. Return {ok:true} from the awaited result.',
    contract_change: null,
  },
  files_read: ['backend/src/index.ts', '.harness/contracts.json'],
  logs_read: ['backend'],
};

const LOW_CONF_REPORT = {
  root_cause: 'The frontend reports a blank page on load. Backend logs show only an nginx 200 on / and no JS errors are visible from server-side telemetry. The bug could be a runtime JS error, a CSS issue, or an API misconfiguration; no single piece of evidence points definitively at one cause.',
  affected_scopes: ['frontend'],
  confidence: 0.45,
  recommended_fix: {
    scope: 'frontend',
    description: 'Inspect frontend/src/App.tsx for a useEffect that may throw on mount and add a fallback render. The user should also share the browser console output to confirm.',
    contract_change: null,
  },
  files_read: ['frontend/src/App.tsx', 'frontend/src/main.tsx'],
  logs_read: ['frontend', 'backend'],
};

function reportToCompletion(report, { wrap = 'raw' } = {}) {
  const json = JSON.stringify(report);
  if (wrap === 'fenced') return '```json\n' + json + '\n```';
  if (wrap === 'prose') return 'Here is my report:\n\n' + json + '\n\nThanks.';
  return json;
}

function makeStubRunCustomAgent(completionText) {
  return async (_sessionId, _prompt, opts) => {
    assert.equal(opts.phase, PHASES.INVESTIGATING,
      'runCustomAgent must be invoked with phase=PHASES.INVESTIGATING');
    return {
      exitCode: 0,
      conversationId: 'stub-investigator-convo',
      completionText,
      usage: null,
      runTokenTotals: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, apiCalls: 1, truncations: 0 },
      writtenPaths: [],
      buildPassed: false,
    };
  };
}

function makeSession() {
  return {
    id: 'invest-test-' + Math.random().toString(36).slice(2, 8),
    coderConversationIds: {},
    coderTokenTotals: null,
    iterationQueue: [],
    lastActiveSubagentScope: null,
    cancelled: false,
  };
}

// ── PATH 0 — Constants sanity ─────────────────────────────────────────────

test('constants sanity: INVESTIGATOR_AUTO_FIX_CONFIDENCE is a sensible threshold', () => {
  assert.equal(typeof INVESTIGATOR_AUTO_FIX_CONFIDENCE, 'number');
  assert.ok(INVESTIGATOR_AUTO_FIX_CONFIDENCE > 0 && INVESTIGATOR_AUTO_FIX_CONFIDENCE < 1,
    `threshold must be in (0,1); got ${INVESTIGATOR_AUTO_FIX_CONFIDENCE}`);
});

// ── PATH 0b — INVESTIGATING resolves non-fatally without an assistant ID ──────
// Post-transport-refactor the phase assistant ID is only a log label (the model
// comes from pickModel, the prompt from disk). resolvePhaseAssistant must NOT
// return an `error` for a missing investigator ID — otherwise agent.js rejects
// the turn and the investigator can't run in any environment that hasn't
// provisioned INVESTIGATOR_ASSISTANT_ID (e.g. local dev). Regression guard for
// the "Investigation did not complete (no assistant ID configured)" bug.
test('PATH 0b — INVESTIGATING resolves to a null id + label without error when unconfigured', () => {
  const resolved = resolvePhaseAssistant(PHASES.INVESTIGATING, { creds: {} });
  assert.equal(resolved.assistantId, null, 'no id when none configured');
  assert.equal(resolved.label, 'Investigator', 'label is still set for logging');
  assert.ok(!resolved.error, 'missing investigator id must NOT be a resolution error');
});

// ── PATH 1 — High-confidence auto-fix ────────────────────────────────────

test('PATH 1 — high-confidence (0.85) → auto_fix branch → dispatchIterate fires for affected scope', async () => {
  // 1a — parse + validate
  const parsedRaw = tryParseInvestigatorReport(reportToCompletion(HIGH_CONF_REPORT));
  assert.ok(parsedRaw, 'tryParseInvestigatorReport must return a parsed object');
  const validation = validateInvestigatorReport(parsedRaw);
  assert.ok(validation.ok, 'high-confidence report must validate (reason: ' + (validation.reason || 'n/a') + ')');
  const report = validation.report;
  assert.equal(report.confidence, 0.85);
  assert.deepEqual(report.affected_scopes, ['backend']);

  // 1b — round-trip via runInvestigatorPhase
  const session = makeSession();
  const phaseResult = await runInvestigatorPhase(session, 'health endpoint returns 500', 'backend', {
    runCustomAgentFn: makeStubRunCustomAgent(reportToCompletion(HIGH_CONF_REPORT)),
  });
  assert.ok(phaseResult.ok, 'runInvestigatorPhase ok=true on high-confidence happy path');
  assert.equal(phaseResult.report.confidence, 0.85);

  // 1c — gate decision
  const decision = decideInvestigatorBranch(phaseResult.report);
  assert.equal(decision.branch, 'auto_fix', 'confidence 0.85 >= threshold → auto_fix branch');
  assert.equal(decision.synthetic.action, 'iterate', 'synthetic routerResult has action=iterate');
  assert.deepEqual(decision.synthetic.affectedScopes, ['backend'],
    'synthetic affectedScopes mirrors the report');
  assert.equal(decision.synthetic.tasks.length, 1, 'one task per affected scope');
  assert.equal(decision.synthetic.tasks[0].scope, 'backend');
  assert.match(decision.synthetic.tasks[0].task, /fix.+health/i,
    'task text references the recommended fix');
  assert.match(decision.synthetic.tasks[0].task, /Investigator root cause/i,
    'task text embeds the investigator root cause');

  // 1d — dispatchIterate single-scope path
  let observedScope = null;
  const iterResult = await dispatchIterate(
    session, decision.synthetic,
    { workspaceDir: '/tmp/nonexistent-invest-test', projectPhase: 'iterating' },
    [],
    {
      runCustomAgentFn: async (_sid, _msg, opts) => {
        observedScope = opts.scope;
        return { exitCode: 0, conversationId: 'backend-convo-next' };
      },
      runBuildDispatchFn: async () => { throw new Error('build-dispatcher must not be called for single-scope iterate'); },
      // Hermetic: the real workspace may carry an mga-client from live testing,
      // which triggers the deterministic provisioning fallback — stub it out.
      provisionMgaAssistantsFn: async () => ({ ok: true, created: [], error: null, skipped: true }),
      analyzeCascadeFn: () => null,
    },
  );
  assert.equal(iterResult.exitCode, 0, 'dispatchIterate succeeds');
  assert.equal(observedScope, 'backend',
    'dispatchIterate spawned scope=backend (matches affected_scopes[0])');
});

// ── PATH 2 — Low-confidence surface ──────────────────────────────────────

test('PATH 2 — low-confidence (0.45) → surface branch → diagnosis text, no dispatch', async () => {
  const session = makeSession();
  const phaseResult = await runInvestigatorPhase(session, 'page is blank', null, {
    runCustomAgentFn: makeStubRunCustomAgent(reportToCompletion(LOW_CONF_REPORT)),
  });
  assert.ok(phaseResult.ok, 'low-confidence report still validates; only the gate branches');
  assert.equal(phaseResult.report.confidence, 0.45);

  const decision = decideInvestigatorBranch(phaseResult.report);
  assert.equal(decision.branch, 'surface', 'confidence 0.45 < threshold → surface branch');
  assert.ok(typeof decision.surfaceText === 'string' && decision.surfaceText.length > 0);
  assert.match(decision.surfaceText, /Diagnosis/i, 'surface text starts with Diagnosis label');
  assert.match(decision.surfaceText, /confidence 0\.45/i, 'surface text echoes the confidence');
  assert.match(decision.surfaceText, /blank page|blank/i, 'surface text includes the root cause');
  assert.match(decision.surfaceText, /Recommended fix/i, 'surface text includes the recommended fix');
  assert.ok(!decision.synthetic, 'surface branch carries no synthetic routerResult');
});

// ── PATH 3 — Hard-guard write denial ─────────────────────────────────────

test('PATH 3 — INVESTIGATING phase hard-guards mutating tools, allows read-only', () => {
  const machine = new PhaseStateMachine({ initialPhase: PHASES.INVESTIGATING });

  const allowedTools = ['read_file', 'list_files', 'read_container_logs', 'read_harness_state', 'attempt_completion'];
  for (const tool of allowedTools) {
    assert.equal(machine.isToolAllowed(tool), true, `tool '${tool}' must be ALLOWED for INVESTIGATING`);
  }

  const deniedTools = [
    'write_to_file',
    'replace_in_file',
    'execute_command',
    'spawn_phase_agent',
    'spawn_phase_agent_background',
    'use_mcp_tool',
    'write_harness_state',
    'copy_template',
  ];
  for (const tool of deniedTools) {
    assert.equal(machine.isToolAllowed(tool), false, `tool '${tool}' MUST be DENIED for INVESTIGATING`);
    const msg = machine.getBlockedToolMessage(tool);
    assert.ok(msg.startsWith('ERROR:'), `deny message for '${tool}' must start with ERROR:`);
    assert.match(msg, /Investigator|INVESTIGATING/, `deny message for '${tool}' must reference investigator/phase`);
    assert.match(msg, new RegExp(tool), `deny message for '${tool}' must name the blocked tool`);
  }

  assert.equal(machine.isInvestigating(), true);
  assert.equal(machine.isSubagent(), false);
  assert.equal(machine.isOrchestrating(), false);
  assert.equal(machine.getAssistantRole(), 'investigator');

  const resolved = resolvePhaseAssistant(PHASES.INVESTIGATING, { creds: { investigatorAssistantId: 'stub-id' } });
  assert.equal(resolved.label, 'Investigator');
  assert.equal(resolved.assistantId, 'stub-id', 'resolvePhaseAssistant reads investigatorAssistantId from creds');
});
