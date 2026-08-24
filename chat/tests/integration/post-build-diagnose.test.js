/**
 * runDiagnoseAndRespond — post-build diagnose route coverage.
 *
 * Both the planner diagnose branch (Understanding agent → action='diagnose')
 * and the post-build concierge `diagnose` action funnel through the shared
 * runDiagnoseAndRespond helper. This verifies that helper end-to-end:
 *   - it forwards to the read-only investigator (phase=INVESTIGATING) and
 *     branches on confidence via decideInvestigatorBranch,
 *   - high-confidence → dispatches an auto-fix iterate (and auto-starts),
 *   - low-confidence  → surfaces a diagnosis, NO dispatch,
 *   - `emitTerminalIdle` gates the terminal status:idle SSE emit (the
 *     multi-action sequencer's race guard) while the in-memory session.status
 *     ALWAYS flips to 'idle'.
 *
 * Deps are injected (runCustomAgentFn forwarded to runInvestigatorPhase,
 * dispatchIterateFn / tryAutoStartAppFn overriding the auto-fix dispatch) so
 * no real subagents spawn or containers boot — mirrors investigator-paths.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runDiagnoseAndRespond } from '../../server/session/routes.js';
import { sessionEvents } from '../../server/session/events.js';
import { PHASES } from '../../server/agent/loop/phase.js';

// ── Synthetic investigator reports (same shape as investigator-paths.test.js) ──

const HIGH_CONF_REPORT = {
  root_cause: 'The /health route in backend dereferences pool.query without awaiting it, so Express responds 500.',
  affected_scopes: ['backend'],
  confidence: 0.85,
  recommended_fix: {
    scope: 'backend',
    description: 'Await pool.query in the /health handler before returning {ok:true}.',
    contract_change: null,
  },
  files_read: ['backend/src/index.ts'],
  logs_read: ['backend'],
};

const LOW_CONF_REPORT = {
  root_cause: 'Frontend shows a blank page; backend logs show only a 200. Cause could be a runtime JS error, CSS, or API misconfig — no single definitive signal.',
  affected_scopes: ['frontend'],
  confidence: 0.45,
  recommended_fix: {
    scope: 'frontend',
    description: 'Inspect frontend/src/App.tsx for a useEffect that throws on mount; add a fallback render.',
    contract_change: null,
  },
  files_read: ['frontend/src/App.tsx'],
  logs_read: ['frontend', 'backend'],
};

function reportToCompletion(report) {
  return JSON.stringify(report);
}

function makeStubRunCustomAgent(completionText) {
  return async (_sessionId, _prompt, opts) => {
    assert.equal(opts.phase, PHASES.INVESTIGATING,
      'runDiagnoseAndRespond must spawn the investigator with phase=INVESTIGATING');
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
    id: 'diag-test-' + Math.random().toString(36).slice(2, 8),
    coderConversationIds: {},
    coderTokenTotals: null,
    iterationQueue: [],
    lastActiveSubagentScope: null,
    cancelled: false,
  };
}

// Capture every sessionEvents 'event' for a given sessionId.
function captureEvents(sessionId) {
  const events = [];
  const handler = (sid, evt) => { if (sid === sessionId) events.push(evt); };
  sessionEvents.on('event', handler);
  return { events, stop: () => sessionEvents.off('event', handler) };
}

const ENV = { workspaceDir: '/tmp/nonexistent-diagnose-test', projectPhase: 'iterating' };

// ── PATH 1 — high-confidence → auto-fix dispatch ─────────────────────────────

test('high-confidence (0.85) → auto-fix: dispatches iterate for the affected scope', async () => {
  const session = makeSession();
  const cap = captureEvents(session.id);

  let dispatched = null;
  let autoStarted = false;

  await runDiagnoseAndRespond(
    session,
    { symptom: 'health endpoint returns 500', suspectedScope: 'backend', envContext: ENV, uploads: [], emitTerminalIdle: true },
    {
      runCustomAgentFn: makeStubRunCustomAgent(reportToCompletion(HIGH_CONF_REPORT)),
      dispatchIterateFn: async (_s, synthetic) => { dispatched = synthetic; return { exitCode: 0 }; },
      tryAutoStartAppFn: async () => { autoStarted = true; },
    },
  );
  cap.stop();

  assert.ok(dispatched, 'auto-fix branch dispatched an iterate');
  assert.equal(dispatched.action, 'iterate', 'synthetic routerResult has action=iterate');
  assert.deepEqual(dispatched.affectedScopes, ['backend'], 'iterate targets the affected scope');
  assert.ok(autoStarted, 'auto-start fired after a successful auto-fix iterate');

  // Terminal signal: with emitTerminalIdle=true the auto-fix path emits a
  // status:idle SSE. (The in-memory session.status flip is gated on the
  // active-session check, which a unit harness doesn't satisfy — the SSE emit
  // is the observable contract.)
  const idleEvents = cap.events.filter(e => e.type === 'status' && e.payload?.status === 'idle');
  assert.ok(idleEvents.length >= 1, 'auto-fix path emits a terminal status:idle SSE');
});

// ── PATH 2 — low-confidence → surface, no dispatch ───────────────────────────

test('low-confidence (0.45) → surface: diagnosis emitted, NO dispatch', async () => {
  const session = makeSession();
  const cap = captureEvents(session.id);

  let dispatched = false;
  await runDiagnoseAndRespond(
    session,
    { symptom: 'the page is blank', suspectedScope: null, envContext: ENV, uploads: [], emitTerminalIdle: true },
    {
      runCustomAgentFn: makeStubRunCustomAgent(reportToCompletion(LOW_CONF_REPORT)),
      dispatchIterateFn: async () => { dispatched = true; return { exitCode: 0 }; },
      tryAutoStartAppFn: async () => { throw new Error('auto-start must not run on the surface branch'); },
    },
  );
  cap.stop();

  assert.equal(dispatched, false, 'low-confidence must NOT dispatch an iterate');

  const clineTexts = cap.events
    .filter(e => e.type === 'cline' && e.payload?.say === 'text')
    .map(e => e.payload.text);
  assert.ok(clineTexts.some(t => /Diagnosis/i.test(t)),
    'a diagnosis surface text was emitted to the user');

  assert.equal(session.status, 'idle', 'session flips to idle after surface');
});

// ── PATH 3 — emitTerminalIdle gating (the sequencer race guard) ───────────────

test('emitTerminalIdle=false suppresses the terminal status:idle SSE but still flips in-memory status', async () => {
  const session = makeSession();
  const cap = captureEvents(session.id);

  await runDiagnoseAndRespond(
    session,
    { symptom: 'the page is blank', suspectedScope: null, envContext: ENV, uploads: [], emitTerminalIdle: false },
    {
      runCustomAgentFn: makeStubRunCustomAgent(reportToCompletion(LOW_CONF_REPORT)),
      dispatchIterateFn: async () => ({ exitCode: 0 }),
    },
  );
  cap.stop();

  const idleEvents = cap.events.filter(e => e.type === 'status' && e.payload?.status === 'idle');
  assert.equal(idleEvents.length, 0,
    'emitTerminalIdle=false → no status:idle SSE event (intermediate action in a multi-sequence)');
  assert.equal(session.status, 'idle',
    'in-memory session.status still flips to idle so the post-build gate stays consistent');
});

test('emitTerminalIdle=true emits exactly the terminal status:idle SSE', async () => {
  const session = makeSession();
  const cap = captureEvents(session.id);

  await runDiagnoseAndRespond(
    session,
    { symptom: 'the page is blank', suspectedScope: null, envContext: ENV, uploads: [], emitTerminalIdle: true },
    {
      runCustomAgentFn: makeStubRunCustomAgent(reportToCompletion(LOW_CONF_REPORT)),
      dispatchIterateFn: async () => ({ exitCode: 0 }),
    },
  );
  cap.stop();

  const idleEvents = cap.events.filter(e => e.type === 'status' && e.payload?.status === 'idle');
  assert.ok(idleEvents.length >= 1, 'emitTerminalIdle=true → a terminal status:idle SSE event fires');
});
