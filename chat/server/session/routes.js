import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getCredentials } from '../core/auth.js';
import { setSensitiveStrings } from '../util/redact.js';
import { tlog, terr } from '../util/timestamped-log.js';
import { appendEvent, readTail, readAll } from './transcript.js';
import { upsertSession, listSessions, removeSession, renameSession } from './session-index.js';
import { sessionEvents } from './events.js';
import {
  accumulateAgentTotals,
  restoreCoderTokenTotals,
  sanitiseUploadsPayload,
  loadTemplateWhitelist,
  killAllProcs,
  cancelScopedPhases,
  emitScopeStatus,
} from './lifecycle.js';
import { runCompose, tryAutoStartApp, runSmokeAndPrompt } from './docker-orchestration.js';
import { WORKSPACE_DIR, CHAT_APP_DIR, TRANSCRIPTS_DIR } from '../core/paths.js';
import { createSnapshot, restoreSnapshot, deleteSnapshotsFor, snapshotExists } from './snapshots.js';
import { listAppSecretValues } from '../core/app-secrets-scaffold.js';
import {
  BASH_SCRIPT_MS,
  COMPOSE_BUILD_MS,
  COMPOSE_UP_MS,
  COMPOSE_DOWN_MS,
  COMPOSE_DOWN_DEEP_MS,
  GIT_CHECKOUT_MS,
  INVESTIGATOR_AUTO_FIX_CONFIDENCE,
  INVESTIGATOR_PHASE_TIMEOUT_MS,
} from '../config/defaults.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { PHASES } from '../agent/loop/phase.js';
import { writeRunSummary } from '../util/run-summary.js';
import { setPendingPlanCheck } from '../util/stream.js';
import { savePendingPlan, loadPendingPlan, clearPendingPlan } from './pending-plan-store.js';
import { getSnippetFetchMirror } from '../util/telemetry-snippets.js';
import { getSessionRunLogsDir } from '../agent/compaction/run-logger.js';
import { runBuildDispatch } from '../agent/coordinator/build-dispatcher.js';
import { generateBuildSummary } from '../agent/coordinator/build-summary.js';
import { runConciergeTurn } from '../agent/concierge/concierge.js';
import { dispatchConciergeAction } from '../agent/concierge/handle-action.js';
import { runConciergeIterate } from '../agent/concierge/iterate-dispatcher.js';
import { normalizeConciergeDecision } from '../agent/concierge/normalize-action.js';
import { mountTraceRoutes } from './trace-routes.js';
import { mountApprovalRoutes } from './approval-routes.js';
import { gatherEnvContext, refreshEnvContext } from '../agent/context/env-context.js';
import { buildPromptFromSpec, buildScopedPrompt } from '../agent/prompt-builder/core.js';
import { routeMessage } from '../agent/planner/two-agent.js';
import { resolveFlags } from '../agent/context/flag-resolver.js';
import { migrateHarnessState } from './migrate-harness-state.js';
import {
  readContracts,
  readStateMd,
  writeStateMd,
  readBuilt,
  writeBuilt,
  parseBuiltFromStateMd,
} from './harness-state.js';
import { generateContractTypes } from '../agent/contract-types-generator.js';
import { analyzeCascade } from './contract-cascade.js';
import { ITERATE_MINIMAL_CHANGE_POLICY } from '../agent/iterate-policy.js';
import { mergeAndPersistIterateDiffs, normalizeContractDiffs, diffHasRemovals } from '../agent/coordinator/contract-store.js';
import { preStageScaffolds } from '../agent/coordinator/pre-stage-scaffolds.js';
import { logSafe } from '../util/log-helpers.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

// Session ids name files on disk (transcripts, shadow repos, run logs).
function cleanSessionId(raw) {
  const id = String(raw ?? '');
  if (!SESSION_ID_RE.test(id)) return null;
  return path.basename(id);
}

let activeSession = null;
let middlewareReady = false;


// Initialize env context in background
const __envContextStart = Date.now();
gatherEnvContext().then(() => {
  tlog('[middleware] Ready (%dms)', Date.now() - __envContextStart);
  middlewareReady = true;
}).catch(err => {
  logAndSwallow(err, '[session] Env context init failed (non-fatal)');
  middlewareReady = true; // still allow requests, will use fallback
});

// Cheap synchronous check used by the post-build concierge gate. We treat
// the presence of `.harness/state.md` as the signal that a build has
// completed (state.md is written by build-summary.js at the end of every
// successful build). readStateMd swallows ENOENT and returns null, so a
// throw here is a real IO error — we fail closed (skip concierge) to keep
// the planner path's behavior unchanged.
function safeHasHarnessStateMd() {
  try {
    return readStateMd(WORKSPACE_DIR) != null;
  } catch {
    return false;
  }
}

// Load the prior `{built, contract}` context needed by any iterate dispatch
// to write a non-clobbering state.md. priorBuilt seeds the merge so scopes
// not in this dispatch survive in state.md; priorContract carries stack /
// architecture info that a sparse iterate task spec lacks.
//
// Upgrade path: when built.json is absent (pre-Option-C workspace), parse
// the existing state.md once as fallback. The next write produces a real
// built.json so subsequent iterates take the fast read path. All reads
// are try-swallowed — a malformed file just degrades to an empty prior
// (current dispatch wins entirely), which mirrors pre-existing behaviour.
function loadPriorIterateContext(workspaceDir = WORKSPACE_DIR) {
  let priorBuilt = {};
  try {
    priorBuilt = readBuilt(workspaceDir) || {};
  } catch (err) {
    logAndSwallow(err, '[iterate-dispatch] readBuilt failed; falling back to state.md parse');
  }
  if (Object.keys(priorBuilt).length === 0) {
    try {
      const raw = readStateMd(workspaceDir);
      if (raw) priorBuilt = parseBuiltFromStateMd(raw);
    } catch (err) {
      logAndSwallow(err, '[iterate-dispatch] state.md fallback parse failed; using empty priorBuilt');
    }
  }
  let priorContract = null;
  try {
    const envelope = readContracts(workspaceDir);
    priorContract = envelope?.data || null;
  } catch (err) {
    logAndSwallow(err, '[iterate-dispatch] readContracts failed; stack derivation will be empty');
  }
  return { priorBuilt, priorContract };
}

// Lets the socket layer restore the plan-confirmation card on reconnect
// (stream.js history_batch) — the pending flag lives only on this map.
setPendingPlanCheck((sessionId) => Boolean(getSession(sessionId)?.pendingPlan));

function getSession(sessionId) {
  if (!activeSession || activeSession.id !== sessionId) return null;
  return activeSession;
}

// True iff a build-dispatcher result has at least one dispatched scope OR
// at least one recorded completion report. Used to gate the deterministic
// end-of-build summary so dispatch-mocking tests (which return only
// `{exitCode}`) and dispatcher early-exits (empty scope filter) don't
// clobber state.md with a "failed" placeholder.
function dispatchProducedScopes(result) {
  if (!result) return false;
  if (Array.isArray(result.dispatchedScopes) && result.dispatchedScopes.length > 0) return true;
  if (result.completionReports && Object.keys(result.completionReports).length > 0) return true;
  return false;
}

// W1.TEL Section M item 7 — typed user_action transcript events. Today the
// legacy generic `cline` events for these commands keep firing (back-compat
// for existing consumers); we ADD a typed `user_action` event alongside so
// downstream tools can filter on `action` without parsing text. Phase 4
// cleanup may eventually drop the duplicated cline event.
function emitUserAction(sessionId, action, metadata = {}) {
  try {
    const event = appendEvent(sessionId, 'user_action', {
      action,
      sessionId,
      ts: Date.now(),
      ...metadata,
    });
    sessionEvents.emit('event', sessionId, event);
  } catch (err) {
    logAndSwallow(err, '[telemetry-user-action]');
  }
}

// W2.CASCADE — Structured cascade events. Used by `runs-report.js`
// aggregation to answer "how often does the router emit incomplete
// affected_scopes" without code changes later.
//   type = 'cascade_escalation' — grep found refs in scopes outside the
//       router-emitted affected_scopes; payload includes routerEmittedScopes,
//       grepFoundScopes, escalatedTo, breakingIdentifiers[].
//   type = 'cascade_incomplete' — grep hit CASCADE_GREP_TIMEOUT_MS; payload
//       includes routerEmittedScopes + reason. Dispatch fails open.
function emitCascadeEvent(sessionId, type, payload = {}) {
  try {
    const event = appendEvent(sessionId, type, {
      type,
      sessionId,
      ts: Date.now(),
      ...payload,
    });
    sessionEvents.emit('event', sessionId, event);
  } catch (err) {
    logAndSwallow(err, '[telemetry-cascade]');
  }
}

// Post-Phase-2 — Structured router_soft_correct events. Drains a router
// result's `softCorrects[]` (each `{ field, from, to, reason }`) and emits
// one typed `router_soft_correct` transcript event per entry so runs-report.js
// can aggregate "how often does the router drop X". See HARNESS_EVOLUTION.md
// Section C "Soft-correct pattern" for the design contract — prompt-tightening
// is the primary fix; this defensive auto-correct is the safety net that
// stays visible in telemetry. logAndSwallow per L.5 — a failed telemetry
// write must never crash the build.
function emitRouterSoftCorrects(sessionId, routerResult) {
  const list = routerResult && Array.isArray(routerResult.softCorrects)
    ? routerResult.softCorrects
    : null;
  if (!list || list.length === 0) return;
  for (const sc of list) {
    try {
      const event = appendEvent(sessionId, 'router_soft_correct', {
        type: 'router_soft_correct',
        sessionId,
        ts: Date.now(),
        field: sc.field,
        from: sc.from,
        to: sc.to,
        reason: sc.reason,
      });
      sessionEvents.emit('event', sessionId, event);
    } catch (err) {
      logAndSwallow(err, '[telemetry-router-soft-correct]');
    }
  }
}

// W2.DISPATCH — valid subagent scopes for iterate dispatch routing. Mirrors
// the router's VALID_ITERATE_SCOPES set; kept local to avoid a cross-import
// cycle. Used by the iterate dispatch selector to bail on malformed router
// emits (router already coerces those to `execute`, but belt-and-braces).
const VALID_DISPATCH_SCOPES = new Set(['database', 'backend', 'frontend', 'vectordb', 'integration']);

// W3.INVEST — typed transcript events for the investigator path. Mirrors the
// shape of emitCascadeEvent / emitRouterSoftCorrects so runs-report.js can
// aggregate "how often does the diagnose path fire / auto-fix / surface" later.
// All writes wrap in logAndSwallow per L.5 — telemetry must never crash a build.
//
// Event types:
//   investigator_dispatch   — investigator spawned with { symptom, suspectedScope }
//   investigator_report     — investigator returned a parsed report
//   investigator_auto_fix   — confidence >= threshold; about to dispatch iterate
//   investigator_surface    — confidence < threshold; report surfaced to user
//   investigator_timeout    — wall-clock timeout fired
//   investigator_error      — agent threw / report unparseable / no JSON
function emitInvestigatorEvent(sessionId, type, payload = {}) {
  try {
    const event = appendEvent(sessionId, type, {
      type,
      sessionId,
      ts: Date.now(),
      ...payload,
    });
    sessionEvents.emit('event', sessionId, event);
  } catch (err) {
    logAndSwallow(err, '[telemetry-investigator]');
  }
}

/**
 * W3.TEL Section M item 11 — push a structured per-investigation record
 * onto `session.investigatorRecords[]`. The run-summary writer reads from
 * there at end-of-build. Record shape (verbatim from Section M item 11):
 *   { symptom, filesRead, logsRead, rootCause, confidence, recommendedFix }
 *
 * No separate jsonl file per the worker brief (#5) — these are run-summary
 * fields only. Wrapped in logAndSwallow per L.5 — same forward-compat
 * rationale as pushAutoRecoveryRecord.
 */
export function pushInvestigatorRecord(session, record) {
  if (!session) return;
  try {
    if (!Array.isArray(session.investigatorRecords)) {
      session.investigatorRecords = [];
    }
    session.investigatorRecords.push({
      symptom: typeof record.symptom === 'string' ? record.symptom.slice(0, 1000) : null,
      filesRead: Array.isArray(record.filesRead) ? record.filesRead : [],
      logsRead: Array.isArray(record.logsRead) ? record.logsRead : [],
      rootCause: typeof record.rootCause === 'string' ? record.rootCause.slice(0, 2000) : null,
      confidence: typeof record.confidence === 'number' ? record.confidence : null,
      recommendedFix: record.recommendedFix && typeof record.recommendedFix === 'object'
        ? {
            scope: record.recommendedFix.scope || null,
            description: typeof record.recommendedFix.description === 'string'
              ? record.recommendedFix.description.slice(0, 1000) : null,
            hasContractChange: !!record.recommendedFix.hasContractChange,
          }
        : null,
      ts: Date.now(),
    });
  } catch (err) {
    logAndSwallow(err, '[telemetry-investigator-record]');
  }
}

// W3.INVEST — exported helpers (used by chat/tests/agents/test-investigator-paths.js).
// `runInvestigatorPhase` drives the read-only investigator run + JSON parse +
// validation. The diagnose-branch wiring in the POST /message handler calls
// it inline; tests import it to verify both the parse path and the dispatch
// branch without needing a real MGA call.

// W3.INVEST — try to parse the investigator's structured JSON report out of
// the agent's `completionText`. Same brace-counting / fenced-block strategy
// the router uses (chat/server/agent/planner/router.js tryParseJSON) so an
// investigator that wraps its report in a ```json``` fence or includes a
// stray leading whitespace line still parses. Returns the parsed object on
// success, null on any parse failure.
export function tryParseInvestigatorReport(content) {
  if (!content || typeof content !== 'string' || !content.trim()) return null;
  // Strategy 1: direct parse.
  try { return JSON.parse(content.trim()); } catch { /* continue */ }
  // Strategy 2: strip fenced code block.
  const fence = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* continue */ }
  }
  // Strategy 3: balanced-brace scan from first `{`.
  const firstBrace = content.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0, inString = false, escape = false;
    for (let i = firstBrace; i < content.length; i++) {
      const ch = content[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(content.substring(firstBrace, i + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

// W3.INVEST — validate + normalise an investigator report into a stable shape.
// Returns { ok: true, report } when the report passes the structural rules
// (root_cause non-empty string, affected_scopes non-empty array of valid scopes,
// confidence in [0,1], recommended_fix.scope valid, recommended_fix.description
// non-empty); otherwise { ok: false, reason }.
export function validateInvestigatorReport(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  const rootCause = typeof raw.root_cause === 'string' ? raw.root_cause.trim() : '';
  if (!rootCause) return { ok: false, reason: 'missing root_cause' };
  const scopes = Array.isArray(raw.affected_scopes) ? raw.affected_scopes : [];
  const validScopes = scopes.filter(s => typeof s === 'string' && VALID_DISPATCH_SCOPES.has(s));
  if (validScopes.length === 0) return { ok: false, reason: 'no valid affected_scopes' };
  const confidence = (typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1)
    ? raw.confidence : null;
  if (confidence === null) return { ok: false, reason: 'confidence not in [0,1]' };
  const fix = raw.recommended_fix || {};
  const fixScope = typeof fix.scope === 'string' && VALID_DISPATCH_SCOPES.has(fix.scope) ? fix.scope : null;
  const fixDesc = typeof fix.description === 'string' ? fix.description.trim() : '';
  if (!fixScope) return { ok: false, reason: 'recommended_fix.scope invalid' };
  if (!fixDesc) return { ok: false, reason: 'recommended_fix.description missing' };
  return {
    ok: true,
    report: {
      root_cause: rootCause,
      affected_scopes: validScopes,
      confidence,
      recommended_fix: {
        scope: fixScope,
        description: fixDesc,
        contract_change: fix.contract_change || null,
      },
      files_read: Array.isArray(raw.files_read) ? raw.files_read.filter(p => typeof p === 'string') : [],
      logs_read: Array.isArray(raw.logs_read) ? raw.logs_read.filter(p => typeof p === 'string') : [],
    },
  };
}

// W3.INVEST — spawn the investigator agent for the diagnose path. Wraps
// runCustomAgent(PHASES.INVESTIGATING) with a wall-clock timeout
// (INVESTIGATOR_PHASE_TIMEOUT_MS) and best-effort JSON extraction from
// completionText. Returns:
//   { ok: true, report }                    — parsed + validated structured report
//   { ok: false, reason: 'timeout' }        — wall-clock exceeded
//   { ok: false, reason: 'no_completion' }  — agent didn't emit attempt_completion
//   { ok: false, reason: 'unparseable' }    — no JSON found in completionText
//   { ok: false, reason: 'invalid_report', detail } — JSON parsed but failed validation
//   { ok: false, reason: 'agent_threw', detail }    — runCustomAgent threw (logAndSwallow'd separately)
//
// `deps` (optional) lets tests inject a mocked `runCustomAgentFn`. Defaults
// to the real implementation.
export async function runInvestigatorPhase(session, symptom, suspectedScope, deps = {}) {
  // Build the spawn prompt. The investigator's system prompt mandates the
  // output schema; here we only relay the user's symptom + the router's
  // suspected_scope hint (if any). Keep it short — the investigator reads
  // .harness/state.md and the workspace for itself.
  const sym = (typeof symptom === 'string' && symptom.trim()) ? symptom.trim() : '<unspecified bug report>';
  const hint = suspectedScope ? `\n\nRouter's suspected scope (hint, not authoritative): ${suspectedScope}` : '';
  const spawnPrompt = [
    '=== INVESTIGATE ===',
    '',
    `Symptom (user's words): ${sym}${hint}`,
    '',
    'Orient via read_harness_state, inspect the relevant scope folder(s),',
    'fetch container logs for any suspect service, and emit your structured',
    'JSON report via attempt_completion. Do NOT mutate the workspace.',
    '=== END INVESTIGATE ===',
  ].join('\n');

  const runCustomAgent = deps.runCustomAgentFn
    || (await import('../agent/agent.js')).runCustomAgent;

  let timedOut = false;
  const timeoutPromise = new Promise(resolve => setTimeout(() => {
    timedOut = true;
    resolve({ __timeout: true });
  }, INVESTIGATOR_PHASE_TIMEOUT_MS));

  let result;
  try {
    result = await Promise.race([
      runCustomAgent(session.id, spawnPrompt, {
        conversationId: null,
        scope: null,
        phase: PHASES.INVESTIGATING,
        priorTokenTotals: session.coderTokenTotals || null,
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    logAndSwallow(err, '[investigator] runCustomAgent threw');
    return { ok: false, reason: 'agent_threw', detail: err.message };
  }

  if (timedOut || result?.__timeout) {
    return { ok: false, reason: 'timeout' };
  }

  if (!result || typeof result.completionText !== 'string' || !result.completionText.trim()) {
    return { ok: false, reason: 'no_completion' };
  }

  const parsed = tryParseInvestigatorReport(result.completionText);
  if (!parsed) {
    return { ok: false, reason: 'unparseable' };
  }

  const validation = validateInvestigatorReport(parsed);
  if (!validation.ok) {
    return { ok: false, reason: 'invalid_report', detail: validation.reason };
  }

  return { ok: true, report: validation.report };
}

// W3.INVEST — pure helper that decides what to do with a validated
// investigator report. Splits the auto-fix vs surface decision out of the
// request-handler so tests can drive it directly without spinning up the
// full POST /message pipeline. The handler in the message route ALSO
// implements this logic inline (it has to, for transcript-event sequencing
// + auto-start hooks), but this exported function gives tests + future
// callers a single source of truth for the gate.
//
// Returns:
//   { branch: 'auto_fix', synthetic }   — confidence >= threshold; caller
//                                         dispatches `synthetic` via
//                                         dispatchIterate.
//   { branch: 'surface', surfaceText }  — confidence <  threshold; caller
//                                         emits surfaceText as a cline say
//                                         and idles.
export function decideInvestigatorBranch(report, threshold = INVESTIGATOR_AUTO_FIX_CONFIDENCE) {
  if (report.confidence >= threshold) {
    const summary = `Auto-fix: ${report.recommended_fix.description.slice(0, 120)}`;
    const synthetic = {
      action: 'iterate',
      affectedScopes: report.affected_scopes,
      contractDiffs: report.recommended_fix.contract_change
        ? { [report.recommended_fix.contract_change.kind || 'misc']:
            report.recommended_fix.contract_change.diff || report.recommended_fix.contract_change }
        : {},
      message: summary,
      tasks: report.affected_scopes.map(scope => ({
        scope,
        summary,
        task: scope === report.recommended_fix.scope
          ? `Fix: ${report.recommended_fix.description}\n\n(Investigator root cause: ${report.root_cause})`
          : `Apply changes needed by the primary fix in scope=${report.recommended_fix.scope}:\n${report.recommended_fix.description}`,
        rules: [],
        snippets: [],
      })),
    };
    return { branch: 'auto_fix', synthetic };
  }
  const surfaceText = [
    `**Diagnosis** (confidence ${report.confidence.toFixed(2)}, below auto-fix threshold ${threshold}):`,
    '',
    report.root_cause,
    '',
    `**Recommended fix** (scope: ${report.recommended_fix.scope}):`,
    report.recommended_fix.description,
    '',
    'Reply to confirm this is the right fix, or rephrase the bug report with more detail.',
  ].join('\n');
  return { branch: 'surface', surfaceText };
}

// W3.INVEST — shared diagnose runner. Spawns the read-only investigator,
// emits the investigator_* telemetry, captures the run into
// session.investigatorRecords[], then either AUTO-FIXES (confidence >=
// INVESTIGATOR_AUTO_FIX_CONFIDENCE — synthesises an `iterate` and reuses
// dispatchIterate + tryAutoStartApp) or SURFACES the diagnosis for the user
// to act on. Single source of truth for the diagnose path, called from BOTH:
//   - the planner branch (Understanding agent → routerResult.action='diagnose')
//   - the post-build concierge `diagnose` action
// All dispatch helpers it uses (dispatchIterate, tryAutoStartApp,
// maybeDrainIterationQueue, dispatchQueuedMessage) are module-level, so the
// only per-call context is the params below.
//
// `emitTerminalIdle` (default true) controls whether the terminal
// `status:idle` SSE event (and the iteration-queue drain) fire. The in-memory
// `session.status` ALWAYS flips to 'idle' so the post-build gate stays
// consistent; only the SSE emit is suppressed when false. The post-build
// multi-action sequencer passes false on non-last actions so an intermediate
// diagnose doesn't signal "turn complete" early — same race guard as
// dispatchIterateAndFinalize's emitTerminalIdle.
export async function runDiagnoseAndRespond(
  session,
  { symptom = '', suspectedScope = null, envContext, uploads = [], emitTerminalIdle = true } = {},
  deps = {},
) {
  // deps (optional, for tests): `runCustomAgentFn` is forwarded to
  // runInvestigatorPhase; `dispatchIterateFn` / `tryAutoStartAppFn` override
  // the auto-fix dispatch so the branch can be asserted without spawning real
  // subagents. Production passes none → the real implementations are used.
  const dispatchIterateFn = deps.dispatchIterateFn || dispatchIterate;
  const tryAutoStartAppFn = deps.tryAutoStartAppFn || tryAutoStartApp;
  tlog('[session] diagnose: symptom=%s suspected_scope=%s — spawning investigator',
    logSafe(symptom.slice(0, 80)), logSafe(suspectedScope || 'none'));

  // Surface dispatch activity to the UI so the user sees we're
  // working on the bug report (analogous to the iterate-acknowledge
  // event for execute/iterate paths).
  const investStartEvent = appendEvent(session.id, 'cline', {
    say: 'text',
    text: `Investigating: ${symptom.slice(0, 160)}${symptom.length > 160 ? '…' : ''}`,
  });
  sessionEvents.emit('event', session.id, investStartEvent);

  emitInvestigatorEvent(session.id, 'investigator_dispatch', {
    symptom: symptom.slice(0, 500),
    suspectedScope,
  });

  // Reset router conversation — next user message starts a fresh
  // routing pass against post-investigation state.
  session.routerConversationId = null;
  session.routerMessages = [];
  session.clarifyRound = 0;

  const investStart = Date.now();
  const investResult = await runInvestigatorPhase(session, symptom, suspectedScope, deps);
  const investWallMs = Date.now() - investStart;

  if (!investResult.ok) {
    if (investResult.reason === 'timeout') {
      tlog('[session] Investigator timed out after %dms (cap %dms)',
        investWallMs, INVESTIGATOR_PHASE_TIMEOUT_MS);
      emitInvestigatorEvent(session.id, 'investigator_timeout', { wallMs: investWallMs });
    } else {
      tlog('[session] Investigator error: reason=%s detail=%s',
        investResult.reason, investResult.detail || 'n/a');
      emitInvestigatorEvent(session.id, 'investigator_error', {
        message: investResult.detail
          ? `${investResult.reason}: ${investResult.detail}`
          : investResult.reason,
      });
    }
    // Surface a generic apology + ask the user to retry. Don't
    // fall through to execute — that would re-plan from scratch
    // and likely produce the same bug.
    const failEvent = appendEvent(session.id, 'cline', {
      say: 'text',
      text: 'Investigation did not complete. Please rephrase the bug report with more detail, or try again.',
    });
    sessionEvents.emit('event', session.id, failEvent);
    session.status = 'idle';
    if (emitTerminalIdle) {
      const idleEvt = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, idleEvt);
    }
    upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
    return;
  }

  const report = investResult.report;
  tlog('[session] Investigator → confidence=%.2f scopes=[%s] fix.scope=%s files=%d logs=%d (%dms)',
    report.confidence, report.affected_scopes.join(','),
    report.recommended_fix.scope,
    report.files_read.length, report.logs_read.length, investWallMs);

  emitInvestigatorEvent(session.id, 'investigator_report', {
    rootCause: report.root_cause.slice(0, 1000),
    affectedScopes: report.affected_scopes,
    confidence: report.confidence,
    recommendedFix: {
      scope: report.recommended_fix.scope,
      description: report.recommended_fix.description.slice(0, 500),
      hasContractChange: report.recommended_fix.contract_change != null,
    },
    filesReadCount: report.files_read.length,
    logsReadCount: report.logs_read.length,
  });

  // W3.TEL Section M item 11 — capture the full report into
  // session.investigatorRecords[] for the run-summary writer.
  pushInvestigatorRecord(session, {
    symptom,
    filesRead: report.files_read,
    logsRead: report.logs_read,
    rootCause: report.root_cause,
    confidence: report.confidence,
    recommendedFix: {
      scope: report.recommended_fix.scope,
      description: report.recommended_fix.description,
      hasContractChange: report.recommended_fix.contract_change != null,
    },
  });

  const decision = decideInvestigatorBranch(report);

  if (decision.branch === 'auto_fix') {
    // High-confidence: auto-fix. Reuse the existing W2.DISPATCH
    // path (single-scope direct OR orchestrator-with-diffs, picked from
    // affected_scopes.length). coderConversationIds[scope] reuse is
    // preserved by dispatchIterate.
    emitInvestigatorEvent(session.id, 'investigator_auto_fix', {
      confidence: report.confidence,
      affectedScopes: report.affected_scopes,
    });

    tlog('[session] Investigator auto-fix dispatch: scopes=[%s] primary=%s',
      decision.synthetic.affectedScopes.join(','), report.recommended_fix.scope);

    const iterStart = Date.now();
    const iterResult = await dispatchIterateFn(session, decision.synthetic, envContext, uploads);
    tlog('[session] Investigator-driven iterate finished (%dms, exit=%s)',
      Date.now() - iterStart, iterResult.exitCode);

    // Auto-start on success (same oracle as the iterate path).
    if (iterResult.exitCode === 0 && !session.cancelled) {
      try {
        await tryAutoStartAppFn(session, envContext, {
          dataModel: null, apiContract: null, uiContract: null,
          businessLogicContract: null,
          tasks: decision.synthetic.tasks,
        });
      } catch (err) { logAndSwallow(err, '[session] Investigator-driven auto-start failed (non-fatal)'); }
    }

    if (activeSession?.id === session.id) {
      session.hasExecuted = true;
      session.status = 'idle';
      upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
    }
    if (emitTerminalIdle) {
      const idleEvt = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, idleEvt);
      maybeDrainIterationQueue(session, dispatchQueuedMessage);
    }
    return;
  }

  // Low-confidence: surface diagnosis to the user without
  // auto-dispatching. The user reads the root cause + the
  // recommended fix and decides whether to /confirm or rephrase.
  emitInvestigatorEvent(session.id, 'investigator_surface', {
    confidence: report.confidence,
  });

  const surfaceEvent = appendEvent(session.id, 'cline', {
    say: 'text',
    text: decision.surfaceText,
  });
  sessionEvents.emit('event', session.id, surfaceEvent);

  session.status = 'idle';
  if (emitTerminalIdle) {
    const idleEvt = appendEvent(session.id, 'status', { status: 'idle' });
    sessionEvents.emit('event', session.id, idleEvt);
  }
  upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
}

// W1.TEL Section M item 6 — aggregate per-call costUsd + tokens + MGA-call
// counts from the per-session run-logs (set up by run-logger.js) so the
// run-summary writer can populate the totals without us threading another
// accumulator through agent.js. Best-effort; returns zeros + null costUsd on
// any read/parse failure.
function aggregateSessionLlmStats(sessionId, { sinceTs = null } = {}) {
  // sinceTs (ms epoch): only count calls at/after this time — run summaries
  // pass the run's startedAt so tokens/cost are PER RUN. Without it a
  // cosmetic iterate late in a session reported the whole session's tokens
  // (observed: 1.6M "for" a title change), which poisons benchmark math.
  const result = { mgaCalls: 0, costUsd: 0, costKnown: false, tokens: { prompt: 0, completion: 0, cached: 0, total: 0 }, toolCalls: 0 };
  try {
    const sessionDir = getSessionRunLogsDir(sessionId);
    if (!sessionDir || !existsSync(sessionDir)) return result;
    const phaseDirs = readdirSync(sessionDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(sessionDir, d.name));
    for (const phaseDir of phaseDirs) {
      const llmFile = path.join(phaseDir, 'llm-calls.jsonl');
      if (existsSync(llmFile)) {
        const lines = readFileSync(llmFile, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.kind !== 'response') continue;
          if (sinceTs && entry.ts && Date.parse(entry.ts) < sinceTs) continue;
          result.mgaCalls += 1;
          if (typeof entry.costUsd === 'number') {
            result.costUsd += entry.costUsd;
            result.costKnown = true;
          }
          if (entry.usage) {
            const u = entry.usage;
            result.tokens.prompt += u.prompt_tokens || 0;
            result.tokens.completion += u.completion_tokens || 0;
            result.tokens.cached += u.prompt_tokens_details?.cached_tokens
              || u.cache_read_input_tokens || u.cached_tokens || 0;
            result.tokens.total += u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
          }
        }
      }
      const toolFile = path.join(phaseDir, 'tool-calls.jsonl');
      if (existsSync(toolFile)) {
        const lines = readFileSync(toolFile, 'utf-8').split('\n').filter(Boolean);
        result.toolCalls += lines.length;
      }
    }
  } catch (err) {
    logAndSwallow(err, '[telemetry-run-summary-aggregate]');
  }
  return result;
}

// W2.DISPATCH — iterate dispatch shape selector. Reads the router's iterate
// emit and branches:
//   - affected_scopes.length === 1 → direct subagent spawn, reusing
//     `coderConversationIds[scope]` so the subagent picks up its prior
//     conversation state (incremental edit, full file context already in
//     mind). This is the Phase C continuation pattern, generalized to any
//     iterate emit (not just same-scope continuations).
//   - affected_scopes.length >= 2 → orchestrator-with-diffs path. The
//     orchestrator's iterate-mode dispatch only fans out to affected scopes
//     and scope-gates contract_diffs per spawn message.
//
// Returns the same shape `runLlmOrchestrator` returns: { exitCode,
// completionReports?, error? } — caller (the message handler) uses the
// exitCode to decide auto-start + status-flip.
//
// Contract: routerResult.action === 'iterate' AND routerResult.affectedScopes
// is non-empty (router validator already coerces malformed iterate emits to
// `execute`, so callers don't need to re-validate).
//
// `deps` (optional) lets tests inject mocked `runCustomAgentFn` and
// `runLlmOrchestratorFn`. Defaults to the real implementations.
export async function dispatchIterate(session, routerResult, envContext, uploads, deps = {}) {
  const scopes = routerResult.affectedScopes || [];
  const contractDiffs = routerResult.contractDiffs || {};
  const summary = (routerResult.message && routerResult.message.trim())
    || (routerResult.tasks?.[0]?.summary)
    || 'iteration';
  const tasks = Array.isArray(routerResult.tasks) ? routerResult.tasks : [];

  // Defensive: scopes outside the valid subagent set should never reach here
  // (router validator filters them), but if they do, fall back to a
  // multi-scope orchestrator dispatch with the filtered set so dispatch
  // doesn't no-op silently.
  let filteredScopes = scopes.filter(s => VALID_DISPATCH_SCOPES.has(s));
  if (filteredScopes.length === 0) {
    tlog('[iterate-dispatch] no valid scopes in affected_scopes=[%s] — bailing', scopes.join(','));
    return { exitCode: 1, error: 'No valid scopes in iterate affected_scopes' };
  }

  // W2.CASCADE — Contract cascade. For BREAKING diffs (renamed/removed/
  // retyped contract items), grep the workspace for occurrences of the
  // affected identifiers. If matches surface in scopes NOT in
  // `affected_scopes`, escalate (add them to the dispatch set) so silent
  // breakage (e.g. router emits [database, backend] for a column rename
  // but `<UserCard>` still references the old column in frontend/) is
  // surfaced before the iterate runs. Fail-open on any error.
  try {
    // Allow tests to inject a mocked cascade analyzer; default is the real
    // implementation in contract-cascade.js.
    const analyzeFn = deps.analyzeCascadeFn || analyzeCascade;
    let priorContracts = null;
    try {
      const envelope = readContracts(envContext?.workspaceDir || WORKSPACE_DIR);
      priorContracts = envelope?.data || null;
    } catch (err) {
      logAndSwallow(err, '[cascade] readContracts failed; cascade running with empty prior');
    }
    const cascade = analyzeFn({
      workspaceDir: envContext?.workspaceDir || WORKSPACE_DIR,
      contractDiffs,
      affectedScopes: filteredScopes,
      priorContracts,
    });

    if (cascade && cascade.incomplete) {
      tlog('[cascade] grep incomplete (timed out); proceeding with router-emitted scopes=[%s]',
        filteredScopes.join(','));
      emitCascadeEvent(session.id, 'cascade_incomplete', {
        routerEmittedScopes: cascade.originalScopes,
        reason: 'grep-timeout',
      });
    } else if (cascade && cascade.escalatedScopes && cascade.escalatedScopes.length > 0) {
      tlog('[cascade] router emitted scopes=[%s] but grep found refs in scopes=[%s]; escalating to [%s]',
        cascade.originalScopes.join(','),
        cascade.escalatedScopes.join(','),
        cascade.finalScopes.join(','));
      emitCascadeEvent(session.id, 'cascade_escalation', {
        routerEmittedScopes: cascade.originalScopes,
        grepFoundScopes: cascade.escalatedScopes,
        escalatedTo: cascade.finalScopes,
        reason: 'router-miss',
        breakingIdentifiers: cascade.escalationReasons,
      });
      filteredScopes = cascade.finalScopes.filter(s => VALID_DISPATCH_SCOPES.has(s));
    }
  } catch (err) {
    logAndSwallow(err, '[cascade] dispatchIterate cascade pre-check failed (fail-open)');
  }

  // MGA provisioning runs BEFORE the single-vs-multi-scope branch: the
  // credentials-fix iterate typically scopes to integration alone and takes
  // the single-scope direct path, which previously returned before the
  // provisioning block ever ran (observed live — routing fixed, .env still
  // never written).
  let iterateSpecs = Array.isArray(routerResult.mgaAssistants) ? routerResult.mgaAssistants : [];
  // Deterministic fallback — prompt-spec compliance is soft: observed live,
  // the contract agent emitted env-wiring rules but omitted mga_assistants,
  // leaving an app whose code calls MGA with no assistant and no creds. If
  // the MGA client is on disk and no assistant credential exists, synthesize
  // a default spec; provisioning + .env write follow the normal path.
  if (iterateSpecs.length === 0) {
    try {
      const codeCallsMga = existsSync(path.join(WORKSPACE_DIR, 'backend/src/lib/mga-client.ts'))
        || existsSync(path.join(WORKSPACE_DIR, 'backend/src/mga_client.py'));
      let envText = '';
      try { envText = readFileSync(path.join(WORKSPACE_DIR, '.env'), 'utf-8'); } catch { /* no .env */ }
      if (codeCallsMga && !/^MGA_ASSISTANT_ID=/m.test(envText)) {
        iterateSpecs = [{
          name: 'App assistant',
          key: 'default',
          model: 'claude-opus-4.7',
          description: summary || "AI assistant backing this app's AI features",
        }];
        tlog('[iterate-dispatch] app code calls MGA but no assistant credential exists — synthesized default assistant spec (contract agent emitted none)');
      }
    } catch (err) { logAndSwallow(err, '[iterate-dispatch] mga fallback detection failed'); }
  }
  if (iterateSpecs.length > 0) {
    let existingEnv = '';
    try { existingEnv = readFileSync(path.join(WORKSPACE_DIR, '.env'), 'utf-8'); } catch { /* no .env */ }
    const needed = iterateSpecs.filter((spec) => {
      const upperKey = String(spec?.key || '').toUpperCase();
      if (/^MGA_ASSISTANT_ID=/m.test(existingEnv) && (!upperKey || new RegExp(`^MGA_ASSISTANT_ID(_${upperKey})?=`, 'm').test(existingEnv))) return false;
      return true;
    });
    if (needed.length > 0) {
      tlog('[iterate-dispatch] provisioning %d MGA assistant(s) introduced by this iterate', needed.length);
      const provisionMgaAssistants = deps.provisionMgaAssistantsFn
        || (await import('./mga-provisioning.js')).provisionMgaAssistants;
      let provContracts = { apiContract: null, dataModel: null, businessLogicContract: null, uiContract: null };
      try {
        const envData = readContracts(WORKSPACE_DIR)?.data;
        if (envData) provContracts = { apiContract: envData.apiContract || null, dataModel: envData.dataModel || null, businessLogicContract: envData.businessLogicContract || null, uiContract: envData.uiContract || null };
      } catch { /* envelope optional for prompt-writer */ }
      const prov = await provisionMgaAssistants(session, needed, provContracts, { getCredentials });
      if (prov.ok && !prov.skipped) {
        // Stage the canonical locked MGA client, overwriting any hand-rolled
        // one. An app born non-AI never went through fresh-build pre-stage,
        // so its agent hand-rolled a client (observed live: an OpenAI-style
        // /v1/chat/completions path → MGA 404 → silent template fallback).
        try {
          const { generateMgaClient } = await import('../agent/coordinator/mga-client-generator.js');
          const backendIsPython = existsSync(path.join(WORKSPACE_DIR, 'backend/src/main.py'));
          const client = generateMgaClient({
            flags: ['ai-chat'],
            mgaAssistants: needed,
            tasks: [{ scope: 'backend', dockerfile: backendIsPython ? 'Dockerfile.python' : 'Dockerfile.node' }],
          });
          if (client) {
            mkdirSync(path.dirname(path.join(WORKSPACE_DIR, client.relPath)), { recursive: true });
            writeFileSync(path.join(WORKSPACE_DIR, client.relPath), client.source);
            tlog('[iterate-dispatch] staged canonical MGA client at %s (replaces any hand-rolled client)', client.relPath);
          }
        } catch (err) { logAndSwallow(err, '[iterate-dispatch] canonical mga-client staging failed'); }
      }
      if (!prov.ok) {
        const event = appendEvent(session.id, 'cline', {
          say: 'text',
          text: `[mga] ${prov.error}\n\nThis change needs a working MGA assistant. Iteration aborted before code generation — check MGA connectivity and try again.`,
        });
        sessionEvents.emit('event', session.id, event);
        return { exitCode: 1, error: prov.error };
      }
    }
  }

  // ── Single-scope direct dispatch ───────────────────────────────────────
  if (filteredScopes.length === 1) {
    const scope = filteredScopes[0];
    // Find the matching task entry from the router output; fall back to a
    // synthesized one when the router emitted contracts but no per-scope
    // task spec (the router prompt requires tasks[] on iterate, but the
    // validator only requires affected_scopes — be defensive).
    const matchingTask = tasks.find(t => t && t.scope === scope) || {
      scope,
      summary,
      task: summary,
      rules: [],
      snippets: [],
    };

    const priorConvo = (session.coderConversationIds && session.coderConversationIds[scope]) || null;
    if (!priorConvo) {
      tlog('[iterate-dispatch] single-scope reuse: no prior coderConversationId for scope=%s — fresh subagent spawn',
        scope);
    } else {
      tlog('[iterate-dispatch] single-scope direct: scope=%s convo=%s (skipping orchestrator)',
        scope, priorConvo);
    }

    // Merge the iterate's contract diffs into the on-disk envelope BEFORE the
    // spawn. This path bypasses build-dispatcher/setOrchestrationContext, so
    // without this the envelope stays pre-iterate and every later consumer
    // (types regen, probe, visual check, a future full-rewrite fix) sees an
    // app without this iterate's additions.
    const persisted = mergeAndPersistIterateDiffs(WORKSPACE_DIR, contractDiffs, { summary });

    // Regenerate contract types + api-client from the merged envelope BEFORE
    // the spawn — the multi-scope path does this via preStageScaffolds, but
    // this path previously regenerated types only post-agent and the
    // api-client never, so the agent authored against pre-iterate generated
    // files (and a retired endpoint lived on in api-client.ts).
    if (persisted.merged && persisted.changes.length) {
      try {
        preStageScaffolds({
          workspaceDir: WORKSPACE_DIR,
          contract: persisted.merged,
          isIterate: true,
          iterateDiffs: contractDiffs,
        });
      } catch (err) {
        logAndSwallow(err, '[iterate-dispatch] single-scope pre-spawn regen failed');
      }
    }

    // Build the spawn-style user message with iterate diffs inlined so the
    // subagent treats them as authoritative changes on top of its prior code.
    const iterateBlock = buildIterateDiffsBlock(scope, summary, contractDiffs);
    const enrichedMessage = (() => {
      const base = buildPromptFromSpec({ tasks: [matchingTask] }, envContext, { uploads });
      return iterateBlock ? `${base}\n\n${iterateBlock}` : base;
    })();

    emitScopeStatus(session.id, { scope, status: 'running' });
    const runCustomAgent = deps.runCustomAgentFn
      || (await import('../agent/agent.js')).runCustomAgent;
    let result;
    try {
      result = await runCustomAgent(session.id, enrichedMessage, {
        conversationId: priorConvo,
        scope,
        priorTokenTotals: session.coderTokenTotals || null,
        phase: PHASES.SUBAGENT,
      });
    } catch (err) {
      logAndSwallow(err, '[iterate-dispatch] single-scope runCustomAgent threw');
      emitScopeStatus(session.id, { scope, status: 'failed' });
      return { exitCode: 1, error: err.message };
    }

    // Persist returned conversation_id back so subsequent iterations on the
    // same scope continue the same subagent thread. Mirrors the Phase C
    // continuation pattern in /confirm.
    if (result.conversationId) {
      session.coderConversationIds = session.coderConversationIds || {};
      session.coderConversationIds[scope] = result.conversationId;
    }
    accumulateAgentTotals(session, result);
    emitScopeStatus(session.id, { scope, status: 'completed', exitCode: result.exitCode });

    // Tag last-active scope for the existing Phase C continuation logic so a
    // subsequent same-scope `execute` (via /confirm) keeps reusing the convo.
    if (result.exitCode === 0) {
      session.lastActiveSubagentScope = scope;
    }

    // End-of-build authoring for single-scope iterate. The multi-scope path
    // below does this via the shared `dispatchProducedScopes` block at the
    // function tail; single-scope returns early so we inline it here. Without
    // this, state.md keeps the pre-iterate snapshot and the next post-build
    // concierge call answers from stale ground truth (Sm-3 turn 3 fails on
    // "what color is the button now?" because state.md still says blue).
    if (result.completionText) {
      try {
        const { priorBuilt, priorContract } = loadPriorIterateContext(WORKSPACE_DIR);
        // Merge the per-iterate task spec onto the prior full contract so
        // deriveStack still has dataModel/apiContract/etc. to read from
        // (the sparse `{tasks: [matchingTask]}` we'd otherwise pass has
        // none of that and state.md's Stack section would come out empty).
        const fullContract = { ...(priorContract || {}), tasks: [matchingTask] };
        const { stateMd, buildReport, built } = generateBuildSummary({
          contract: fullContract,
          completionReports: { [scope]: result.completionText },
          dispatchedScopes: [scope],
          iterate: { summary, contractDiffs, affectedScopes: [scope] },
          priorBuilt,
        });
        try { writeStateMd(WORKSPACE_DIR, stateMd); }
        catch (err) { logAndSwallow(err, '[iterate-dispatch] writeStateMd (single-scope) failed'); }
        try { writeBuilt(WORKSPACE_DIR, built); }
        catch (err) { logAndSwallow(err, '[iterate-dispatch] writeBuilt (single-scope) failed'); }
        try { generateContractTypes(WORKSPACE_DIR); }
        catch (err) { logAndSwallow(err, '[iterate-dispatch] generateContractTypes (single-scope) failed'); }
        const reportEvent = appendEvent(session.id, 'cline', {
          say: 'completion_result',
          text: buildReport,
        });
        sessionEvents.emit('event', session.id, reportEvent);
      } catch (err) {
        logAndSwallow(err, '[iterate-dispatch] build summary (single-scope) failed');
      }
    }

    return {
      exitCode: result.exitCode || 0,
      completionReports: result.completionText ? { [scope]: result.completionText } : {},
      dispatchedScopes: [scope],
    };
  }

  // ── Multi-scope orchestrator-with-diffs dispatch ───────────────────────
  tlog('[iterate-dispatch] multi-scope orchestrator: scopes=[%s] diffs=%s',
    filteredScopes.join(','), Object.keys(contractDiffs).join(',') || 'none');

  // Synthesize tasks for any affected scope the router didn't emit a task
  // for, so the orchestrator has a per-scope handle for every affected
  // scope. The summary is the iterate framing.
  const taskByScope = Object.fromEntries(
    tasks.filter(t => t && t.scope).map(t => [t.scope, t])
  );
  const orchestratorTasks = filteredScopes.map(scope => taskByScope[scope] || {
    scope,
    summary,
    task: summary,
    rules: [],
    snippets: [],
  });

  const dispatchFn = deps.runBuildDispatchFn || runBuildDispatch;
  const iteratePayload = {
    summary,
    contractDiffs,
    affectedScopes: filteredScopes,
  };
  // Load the prior contract from `.harness/contracts.json` and pass its
  // dataModel/apiContract/etc. into runBuildDispatch. Without this,
  // build-dispatcher calls setOrchestrationContext with these fields
  // defaulted to null, which (per orchestration-stash.js:103) REWRITES
  // contracts.json with null data — clobbering the initial-build contract.
  // Downstream effects:
  //   - generateContractTypes regenerates generated/contracts.ts from the
  //     now-empty contracts.json → loses User/Task/etc. type exports
  //   - backend tsc fails next compose build (TS2305 on the stale imports)
  //   - smoke t-postbuild-multi-scope-iterate caught this exact failure
  // The iterate's contractDiffs convey the per-scope CHANGES; the full
  // contract preserved here is what the rest of the codebase reads from
  // disk as the current "shape of the app." Both are needed.
  const { priorContract: iteratePriorContract } = loadPriorIterateContext(WORKSPACE_DIR);

  // Mid-life MGA provisioning: an iterate that introduces the app's FIRST
  // AI feature carries mga_assistants from the contract agent. Provision
  // them + write MGA_* into .env BEFORE agents spawn (mirrors /confirm).
  // Skip specs whose assistant already exists (env var present) — an
  // iterate refining an existing AI feature must not create duplicates.

  const result = await dispatchFn(orchestratorTasks, envContext, session, {
    uploads,
    dataModel: iteratePriorContract?.dataModel || null,
    apiContract: iteratePriorContract?.apiContract || null,
    vectorEngine: iteratePriorContract?.vectorEngine || null,
    uiContract: iteratePriorContract?.uiContract || null,
    businessLogicContract: iteratePriorContract?.businessLogicContract || null,
    // Iterate-mode payload — phase-tools.js spawn handlers read this from
    // the orchestration stash and inject scope-gated contract_diffs into
    // each subagent's user message rather than full contracts.
    iterate: iteratePayload,
  });

  // Deterministic end-of-build authoring — replaces the LLM orchestrator's
  // write_harness_state tool call + the LLM-authored build report. Same
  // pattern as the /confirm handler; identical telemetry-class swallowing.
  // Guard: skip when the dispatch produced no scopes (test mocks return
  // {exitCode:0} only; real dispatcher returns dispatchedScopes:[] when
  // filtered down to nothing — in either case there's no completion data
  // to summarize and writing a "failed" placeholder would clobber prior
  // state.md content).
  if (dispatchProducedScopes(result)) {
    try {
      const { priorBuilt, priorContract } = loadPriorIterateContext(WORKSPACE_DIR);
      const fullContract = { ...(priorContract || {}), tasks: orchestratorTasks };
      const { stateMd, buildReport, built } = generateBuildSummary({
        contract: fullContract,
        completionReports: result.completionReports,
        dispatchedScopes: result.dispatchedScopes,
        iterate: iteratePayload,
        priorBuilt,
      });
      try { writeStateMd(WORKSPACE_DIR, stateMd); }
      catch (err) { logAndSwallow(err, '[iterate-dispatch] writeStateMd failed'); }
      try { writeBuilt(WORKSPACE_DIR, built); }
      catch (err) { logAndSwallow(err, '[iterate-dispatch] writeBuilt failed'); }
      try { generateContractTypes(WORKSPACE_DIR); }
      catch (err) { logAndSwallow(err, '[iterate-dispatch] generateContractTypes failed'); }
      const reportEvent = appendEvent(session.id, 'cline', {
        say: 'completion_result',
        text: buildReport,
      });
      sessionEvents.emit('event', session.id, reportEvent);
    } catch (err) {
      logAndSwallow(err, '[iterate-dispatch] build summary generation failed');
    }
  }

  return result;
}

/**
 * Post-dispatch finalization shared by every iterate path — planner-driven
 * (routeMessage emits action='iterate'), concierge-driven (concierge emits
 * dispatch_iterate → runConciergeIterate synthesizes the routerResult), and
 * investigator-driven (auto-fix synthetic).
 *
 * Resets router conversation state (next user message routes fresh),
 * emits the dispatch ack as a cline event, calls dispatchIterate, runs
 * tryAutoStartApp on success, writes the run summary, flips session.status
 * back to 'idle' + emits the status event, and drains any queued messages
 * that arrived while the iterate was in flight.
 *
 * Both call sites supply the same envelope — `routerResult` with
 * action='iterate' + affectedScopes + contractDiffs + message + tasks.
 * Behavior is identical from here on, so keeping a single helper prevents
 * drift between the planner and concierge iterate paths.
 */
async function dispatchIterateAndFinalize(session, routerResult, envContext, uploads, opts = {}) {
  // emitTerminalIdle defaults true: emit status:idle + drain queue at the
  // end of THIS iterate. The concierge multi-iterate handler passes false
  // for all but the LAST iterate in the sequence so the smoke harness
  // (and any other status:idle observer) doesn't race ahead and send a
  // new turn while later iterates in the sequence are still queued. The
  // final iterate keeps the default so the session reliably returns to
  // idle exactly once per multi.
  const emitTerminalIdle = opts.emitTerminalIdle !== false;
  // Reset router conversation — next user message starts a fresh routing
  // pass against the post-iteration .harness/ state.
  session.routerConversationId = null;
  session.routerMessages = [];
  session.clarifyRound = 0;

  const iterateStart = Date.now();
  tlog('[session] Iterate dispatch start: scopes=[%s] diffs=%s summary=%s',
    (routerResult.affectedScopes || []).join(','),
    Object.keys(routerResult.contractDiffs || {}).join(',') || 'none',
    (routerResult.message || '').slice(0, 80));

  // Acknowledge to the user via a cline event so the UI shows dispatch
  // is happening (analogous to the execute summary).
  if (routerResult.message) {
    const iterEvent = appendEvent(session.id, 'cline', {
      say: 'text',
      text: routerResult.message,
    });
    sessionEvents.emit('event', session.id, iterEvent);
  }

  const iterResult = await dispatchIterate(session, routerResult, envContext, uploads || []);
  tlog('[session] Iterate dispatch finished (%dms, exit=%s)',
    Date.now() - iterateStart, iterResult.exitCode);

  // Auto-start the app on success — same oracle as /confirm.
  if (iterResult.exitCode === 0 && !session.cancelled) {
    try {
      await tryAutoStartApp(session, envContext, {
        dataModel: null, apiContract: null, uiContract: null,
        businessLogicContract: null,
        // Iterate contracts carry affected_scopes, not tasks[] — without this
        // fallback the whole pre-compose gate phase (type-gate, runtime-gate,
        // auto-recovery) silently skipped on iterates, letting frontend tsc
        // breaks and a dropped /health reach compose (observed live).
        tasks: (routerResult.tasks && routerResult.tasks.length)
          ? routerResult.tasks
          : (routerResult.affectedScopes || []).map((scope) => ({ scope })),
      });
    } catch (err) { logAndSwallow(err, '[session] Iterate auto-start failed (non-fatal)'); }
  }

  // Run-summary write (W1.TEL Section M item 6). The `action` column
  // widens here from 'execute' to 'iterate' — W1.TEL reserved that
  // widening explicitly.
  try {
    const stats = aggregateSessionLlmStats(session.id, { sinceTs: iterateStart });
    const status = (iterResult.exitCode === 0 && !session.cancelled)
      ? 'built' : 'partial';
    writeRunSummary(session.id, {
      intent: routerResult.message || null,
      action: 'iterate',
      startedAt: iterateStart,
      endedAt: Date.now(),
      totalMs: Date.now() - iterateStart,
      scopes: routerResult.affectedScopes || [],
      status,
      tokens: stats.tokens,
      costUsd: stats.costKnown
        ? Math.round(stats.costUsd * 1_000_000) / 1_000_000 : null,
      mgaCalls: stats.mgaCalls,
      toolCalls: stats.toolCalls,
      retryAttemptsByScope: session.retryAttemptsByScope || {},
      reconcilerVerdicts: session.reconcilerVerdictCounts
        || { ok: 0, mismatch: 0, legitimate: 0, noise: 0 },
      snippetFetches: getSnippetFetchMirror(session.id),
      autoRecoveryAttempts: session.autoRecoveryAttempts || [],
      investigatorRecords: session.investigatorRecords || [],
      security: session.securitySummary || null,
      contractStore: {
        ...(session.contractStoreStats || { mergedKinds: [], adoptedRoutes: 0 }),
        revisionCount: (() => { try { return (readContracts(WORKSPACE_DIR)?.data?.revisions || []).length; } catch { return 0; } })(),
      },
    });
  } catch (err) {
    logAndSwallow(err, '[telemetry-run-summary-write-iterate]');
  }

  if (activeSession?.id === session.id) {
    session.hasExecuted = true;
    // Keep status flip to 'idle' even when emitTerminalIdle is false —
    // dispatch completed and the next iterate in a multi sequence will
    // re-flip to 'working' before it runs. The SUPPRESSED part is only
    // the SSE event + queue drain (the observable signals); the in-memory
    // flag stays in sync with reality.
    session.status = 'idle';
    upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
  }
  if (emitTerminalIdle) {
    const idleEvt = appendEvent(session.id, 'status', { status: 'idle' });
    sessionEvents.emit('event', session.id, idleEvt);
    // Drain any messages queued while this iteration was in flight.
    maybeDrainIterationQueue(session, dispatchQueuedMessage);
  }

  return iterResult;
}

// W2.DISPATCH — scope-gate contract_diffs for inline injection in a
// single-scope spawn message. Mirrors the gating in prompt-builder/core.js
// (database+backend see data_model; backend+frontend see api_contract;
// frontend sees ui_contract; backend sees business_logic_contract;
// vectordb+backend+integration see vector_engine). Returns a "=== ITERATE
// DIFFS ===" block or empty string when nothing applies.
export function buildIterateDiffsBlock(scope, summary, rawContractDiffs) {
  const contractDiffs = (rawContractDiffs && typeof rawContractDiffs === 'object')
    ? normalizeContractDiffs(rawContractDiffs)
    : rawContractDiffs;
  if (!contractDiffs || typeof contractDiffs !== 'object') {
    // Cosmetic / copy change with no contract diff — still emit the framing
    // so the subagent knows this is an iteration (not a re-build).
    return [
      '=== ITERATE DIFFS ===',
      '',
      `Iteration intent: ${summary}`,
      '',
      '(No contract changes — cosmetic or copy adjustment. Apply the change',
      'directly to the existing files; the rest of the contract is unchanged.)',
      '=== END ITERATE DIFFS ===',
      '',
      ITERATE_MINIMAL_CHANGE_POLICY,
    ].join('\n');
  }

  const slices = [];
  const dataModel = contractDiffs.data_model || contractDiffs.dataModel;
  const apiContract = contractDiffs.api_contract || contractDiffs.apiContract;
  const uiContract = contractDiffs.ui_contract || contractDiffs.uiContract;
  const businessLogic = contractDiffs.business_logic_contract || contractDiffs.businessLogicContract;
  const vectorEngine = contractDiffs.vector_engine || contractDiffs.vectorEngine;

  if ((scope === 'database' || scope === 'backend') && dataModel) {
    slices.push(`--- data_model diff ---\n${JSON.stringify(dataModel, null, 2)}`);
  }
  if ((scope === 'backend' || scope === 'frontend') && apiContract) {
    slices.push(`--- api_contract diff ---\n${JSON.stringify(apiContract, null, 2)}`);
  }
  if (scope === 'frontend' && uiContract) {
    slices.push(`--- ui_contract diff ---\n${JSON.stringify(uiContract, null, 2)}`);
  }
  if ((scope === 'backend' || scope === 'integration') && businessLogic) {
    slices.push(`--- business_logic_contract diff ---\n${JSON.stringify(businessLogic, null, 2)}`);
  }
  if ((scope === 'vectordb' || scope === 'backend' || scope === 'integration') && vectorEngine) {
    slices.push(`--- vector_engine diff ---\n${JSON.stringify(vectorEngine, null, 2)}`);
  }

  if (slices.length === 0) {
    // No slice applies to this scope (e.g., backend dispatch for a
    // frontend-only ui_contract diff would be unusual but defensible).
    return [
      '=== ITERATE DIFFS ===',
      '',
      `Iteration intent: ${summary}`,
      '',
      '(No contract diff applies to this scope. Apply the intent directly to',
      'your existing files.)',
      '=== END ITERATE DIFFS ===',
    ].join('\n');
  }

  return [
    '=== ITERATE DIFFS ===',
    '',
    `Iteration intent: ${summary}`,
    '',
    'The following contract changes apply to your scope. Treat them as',
    'additions/changes to apply on top of the previously-built code. Files',
    'and contracts not mentioned remain as-is — see `.harness/contracts.json`',
    'for the full pre-iterate state.',
    ...(diffHasRemovals(contractDiffs) ? [
      '',
      'Entries under `remove_*` keys are DELETIONS, not additions: delete the',
      'named routes/components/views/rules and every reference to them —',
      'handlers, call sites, imports, navigation entries. Leave no dead code.',
    ] : []),
    '',
    ...slices,
    '',
    '=== END ITERATE DIFFS ===',
  ].join('\n');
}

// W2.DISPATCH — queue drain helper. Called at the END of a build's terminal
// state transition. If iterationQueue has items, shifts the head off and
// re-dispatches the message via the same router→dispatch flow on the next
// event-loop tick (so we don't block the terminal-state response). Bounded
// by user behaviour: each queued iteration is one router call + one
// dispatch.
export function maybeDrainIterationQueue(session, processMessageFn) {
  if (!session || !Array.isArray(session.iterationQueue) || session.iterationQueue.length === 0) {
    return;
  }
  const head = session.iterationQueue.shift();
  tlog('[iteration-queue] dispatching head; remaining=%d', session.iterationQueue.length);
  // Defer to next tick so the terminal-state response/event has finished
  // emitting before we mark status=working again.
  setImmediate(() => {
    try {
      const ret = processMessageFn(session, head);
      if (ret && typeof ret.catch === 'function') {
        ret.catch(err => logAndSwallow(err, '[iteration-queue] queued dispatch threw'));
      }
    } catch (err) {
      logAndSwallow(err, '[iteration-queue] queued dispatch threw (sync)');
    }
  });
}

// W2.DISPATCH — dispatch a single queued message through the router →
// iterate/dispatch pipeline. This is the queue-drain consumer: we already
// know status was 'working' when the message was queued, so by the time
// this fires the prior build has completed (terminal state reached).
//
// Re-runs the router (which now sees post-build .harness/ state so most
// queued messages emit `iterate`), then routes to single-scope or
// orchestrator dispatch via dispatchIterate. Non-iterate routes (clarify,
// execute, diagnose) are surfaced as cline events but NOT re-gated through
// plan_preview/confirm — the user fired-and-forgot, so we keep the simple
// flow. If the router emits execute, we hold for confirmation as usual.
async function dispatchQueuedMessage(session, payload) {
  if (!session || !payload) return;
  const { message, displayMessage, uploads: rawUploads } = payload;
  if (!message) return;

  const uploads = sanitiseUploadsPayload(rawUploads);
  const bubbleText = (typeof displayMessage === 'string' && displayMessage.trim())
    ? displayMessage.trim() : message;

  // Surface the queued user message into the transcript so the UI shows
  // the bubble in order. Mirrors POST /message's user-event emit.
  const userPayload = uploads.length > 0 ? { message: bubbleText, uploads } : { message: bubbleText };
  appendEvent(session.id, 'user', userPayload);
  session.lastUserMessage = message;
  sessionEvents.emit('event', session.id, {
    ts: Date.now(), type: 'user', payload: userPayload,
  });

  try {
    const msgStart = Date.now();
    session.status = 'working';
    sessionEvents.emit('event', session.id, {
      ts: Date.now(), type: 'status', payload: { status: 'working' },
    });

    const envContext = await refreshEnvContext();
    const routerResult = await routeMessage(message, envContext, {
      conversationId: session.routerConversationId,
      priorMessages: session.routerMessages || [],
      uploads: uploads.length > 0 ? uploads : null,
      sessionFirstMessageChars: session.routerFirstMessageChars || null,
    });
    session.routerConversationId = routerResult.conversationId;
    emitRouterSoftCorrects(session.id, routerResult);

    if (routerResult.action === 'iterate') {
      if (routerResult.message) {
        const iterEvent = appendEvent(session.id, 'cline', {
          say: 'text', text: routerResult.message,
        });
        sessionEvents.emit('event', session.id, iterEvent);
      }
      const iterResult = await dispatchIterate(session, routerResult, envContext, uploads);
      tlog('[iteration-queue] queued iterate finished (%dms, exit=%s)',
        Date.now() - msgStart, iterResult.exitCode);
    } else {
      // Non-iterate router emit from a queued message — surface the
      // router's message as a cline event and go idle. Forces user to
      // re-engage with /confirm flow for execute.
      tlog('[iteration-queue] queued message routed as action=%s — not auto-dispatching',
        routerResult.action);
      if (routerResult.message) {
        const evt = appendEvent(session.id, 'cline', {
          say: 'text', text: routerResult.message,
        });
        sessionEvents.emit('event', session.id, evt);
      }
    }

    session.status = 'idle';
    const idleEvt = appendEvent(session.id, 'status', { status: 'idle' });
    sessionEvents.emit('event', session.id, idleEvt);

    // Recurse: more queued messages? Drain again.
    maybeDrainIterationQueue(session, dispatchQueuedMessage);
  } catch (err) {
    logAndSwallow(err, '[iteration-queue] queued message dispatch failed');
    session.status = 'idle';
    const errEvt = appendEvent(session.id, 'status', { status: 'idle' });
    sessionEvents.emit('event', session.id, errEvt);
  }
}

export function mountSessionRoutes(app) {
  app.post('/api/session/start', async (_req, res) => {
    try {
      const creds = getCredentials();
      if (!creds) {
        return res.status(400).json({ error: 'Missing config' });
      }

      // Return existing session if still active
      if (activeSession && activeSession.status !== 'error') {
        return res.json({ sessionId: activeSession.id });
      }

      setSensitiveStrings([creds.apiKey, ...listAppSecretValues(WORKSPACE_DIR)]);

      const sessionId = randomUUID();
      const now = Date.now();
      activeSession = {
        id: sessionId,
        routerConversationId: null,
        routerMessages: [],
        // W2.ROUTER — char count of the FIRST router-call outbound message in
        // this session. Threaded into subsequent routeMessage opts so the
        // prompt-size cost-watch can compare iteration prompts against the
        // session baseline (Section M / Addition 3c). Set on round 0; never
        // overwritten thereafter.
        routerFirstMessageChars: null,
        coderConversationId: null,
        // Phase C: tracks the last single-scope subagent that completed.
        // Set after each successful single-scope dispatch (router emits
        // 1 task → orchestrator dispatches 1 subagent OR direct continuation).
        // Cleared (set to null) after multi-scope dispatch. Read at dispatch
        // time to short-circuit the orchestrator hop when the router emits
        // a single task whose scope matches.
        lastActiveSubagentScope: null,
        // W2.DISPATCH — iteration queue. Populated by POST /message when the
        // session is already `working`; drained at terminal-state.
        iterationQueue: [],
        status: 'working',
        activeProcs: new Set(),
        startedAt: now,
      };

      // Persist to session index
      upsertSession({ sessionId, createdAt: now, lastMessageAt: now });

      // Respond immediately so the UI can connect WebSocket
      res.json({ sessionId });

      // Lightweight init. Each scoped task gets full rules + context
      // injected via buildScopedPrompt().
      try {
        const t0 = Date.now();
        const envContext = await gatherEnvContext(); // warm the cache for first message
        tlog('[session] Init: envContext gathered (%dms) phase=%s',
          Date.now() - t0, envContext?.projectPhase || 'unknown');

        // Run update check server-side (non-blocking, informational only)
        try {
          const checkScript = path.join(WORKSPACE_DIR, 'scripts', 'check-updates.sh');
          if (existsSync(checkScript)) {
            execFileSync('bash', [checkScript], { cwd: WORKSPACE_DIR, timeout: BASH_SCRIPT_MS, stdio: 'pipe' });
          }
        } catch { /* update check is non-critical */ }

        if (activeSession?.id === sessionId) {
          activeSession.status = 'idle';
          upsertSession({ sessionId, lastMessageAt: Date.now() });
        }
        tlog('[session] Init: ready (%dms)', Date.now() - t0);

        const event = appendEvent(sessionId, 'status', { status: 'idle' });
        sessionEvents.emit('event', sessionId, event);
      } catch (err) {
        logAndSwallow(err, '[session] Init failed');
        // Still go idle — init failure is non-fatal
        if (activeSession?.id === sessionId) {
          activeSession.status = 'idle';
        }
        const event = appendEvent(sessionId, 'status', { status: 'idle' });
        sessionEvents.emit('event', sessionId, event);
      }
    } catch (err) {
      logAndSwallow(err, '[session] Unexpected error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to start session: ' + err.message });
      }
    }
  });

  app.post('/api/session/:sessionId/message', async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { message, displayMessage, uploads: rawUploads } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Sanitise + cap uploads ONCE up front so every downstream branch
    // (mid-build concierge, post-build concierge, planner) sees the same
    // sanitised shape. The concierge takes uploads via multimodal content
    // blocks (text + base64 images); the planner inlines them via
    // shared-context.js buildAttachedFilesBlock.
    const uploads = sanitiseUploadsPayload(rawUploads);

    // Mid-build user message — route to the concierge LLM. The concierge
    // owns the conversational surface during status='working': respond /
    // clarify / add_to_todo handle inline; dispatch_iterate + interrupt
    // are deferred (see chat/server/agent/concierge/handle-action.js).
    //
    // Iteration-queue machinery (session.iterationQueue + maybeDrainIterationQueue)
    // stays intact — when iterate-mode planner wiring lands and
    // dispatch_iterate goes live, the handler will enqueue here so the
    // iterate fires after the in-flight build's terminal-state transition.
    // Today the queue is unused under this flow.
    //
    // Render the user message in the chat thread immediately. The prior
    // queue branch skipped this — the user's words wouldn't appear until
    // drain. Concierge replies arrive 2-6s later via SSE.
    if (session.status === 'working') {
      const bubbleText = (typeof displayMessage === 'string' && displayMessage.trim())
        ? displayMessage.trim()
        : message;
      const userEvent = appendEvent(session.id, 'user', { message: bubbleText });
      sessionEvents.emit('event', session.id, userEvent);

      emitUserAction(session.id, 'concierge_turn', { messageChars: message.length, uploadCount: uploads.length });
      tlog('[concierge] mid-build turn (chars=%d uploads=%d): %s',
        Number(message.length) || 0, uploads.length,
        logSafe(message.length > 200 ? message.slice(0, 200) + '...' : message));

      // Fire-and-forget. SSE delivers the concierge reply.
      res.status(202).json({ accepted: true });
      (async () => {
        try {
          const result = await runConciergeTurn(session, message, uploads);
          if (!result.ok) {
            tlog('[concierge] turn failed: %s', result.error);
            const errEvent = appendEvent(session.id, 'concierge_text', {
              text: `(concierge unavailable: ${result.error})`,
            });
            sessionEvents.emit('event', session.id, errEvent);
            return;
          }
          dispatchConciergeAction(session, result.decision);
        } catch (err) {
          logAndSwallow(err, '[concierge] turn threw');
          const errEvent = appendEvent(session.id, 'concierge_text', {
            text: `(concierge turn threw — ${err.message})`,
          });
          sessionEvents.emit('event', session.id, errEvent);
        }
      })();
      return;
    }

    // Post-build conversational front door. When the session is idle AND a
    // `.harness/state.md` exists (meaning a prior build completed), the
    // concierge runs FIRST to triage the user's message. This gives
    // conversational asks ("how does auth work?", "what tables do we have?")
    // a fast path that doesn't trigger the full planner + plan_preview +
    // /confirm pipeline.
    //
    // Handled inline (post-build): `respond`, `clarify`, `add_to_todo`,
    // `dispatch_iterate`, AND `diagnose` — the multi-action sequencer below
    // runs conversational acks first, then the heavy actions (iterate /
    // diagnose) sequentially. `diagnose` routes "it's broken" to the read-only
    // investigator (logs + code → auto-fix or surface) via runDiagnoseAndRespond.
    // `multi` is flattened into those atomics by normalizeConciergeDecision;
    // `interrupt` is collapsed by the normalizer to `dispatch_iterate` or
    // `respond`. (Mid-build is the path that DEFERS `dispatch_iterate`/`interrupt`
    // — see the status==='working' branch.)
    //
    // Fall through to the planner: only an unrecognised action or a parse
    // failure / concierge unavailable. The planner path still handles
    // structural changes via plan_preview + /confirm — no regression.
    //
    // Uploads (screenshots, PDFs, text files) now go THROUGH the concierge
    // — image uploads become multimodal content blocks, non-images surface
    // via the JSON attached_uploads field with their parsed preview. The
    // previous text-only-transport guard was dropped when /chat/completions
    // multimodal landed (buildConciergeUserContent in concierge.js handles
    // the assembly). The planner still gets the same uploads on fall-through.
    if (session.status === 'idle' && safeHasHarnessStateMd()) {
      const bubbleText = (typeof displayMessage === 'string' && displayMessage.trim())
        ? displayMessage.trim()
        : message;
      emitUserAction(session.id, 'concierge_turn', {
        messageChars: message.length,
        phase: 'post-build',
        uploadCount: uploads.length,
      });
      tlog('[concierge] post-build turn (chars=%d uploads=%d): %s',
        Number(message.length) || 0, uploads.length,
        logSafe(message.length > 200 ? message.slice(0, 200) + '...' : message));

      let conciergeResult = null;
      try {
        conciergeResult = await runConciergeTurn(session, message, uploads);
      } catch (err) {
        logAndSwallow(err, '[concierge] post-build turn threw');
      }

      // Normalize the decision into a flat list of atomic actions. Handles:
      //   - `multi` → recursively flattened
      //   - `interrupt` with interrupt_then=iterate → dispatch_iterate
      //   - `interrupt` with abort/wait/undefined → respond (nothing to stop)
      //   - everything else → returned as-is in a single-element list
      // After this we know we're dealing with a flat list of
      // respond/clarify/add_to_todo/dispatch_iterate entries (or unknown
      // actions that should fall through to the planner).
      const subs = conciergeResult?.ok
        ? normalizeConciergeDecision(conciergeResult.decision)
        : [];
      const KNOWN_ATOMIC = new Set(['respond', 'clarify', 'add_to_todo', 'dispatch_iterate', 'diagnose']);
      const allKnown = subs.length > 0 && subs.every(s => KNOWN_ATOMIC.has(s.action));

      if (allKnown) {
        const userEvent = appendEvent(session.id, 'user', { message: bubbleText });
        sessionEvents.emit('event', session.id, userEvent);
        upsertSession({
          sessionId: session.id,
          title: bubbleText.slice(0, 80),
          lastMessageAt: Date.now(),
        });
        res.status(202).json({ accepted: true });
        const iterateCount = subs.filter(s => s.action === 'dispatch_iterate').length;
        const diagnoseCount = subs.filter(s => s.action === 'diagnose').length;
        emitUserAction(session.id, 'concierge_turn', {
          messageChars: message.length,
          phase: 'post-build',
          subActions: subs.length,
          iterateCount,
          diagnoseCount,
        });

        (async () => {
          try {
            // Phase 1: dispatch every conversational sub-action inline. These
            // are synchronous (just emit concierge_text + maybe mutate todoList);
            // we surface them BEFORE any heavy action so the user sees the ack
            // ("ok, changing the button colour now") before the long-running
            // dispatch starts. HEAVY actions (dispatch_iterate, diagnose) are
            // collected in emission order and run sequentially in Phase 2.
            const heavy = [];
            for (const sub of subs) {
              if (sub.action === 'dispatch_iterate' || sub.action === 'diagnose') {
                heavy.push(sub);
                continue;
              }
              try {
                dispatchConciergeAction(session, sub);
              } catch (err) {
                logAndSwallow(err, '[concierge] post-build sub-action dispatch threw');
              }
            }

            if (heavy.length === 0) {
              // Pure conversational turn — emit idle heartbeat to signal
              // turn complete. session.status was already 'idle' and stays
              // that way; the event tells observers (UI + smoke) the turn
              // has finished.
              const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
              sessionEvents.emit('event', session.id, idleEvent);
              return;
            }

            // Phase 2: run heavy sub-actions SEQUENTIALLY. Sequencing matters:
            // action N+1 sees the workspace state from action N's effects
            // (state.md, code on disk). A `diagnose` runs the read-only
            // investigator (→ auto-fix or surface) via runDiagnoseAndRespond; a
            // `dispatch_iterate` runs contract-agent ITERATE mode → subagent
            // dispatch. If one fails we surface and stop — better than running
            // the rest against a partly-broken workspace.
            //
            // emitTerminalIdle fires ONLY on the LAST action. If we emitted
            // status:idle after each one, observers (smoke harness, UI client)
            // would treat the FIRST idle as "this turn is done" and advance
            // immediately — racing the remaining actions and silently dropping
            // them. Intermediate actions suppress the idle emit; the in-memory
            // session.status still flips so the post-build gate stays consistent.
            const envContext = await refreshEnvContext();
            for (let i = 0; i < heavy.length; i++) {
              if (session.cancelled) break;
              const sub = heavy[i];
              const isLast = i === heavy.length - 1;

              if (sub.action === 'diagnose') {
                // Flip to working so the UI shows activity during the
                // (possibly multi-second) read-only investigation.
                // runDiagnoseAndRespond owns the "Investigating…" event,
                // telemetry, and the auto-fix-or-surface branch + terminal idle.
                session.status = 'working';
                sessionEvents.emit('event', session.id, {
                  ts: Date.now(), type: 'status', payload: { status: 'working' },
                });
                try {
                  await runDiagnoseAndRespond(session, {
                    symptom: sub.symptom || sub.iterate_user_message || message,
                    suspectedScope: sub.suspected_scope || null,
                    envContext,
                    uploads,
                    emitTerminalIdle: isLast,
                  });
                } catch (err) {
                  logAndSwallow(err, `[concierge] diagnose ${i + 1}/${heavy.length} threw`);
                  const errEvent = appendEvent(session.id, 'concierge_text', {
                    text: `(diagnose ${i + 1}/${heavy.length} threw — ${err.message})`,
                  });
                  sessionEvents.emit('event', session.id, errEvent);
                  break;
                }
                continue;
              }

              // dispatch_iterate
              let iterateResult;
              try {
                iterateResult = await runConciergeIterate({
                  iterateSummary: sub.iterate_summary,
                  iterateUserMessage: sub.iterate_user_message || message,
                });
              } catch (err) {
                logAndSwallow(err, `[concierge] iterate ${i + 1}/${heavy.length} threw`);
                const errEvent = appendEvent(session.id, 'concierge_text', {
                  text: `(iterate ${i + 1}/${heavy.length} dispatch threw — ${err.message})`,
                });
                sessionEvents.emit('event', session.id, errEvent);
                break;
              }

              if (!iterateResult.ok) {
                const remaining = heavy.length - i - 1;
                const tail = remaining > 0
                  ? ` Skipping remaining ${remaining} change(s).`
                  : ' You can rephrase or try again.';
                tlog('[concierge] iterate-dispatcher failed (%d/%d): %s',
                  i + 1, heavy.length, iterateResult.error);
                const errEvent = appendEvent(session.id, 'concierge_text', {
                  text: `I tried to dispatch that change but couldn't: ${iterateResult.error}.${tail}`,
                });
                sessionEvents.emit('event', session.id, errEvent);
                break;
              }

              session.status = 'working';
              sessionEvents.emit('event', session.id, {
                ts: Date.now(), type: 'status', payload: { status: 'working' },
              });
              await dispatchIterateAndFinalize(
                session,
                iterateResult.routerResult,
                envContext,
                [],
                { emitTerminalIdle: isLast },
              );
            }
          } catch (err) {
            logAndSwallow(err, '[concierge] post-build action sequence threw');
            try {
              session.status = 'idle';
              sessionEvents.emit('event', session.id, {
                ts: Date.now(), type: 'status', payload: { status: 'idle' },
              });
            } catch { /* noop */ }
          }
        })();
        return;
      }

      if (conciergeResult?.ok) {
        tlog('[concierge] post-build action=%s — falling through to planner', conciergeResult.decision.action);
      } else if (conciergeResult) {
        tlog('[concierge] post-build call failed: %s — falling through to planner', conciergeResult.error);
      } else {
        tlog('[concierge] post-build turn threw — falling through to planner');
      }
      // Fall through to the planner pipeline below.
    }

    // `uploads` was sanitised at the top of this handler (line ~1194) so
    // every branch — mid-build concierge, post-build concierge, planner —
    // sees the same shape. The planner inlines them via shared-context.js
    // buildAttachedFilesBlock; the concierge accepts them as multimodal
    // content blocks.

    // Record user message. Quick actions send a short `displayMessage` (what
    // the user saw on the button, e.g. "Start application") alongside the
    // full `message` (e.g. "Run my application locally with docker compose
    // up, check if it starts correctly, and report the results."). The bubble
    // renders the short display form so the chat stays readable, while
    // `message` — kept in the outer closure — is what actually reaches the
    // router / Cline. If `displayMessage` is missing, fall back to `message`.
    const bubbleText = (typeof displayMessage === 'string' && displayMessage.trim())
      ? displayMessage.trim()
      : message;
    // Workspace snapshot BEFORE this turn runs. The SHA lands on the user
    // event payload so a future "branch from here" can restore files to the
    // state the user saw when they typed this message. Failure is non-fatal —
    // createSnapshot returns null and branching from this turn becomes a
    // conversation-only clone (no file revert).
    const snapshotSha = createSnapshot(session.id, `pre-turn: ${bubbleText.slice(0, 60)}`);
    const userPayload = uploads.length > 0
      ? { message: bubbleText, uploads, ...(snapshotSha ? { snapshotSha } : {}) }
      : { message: bubbleText, ...(snapshotSha ? { snapshotSha } : {}) };
    appendEvent(session.id, 'user', userPayload);
    // Capture the full user message (not the bubble form) for downstream
    // consumers — the prompt-writer needs the original intent verbatim to
    // craft a focused assistant system prompt.
    session.lastUserMessage = message;
    sessionEvents.emit('event', session.id, {
      ts: Date.now(), type: 'user', payload: userPayload,
    });

    // Update session index (set title from the user-visible bubble text so
    // session lists don't show a wall of quick-action prompt boilerplate).
    // Setting title here is also what marks a session as "real" — the
    // welcome-back "Continue where I left off" button filters on title being
    // present, skipping the empty boot-time sessions that never got input.
    upsertSession({
      sessionId: session.id,
      title: bubbleText.slice(0, 80),
      lastMessageAt: Date.now(),
    });

    // Respond immediately
    res.json({ ok: true });

    // Run message through assistant router, then the custom agent.
    try {
      const msgStart = Date.now();
      session.status = 'working';
      session.retryCount = session.retryCount || 0;
      sessionEvents.emit('event', session.id, {
        ts: Date.now(), type: 'status', payload: { status: 'working' },
      });

      // W1.STATE backfill — synthesize `.harness/` from the transcript on the
      // first message after Phase 1 deploy if the directory is empty. Idempotent
      // (no-op once contracts.json exists). Telemetry-class: never throws into
      // the request path — a failed migration just leaves `.harness/` empty, and
      // the iteration replans from scratch (same as a brand-new session).
      try {
        await migrateHarnessState(session.id);
      } catch (err) {
        logAndSwallow(err, '[session] Harness backfill threw (non-fatal)');
      }

      // ── Step 1: Route through assistant LLM (first message / clarification) ──
      let enrichedMessage = message;
      let skipFallbackDispatch = false;
      if (middlewareReady) {
        try {
          const tEnv = Date.now();
          const envContext = await refreshEnvContext();
          tlog('[session] Message: envContext refreshed (%dms)', Date.now() - tEnv);

          const tRouter = Date.now();
          const clarifyRound = session.clarifyRound || 0;
          tlog('[session] Router: user message (%d chars, clarify round %d): %s',
            Number(message.length) || 0, clarifyRound, logSafe(message.length > 300 ? message.slice(0, 300) + '...' : message));

          // Emit "thinking" status so the frontend shows activity
          sessionEvents.emit('event', session.id, {
            ts: Date.now(), type: 'router_status', payload: { phase: 'thinking', chars: 0 },
          });

          const routerResult = await routeMessage(message, envContext, {
            conversationId: session.routerConversationId,
            priorMessages: session.routerMessages || [],
            uploads: uploads.length > 0 ? uploads : null,
            sessionFirstMessageChars: session.routerFirstMessageChars || null,
            onProgress: ({ chars, elapsedMs }) => {
              sessionEvents.emit('event', session.id, {
                ts: Date.now(), type: 'router_status', payload: { phase: 'streaming', chars, elapsedMs },
              });
            },
          });
          emitRouterSoftCorrects(session.id, routerResult);
          const routerMs = Date.now() - tRouter;
          const routerScopes = (routerResult.tasks || []).map(t => t.scope).join(', ');
          tlog('[session] Router responded (%dms) action=%s scopes=[%s]',
            routerMs, routerResult.action, routerScopes || 'none');

          // Persist conversation ID for multi-turn clarification
          session.routerConversationId = routerResult.conversationId;

          // W2.ROUTER — capture the FIRST router-call outbound message size so
          // subsequent iterations can compare against this baseline in the
          // prompt-size cost-watch. Only set on the first turn; preserved as
          // null until the first routeMessage returns.
          if (session.routerFirstMessageChars == null
              && typeof routerResult.sentUserMessage === 'string') {
            session.routerFirstMessageChars = routerResult.sentUserMessage.length;
          }

          // Append this turn's user+assistant pair to the client-side history
          // so subsequent clarify rounds see the original prompt + prior Q/A.
          // MGA conversation_id alone is unreliable for multi-turn — see
          // chat/server/agent/planner/router.js header comment.
          session.routerMessages = [
            ...(session.routerMessages || []),
            { role: 'user', content: routerResult.sentUserMessage },
            { role: 'assistant', content: routerResult.rawAssistantResponse },
          ];

          if (routerResult.action === 'clarify') {
            // Router needs more info — relay question to user, go idle
            session.clarifyRound = clarifyRound + 1;
            tlog('[session] Router requests clarification (round %d)', session.clarifyRound);
            const clarifyEvent = appendEvent(session.id, 'cline', {
              say: 'text',
              text: routerResult.message,
              // Structured clarify questions (normalized in two-agent.js). When
              // present the frontend renders single/multi-select cards directly;
              // when absent it falls back to parsing the prose `text`.
              questions: routerResult.questions && routerResult.questions.length ? routerResult.questions : undefined,
            });
            sessionEvents.emit('event', session.id, clarifyEvent);

            session.status = 'idle';
            upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
            const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
            sessionEvents.emit('event', session.id, idleEvent);
            return; // Wait for user's next message
          }

          // W2.DISPATCH — iterate path. The router emitted `iterate` with
          // affected_scopes[] (validator guarantees non-empty + valid scope
          // names). Dispatch IMMEDIATELY — no plan_preview gate, since the
          // user already supplied the iteration prompt and we have project
          // memory to act on. Branches on affected_scopes.length:
          //   1   → single-scope direct (reuses coderConversationIds[scope])
          //   >=2 → orchestrator-with-diffs (scope-gated contract_diffs)
          if (routerResult.action === 'iterate') {
            await dispatchIterateAndFinalize(session, routerResult, envContext, uploads);
            return;
          }

          // W3.INVEST — diagnose path. The Understanding agent classified
          // this as a bug report; hand off to the shared investigator runner
          // (runDiagnoseAndRespond, also used by the post-build concierge
          // `diagnose` action). Runs SERIALLY (await) — no concurrent phase
          // subagents during diagnose. Wall-clock timeout inside the runner.
          if (routerResult.action === 'diagnose') {
            await runDiagnoseAndRespond(session, {
              symptom: routerResult.symptom || '',
              suspectedScope: routerResult.suspectedScope || null,
              envContext,
              uploads,
            });
            return;
          }

          // Router says "execute" — build enriched Cline prompt from spec
          if (routerResult.message) {
            const summaryEvent = appendEvent(session.id, 'cline', {
              say: 'text',
              text: routerResult.message,
            });
            sessionEvents.emit('event', session.id, summaryEvent);
          }

          // ── Flag-driven rule/snippet resolution ──
          // Router emits plan.flags describing what the app needs (has-users,
          // real-time, etc.). resolveFlags walks tagged files in snippets/
          // and .platform-rules/ and unions the matches into each task.
          const resolvedPlan = resolveFlags(routerResult);

          const scopes = (resolvedPlan.tasks || []).map(t => t.scope).join(', ');
          const allRules = [...new Set((resolvedPlan.tasks || []).flatMap(t => t.rules || []))];
          tlog('[session] Router → execute: scopes=[%s] flags=[%s] rules=[%s]',
            scopes || 'none', (resolvedPlan.flags || []).join(',') || 'none', allRules.join(', ') || 'none');

          // Reset router conversation and clarify counter after execution dispatch
          // (next user message starts a fresh routing conversation)
          session.routerConversationId = null;
          session.routerMessages = [];
          session.clarifyRound = 0;

          // ── Step 1b: Hold plan for user confirmation before running Cline ──
          // Store the plan + env context + uploads so /confirm can execute it later.
          // Step 7d/7e: also persist data_model + api_contract + vector_engine
          // through the user-confirmation gap.
          session.pendingPlan = {
            tasks: resolvedPlan.tasks,
            flags: resolvedPlan.flags || [],
            envContext,
            uploads,
            dataModel: resolvedPlan.dataModel || null,
            apiContract: resolvedPlan.apiContract || null,
            vectorEngine: resolvedPlan.vectorEngine || null,
            uiContract: resolvedPlan.uiContract || null,
            businessLogicContract: resolvedPlan.businessLogicContract || null,
            mgaAssistants: resolvedPlan.mgaAssistants || [],
            // PR 2 / Alt A — carry the contract agent's messages[] through
            // the confirm gap so the reconciler-judge can continue the
            // conversation when classifying extras. Null when the contract
            // agent fell back to the legacy /chat/agent path.
            contractAgentMessages: resolvedPlan.contractAgentMessages || null,
            // Hybrid module plan fields — carried through the confirm gap.
            // Null/defaults when the Contract Agent emitted no module plan.
            modulePlan: routerResult.modulePlan || null,
            confidence: typeof routerResult.confidence === 'number' ? routerResult.confidence : 1.0,
            reasonCodes: Array.isArray(routerResult.reasonCodes) ? routerResult.reasonCodes : [],
            // RAG architecture decision — carried through the confirm gap.
            // Null when RAG pattern not detected in the brief.
            ragArchitecture: routerResult.ragArchitecture || null,
          };
          savePendingPlan(session.id, session.pendingPlan);
          // A6 telemetry — how many attempts the contract agent needed
          // (validation-retry rate is a prompt-drift signal in runs-report).
          session.lastContractAttempt = routerResult.contractAttempt || 1;
          session.status = 'idle';

          // Emit plan_preview event so the UI shows the confirm/cancel card.
          // Track A (A4): include the full structured router output so the
          // smoke gate can assert against per-scenario plannerExpect. The UI
          // ignores extra fields; smoke's plan_preview handler reads them.
          const planPreviewEvent = appendEvent(session.id, 'plan_preview', {
            message: resolvedPlan.message || '',
            tasks: resolvedPlan.tasks.map(t => ({
              scope: t.scope,
              summary: t.summary || '',
              task: t.task,
            })),
            flags: resolvedPlan.flags || [],
            dataModel: resolvedPlan.dataModel || null,
            apiContract: resolvedPlan.apiContract || null,
            vectorEngine: resolvedPlan.vectorEngine || null,
            uiContract: resolvedPlan.uiContract || null,
            businessLogicContract: resolvedPlan.businessLogicContract || null,
            mgaAssistants: resolvedPlan.mgaAssistants || [],
          });
          sessionEvents.emit('event', session.id, planPreviewEvent);

          const planIdleEvent = appendEvent(session.id, 'status', { status: 'idle' });
          sessionEvents.emit('event', session.id, planIdleEvent);
          upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });

          tlog('[session] Plan held for user confirmation: %d task(s)', resolvedPlan.tasks.length);
          skipFallbackDispatch = true;
          // Skip the fallback custom-agent dispatch — wait for /confirm or /discard

        } catch (err) {
          logAndSwallow(err, '[session] Router failed (falling back to raw message)');
          // Fall through to the fallback dispatch below (custom agent)
        }
      }

      // ── Step 2 (fallback): Execute via the custom agent ──
      // This path runs when the router didn't run at all (e.g. first
      // message, no routerConversationId) OR when it failed mid-flight.
      if (!skipFallbackDispatch) {
        tlog('[session] Message: sending raw to custom-agent (%d chars, elapsed=%dms)',
          Number(enrichedMessage.length) || 0, Date.now() - msgStart);
        const tStart = Date.now();

        // Synthetic "main" scope so the UI quick-actions bar shows after completion.
        emitScopeStatus(session.id, { scope: 'main', status: 'running' });

        const { runCustomAgent } = await import('../agent/agent.js');
        // Raw-mode fallback (router unavailable). Default to the backend
        // subagent — it's the most-common scope and the safest fallback
        // when we have no scope hint. Realistically this path only fires
        // when middleware fails to load, which is an init-time error.
        const result = await runCustomAgent(session.id, enrichedMessage, {
          conversationId: session.coderConversationId || null,
          scope: 'backend',
          priorTokenTotals: session.coderTokenTotals || null,
          phase: PHASES.SUBAGENT,
        });
        if (activeSession?.id === session.id) {
          session.hasExecuted = true;
          if (result.conversationId) {
            session.coderConversationId = result.conversationId;
          }
        }
        accumulateAgentTotals(session, result);

        emitScopeStatus(session.id, { scope: 'main', status: 'completed', exitCode: result.exitCode });

        tlog('[session] Message: custom-agent finished (%dms, exit=%s, total=%dms)',
          Date.now() - tStart, result.exitCode, Date.now() - msgStart);
      }

      // ── Done — go idle ──
      if (activeSession?.id === session.id) {
        session.status = 'idle';
        upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
      }

      const event = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, event);

      // W2.DISPATCH — drain any queued messages (only reachable when the
      // message took the fallback custom-agent path; the iterate path
      // already drained above).
      maybeDrainIterationQueue(session, dispatchQueuedMessage);
    } catch (err) {
      logAndSwallow(err, '[session] Message processing failed');
      if (activeSession?.id === session.id) {
        session.status = 'error';
      }
      const event = appendEvent(session.id, 'status', { status: 'error', error: err.message });
      sessionEvents.emit('event', session.id, event);
    }
  });

  // ── Manual summarizer trigger (Phase 2b test hook) ──
  // POST /api/session/:sessionId/summarize
  //
  // Takes the session's most recent runCustomAgent virtual history and
  // feeds it to the MGA Summarizer assistant. Returns the raw response,
  // extracted <analysis> block, and extracted <summary> block. Used to
  // verify the summarizer produces coherent 9-section output before we
  // wire it into auto-rotation in Phase 3.
  //
  // Usage: run an agent task, then curl this endpoint. No UI needed.
  //   curl -X POST http://localhost:5051/api/session/<sessionId>/summarize
  app.post('/api/session/:sessionId/summarize', async (req, res) => {
    const sessionId = cleanSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });
    try {
      const { SummarizerClient, buildTranscriptFromHistory, buildTranscriptFromEvents } =
        await import('../agent/compaction/summarizer.js');
      const summarizer = new SummarizerClient();
      if (!summarizer.available) {
        return res.status(400).json({
          error: 'Summarizer not configured. Set SUMMARIZER_ASSISTANT_ID env var or summarizerAssistantId in .chat/secrets.json.',
        });
      }

      // Prefer the live VirtualHistoryManager on the active session (richer:
      // per-turn content + tool-result previews). Fall back to reconstructing
      // from the session's on-disk transcript when the session isn't active
      // or its in-memory history was lost to a restart.
      let transcript;
      let source;
      let historyTurnCount = null;
      const session = activeSession?.id === sessionId ? activeSession : null;
      if (session?.lastCoderHistory?.turns?.length) {
        transcript = buildTranscriptFromHistory(session.lastCoderHistory);
        source = 'live-session';
        historyTurnCount = session.lastCoderHistory.turns.length;
      } else {
        const events = readAll(sessionId);
        if (!events?.length) {
          return res.status(404).json({
            error: `No transcript found for session ${sessionId}. Verify the session ID is correct (check .chat/transcripts/<id>.jsonl).`,
          });
        }
        transcript = buildTranscriptFromEvents(events);
        source = 'transcript-file';
        historyTurnCount = events.length;
      }

      tlog('[summarize] invoking on session=%s source=%s transcriptChars=%d turns=%d',
        sessionId, source, transcript.length, historyTurnCount);

      const result = await summarizer.summarizeTranscript(transcript);

      tlog('[summarize] %s — elapsed=%dms usage=%s summaryLen=%d analysisLen=%d',
        sessionId,
        result.elapsedMs,
        result.usage ? `prompt=${result.usage.prompt_tokens ?? '?'} completion=${result.usage.completion_tokens ?? '?'}` : 'n/a',
        result.summary?.length ?? 0,
        result.analysis?.length ?? 0);

      res.json({
        sessionId,
        source,
        historyTurnCount,
        transcriptLength: transcript.length,
        elapsedMs: result.elapsedMs,
        usage: result.usage,
        summary: result.summary,
        analysis: result.analysis,
        rawResponse: result.rawResponse,
      });
    } catch (err) {
      logAndSwallow(err, `[summarize] error on session=${sessionId}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clean project files and reset session ──
  app.post('/api/session/:sessionId/clean', async (_req, res) => {
    try {
      // 1. Stop running containers AND wipe volumes (destroys DB data on disk).
      //    The -v flag is the whole point — without it, postgres data survives
      //    and "clean" leaves a confused state. Best-effort: if compose isn't
      //    installed or the project has no compose file, skip silently.
      for (const binary of ['docker compose', 'docker-compose']) {
        try {
          execSync(`${binary} down -v --remove-orphans`, {
            cwd: WORKSPACE_DIR,
            stdio: 'pipe',
            timeout: COMPOSE_DOWN_DEEP_MS,
          });
          break; // success — no need to try the v1 fallback
        } catch (err) {
          // Only try the next binary if this one isn't available at all
          if (!/not found|unknown|is not a docker command/i.test(err.message || '')) break;
        }
      }

      // Belt-and-braces volume purge with VERIFICATION. A failed `down -v`
      // (observed live: Docker daemon returning 500s) silently left the DB
      // volume alive — Postgres init only runs on EMPTY volumes, so the
      // next app ran against the previous app's schema and five endpoints
      // hung on a missing column. Containers first (volumes can't be
      // removed while attached), then volumes, then verify.
      try {
        const project = path.basename(WORKSPACE_DIR).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        try {
          const stale = execFileSync('docker', ['ps', '-aq', '--filter', `name=${project}`], { stdio: 'pipe', timeout: 15_000 }).toString().trim();
          if (stale) execFileSync('docker', ['rm', '-f', ...stale.split('\n')], { stdio: 'pipe', timeout: 30_000 });
        } catch { /* no stale containers */ }
        const vols = execSync('docker volume ls --format {{.Name}}', { stdio: 'pipe', timeout: 15_000 })
          .toString().split('\n').filter((v) => v.startsWith(`${project}_`));
        for (const v of vols) {
          try { execSync(`docker volume rm -f ${v}`, { stdio: 'pipe', timeout: 20_000 }); tlog('[session] Clean: removed volume %s', v); }
          catch (e) { terr('[session] Clean: volume %s NOT removed — next build may see a stale schema: %s', v, (e.message || '').slice(0, 150)); }
        }
        const left = execSync('docker volume ls --format {{.Name}}', { stdio: 'pipe', timeout: 15_000 })
          .toString().split('\n').filter((v) => v.startsWith(`${project}_`));
        if (left.length) terr('[session] Clean: %d project volume(s) STILL present: %s', left.length, left.join(', '));
      } catch (err) { logAndSwallow(err, '[session] Clean: volume purge failed'); }

      // 2. Kill active Cline processes so nothing races with file deletion.
      killAllProcs(activeSession);

      // 3. Manifest-driven wipe — use .template-manifest.yml as the declared
      //    whitelist of template-owned paths. Anything else in the AI-editable
      //    scope folders gets removed, regardless of whether it's committed to
      //    git (users may commit AI-generated code; Clean must still wipe it
      //    back to the template baseline).
      //
      //    We explicitly do NOT use `git clean` or `git checkout HEAD --` on
      //    whole scope folders — that would preserve committed AI work.
      const templatePaths = loadTemplateWhitelist(WORKSPACE_DIR);

      // Clean-script-only additions: baseline files that are part of the
      // starting template state but not listed in the manifest (the manifest
      // has specific semantics for template-sync and we don't want to bloat
      // it with Clean-only concerns). Kept out of the manifest intentionally.
      const CLEAN_EXTRA_KEEPS = [
        'database/init/init.sql',
        'vectordb/init/init.sql',
      ];
      for (const p of CLEAN_EXTRA_KEEPS) templatePaths.add(p);

      const cleaned = [];
      const SCOPE_FOLDERS = ['frontend', 'backend', 'database', 'vectordb'];

      for (const scope of SCOPE_FOLDERS) {
        const scopeAbs = path.join(WORKSPACE_DIR, scope);
        if (!existsSync(scopeAbs)) continue;

        // Template-owned paths INSIDE this scope folder.
        const keep = new Set();
        for (const p of templatePaths) {
          if (p === scope || p.startsWith(scope + '/')) keep.add(p);
        }
        // Keep the scope folder itself AND any ancestor dir of a kept file
        // (so we don't wipe `vectordb/init/` just because its parent path
        //  only appears via `vectordb/init/init.sql`).
        const keepAncestors = new Set([scope]);
        for (const p of keep) {
          const parts = p.split('/');
          for (let i = 1; i < parts.length; i++) {
            keepAncestors.add(parts.slice(0, i).join('/'));
          }
        }

        function walkAndClean(absDir, relDir) {
          let children;
          try { children = readdirSync(absDir, { withFileTypes: true }); }
          catch { return; }
          for (const entry of children) {
            const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
            const entryAbs = path.join(absDir, entry.name);

            if (keep.has(entryRel)) continue; // template file — keep
            if (keepAncestors.has(entryRel) && entry.isDirectory()) {
              // Ancestor of a template path — descend, don't delete wholesale.
              walkAndClean(entryAbs, entryRel);
              continue;
            }
            // Not in whitelist — wipe (works for tracked, untracked, ignored).
            try {
              rmSync(entryAbs, { recursive: true, force: true });
              cleaned.push(entryRel);
            } catch { /* best-effort */ }
          }
        }
        walkAndClean(scopeAbs, scope);
      }

      // AI-authored docs (build outputs, not user docs).
      // PROJECT_STATUS.md is restored via the git-checkout step below.
      // chat/prompts/*.md is deliberately excluded — those are MGA assistant
      // prompt sources, synced to MGA, not AI-generated build outputs.
      for (const rel of ['docs/architecture/USER_SCENARIOS.md', 'docs/architecture/EXAMPLES.md']) {
        const full = path.join(WORKSPACE_DIR, rel);
        if (existsSync(full)) {
          rmSync(full, { recursive: true, force: true });
          cleaned.push(rel);
        }
      }

      // 3b. Wipe user-uploaded attachments in context/ so "start fresh" truly
      //     starts fresh — keep the .gitkeep so the gitignored dir remains.
      const contextDir = path.join(WORKSPACE_DIR, 'context');
      if (existsSync(contextDir)) {
        try {
          for (const f of readdirSync(contextDir)) {
            if (f === '.gitkeep') continue;
            rmSync(path.join(contextDir, f), { recursive: true, force: true });
            cleaned.push(`context/${f}`);
          }
        } catch { /* ignore unreadable dir */ }
      }

      // 3c. Wipe durable project memory. `.harness/` (state.md, contracts.json,
      //     built.json, …) lives at the workspace ROOT — not inside any scope
      //     folder — and is neither git-tracked nor gitignored, so NEITHER the
      //     scope-folder wipe NOR the git-checkout step below would clear it.
      //     The dispatch gate (`safeHasHarnessStateMd`) reads `.harness/state.md`
      //     to decide "has a build completed here?". If it survives Clean, the
      //     next message routes to the post-build concierge instead of the
      //     planner — i.e. "Start Fresh" silently isn't fresh. Wipe it.
      const harnessDir = path.join(WORKSPACE_DIR, '.harness');
      if (existsSync(harnessDir)) {
        try {
          rmSync(harnessDir, { recursive: true, force: true });
          cleaned.push('.harness/');
        } catch { /* best-effort */ }
      }

      // 3d. Root-level integration outputs. The integration scope writes OUTSIDE
      //     the scope folders (workspace root). `docker-compose.yml` is a tracked
      //     template and gets git-restored in step 5; `.env.example` is
      //     AI-generated and untracked, so it would otherwise survive. Remove any
      //     root artifact that isn't a tracked template (those are git-restored).
      for (const rel of ['.env.example', '.env']) {
        const full = path.join(WORKSPACE_DIR, rel);
        if (!existsSync(full)) continue;
        let tracked = false;
        try {
          execSync(`git ls-files --error-unmatch "${rel}"`, {
            cwd: WORKSPACE_DIR, stdio: 'pipe', timeout: GIT_CHECKOUT_MS,
          });
          tracked = true; // tracked template — leave it to git-checkout in step 5
        } catch { /* not tracked — AI-generated, safe to remove */ }
        if (!tracked) {
          try { rmSync(full, { force: true }); cleaned.push(rel); }
          catch { /* best-effort */ }
        }
      }

      // 4. In template init dirs, drop anything that's NOT the template file.
      //    Applies to both database/init (missing from the old list — bug) and
      //    vectordb/init. The template `init.sql` is re-asserted via git
      //    checkout in step 5.
      for (const dir of ['database/init', 'vectordb/init']) {
        const full = path.join(WORKSPACE_DIR, dir);
        if (!existsSync(full)) continue;
        try {
          for (const f of readdirSync(full)) {
            if (f === 'init.sql') continue;
            rmSync(path.join(full, f), { recursive: true, force: true });
            cleaned.push(`${dir}/${f}`);
          }
        } catch { /* ignore unreadable dir */ }
      }

      // 5. Restore git-tracked template files to HEAD. Run each separately so
      //    one "not tracked" error doesn't block the rest — the old code
      //    passed them all to one git command and swallowed every failure.
      const trackedTemplates = [
        'docker-compose.yml',
        'database/init/init.sql',
        'vectordb/init/init.sql',
        'frontend/Dockerfile',
        'docs/PROJECT_STATUS.md',
      ];
      for (const file of trackedTemplates) {
        try {
          execSync(`git checkout HEAD -- "${file}"`, {
            cwd: WORKSPACE_DIR, stdio: 'pipe', timeout: GIT_CHECKOUT_MS,
          });
          cleaned.push(`reset:${file}`);
        } catch { /* not tracked or nothing to restore — fine */ }
      }

      // Reset session — in-memory state AND persistent index entry.
      // Without removing from the session index, the stale session keeps
      // appearing in "Welcome Back" / resume-session flows pointing at a
      // coderConversationId whose underlying work was just wiped. Starting
      // clean means the session index forgets too.
      const clearedSessionId = activeSession?.id || null;
      // Clean up any MGA assistants created during /confirm — best-effort.
      // Orphans (sessions deleted while inactive) caught by mga-cleanup-stale.
      if (activeSession?.createdMgaAssistantIds?.length) {
        try {
          const { deleteAssistant } = await import('../agent/llm/mga-assistant.js');
          const creds = getCredentials();
          for (const id of activeSession.createdMgaAssistantIds) {
            try {
              await deleteAssistant(id, creds);
              tlog('[session] Deleted MGA assistant %s on clean', id);
            } catch (e) {
              tlog('[session] Failed to delete MGA assistant %s on clean: %s', id, e.message);
            }
          }
        } catch (e) {
          tlog('[session] MGA cleanup skipped on clean: %s', e.message);
        }
      }
      if (activeSession) {
        appendEvent(activeSession.id, 'status', { status: 'reset' });
        clearPendingPlan(activeSession.id);
        activeSession = null;
      }
      if (clearedSessionId) {
        try { removeSession(clearedSessionId); } catch { /* best-effort */ }
      }

      tlog('[session] Project cleaned: %d items removed/reset%s', cleaned.length,
        clearedSessionId ? ` (session ${clearedSessionId.slice(0, 8)}… removed from index)` : '');
      res.json({ ok: true, cleaned });
    } catch (err) {
      logAndSwallow(err, '[session] Clean failed');
      res.status(500).json({ error: 'Failed to clean project: ' + err.message });
    }
  });

  app.post('/api/session/:sessionId/reset', (_req, res) => {
    if (activeSession) {
      killAllProcs(activeSession);
      appendEvent(activeSession.id, 'status', { status: 'reset' });
      clearPendingPlan(activeSession.id);
      activeSession = null;
    }
    res.json({ ok: true });
  });

  // ── Cancel: kill all active Cline processes, go idle — keeps conversation history ──
  app.post('/api/session/:sessionId/cancel', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // W1.TEL Section M item 7 — typed user_action event alongside the
    // legacy cline event below.
    emitUserAction(session.id, 'cancel');

    // Set cancellation flag BEFORE killing procs so the orchestrator's
    // spawn handlers see it when killed processes' close events resolve.
    cancelScopedPhases(session);
    killAllProcs(session);
    // Discard any pending plan too
    session.pendingPlan = null;
    clearPendingPlan(session.id);

    // W2.DISPATCH — drop any queued iteration messages. Cancel implies the
    // user is rethinking — they can re-send if needed. Without this the
    // queue would drain immediately after the cancel idle-flip and start a
    // new build the user just asked to stop.
    if (Array.isArray(session.iterationQueue) && session.iterationQueue.length > 0) {
      tlog('[iteration-queue] cancel: dropping %d queued messages',
        session.iterationQueue.length);
      session.iterationQueue = [];
    }

    session.status = 'idle';
    const cancelledEvent = appendEvent(session.id, 'cline', {
      say: 'text',
      text: '⏹ Task cancelled. You can describe what you\'d like to build instead.',
    });
    sessionEvents.emit('event', session.id, cancelledEvent);

    const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
    sessionEvents.emit('event', session.id, idleEvent);

    tlog('[session] Task cancelled by user: %s', session.id);
    res.json({ ok: true });
  });

  // ── Open-app: user answered "yes" to the auto-start prompt ──────────
  // We keep a formal app_ready event in history so reloads show the link.
  app.post('/api/session/:sessionId/open-app', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const pending = session.pendingAppOpen;
    if (!pending) return res.status(400).json({ error: 'No app is waiting to be opened' });

    session.pendingAppOpen = null;

    const readyEvent = appendEvent(session.id, 'app_ready', {
      url: pending.url,
      text: `Your app is running at ${pending.url}`,
    });
    sessionEvents.emit('event', session.id, readyEvent);

    res.json({ ok: true, url: pending.url });
  });

  // ── Close-app: user answered "no" — stop containers, dismiss the prompt ─
  app.post('/api/session/:sessionId/close-app', async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const pending = session.pendingAppOpen;
    session.pendingAppOpen = null;
    // Respond immediately — compose down can take a few seconds.
    res.json({ ok: true });

    const stopped = runCompose('down', { timeout: COMPOSE_DOWN_MS });
    if (!stopped.ok) {
      terr('[session] close-app: compose down failed: %s', stopped.stderr);
    }
    const msg = stopped.ok
      ? 'App stopped. Ask me to run it again any time.'
      : `I tried to stop the app but compose down reported: ${stopped.stderr || 'unknown error'}. You may need to stop it manually.`;
    const textEvent = appendEvent(session.id, 'cline', { say: 'text', text: msg });
    sessionEvents.emit('event', session.id, textEvent);
  });

  // ── Start the app deterministically (mirror of close-app) ────────────
  // The "Start application" quick action previously sent a PROMPT through
  // the concierge, which could (and did, observed live) decide to `respond`
  // with text telling the user to click the button they had just clicked —
  // containers never started. Starting an app is not an AI decision: this
  // endpoint runs compose up + the full post-compose verification (pending
  // migrations, endpoint probe, visual check, honest app-ready message).
  app.post('/api/session/:sessionId/start-app', async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!existsSync(path.join(WORKSPACE_DIR, 'docker-compose.yml'))) {
      return res.status(400).json({ error: 'No docker-compose.yml — build an app first' });
    }
    if (session.startAppInFlight) return res.status(409).json({ error: 'Start already in progress' });
    session.startAppInFlight = true;
    emitUserAction(session.id, 'start-app', {});
    // Respond immediately — build + up + verification takes a while; progress
    // arrives through the normal session event stream.
    res.json({ ok: true });

    try {
      const startedEvent = appendEvent(session.id, 'cline', { say: 'text', text: 'Starting your app — building and bringing containers up…' });
      sessionEvents.emit('event', session.id, startedEvent);
      const built = runCompose('build', { timeout: COMPOSE_BUILD_MS });
      if (!built.ok) throw new Error(`compose build failed: ${(built.stderr || '').slice(0, 400)}`);
      const up = runCompose('up -d', { timeout: COMPOSE_UP_MS });
      if (!up.ok) throw new Error(`compose up failed: ${(up.stderr || '').slice(0, 400)}`);
      const envContext = await gatherEnvContext();
      await runSmokeAndPrompt(session, envContext);
    } catch (err) {
      terr('[session] start-app failed: %s', err.message);
      const msg = `I couldn't start the app: ${err.message}\n\nAsk me to debug this and I'll look at the compose output.`;
      const textEvent = appendEvent(session.id, 'cline', { say: 'text', text: msg });
      sessionEvents.emit('event', session.id, textEvent);
    } finally {
      session.startAppInFlight = false;
    }
  });

  // ── Confirm: execute the pending plan that was shown in plan_preview ──
  app.post('/api/session/:sessionId/confirm', async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.pendingPlan) return res.status(400).json({ error: 'No pending plan to confirm' });
    if (session.status === 'working') return res.status(409).json({ error: 'Already working' });

    // W1.TEL Section M item 7 — typed user_action event.
    emitUserAction(session.id, 'confirm', { taskCount: session.pendingPlan.tasks?.length || 0 });

    const {
      tasks,
      flags: pendingFlags,
      envContext,
      uploads,
      dataModel,
      apiContract,
      vectorEngine,
      uiContract,
      businessLogicContract,
      mgaAssistants,
      contractAgentMessages,
      modulePlan: pendingModulePlan,
      confidence: pendingConfidenceRaw,
      reasonCodes: pendingReasonCodesRaw,
    } = session.pendingPlan;
    // Null when the plan was reloaded from disk after a server restart.
    const envCtx = envContext || await refreshEnvContext();
    const pendingConfidence = typeof pendingConfidenceRaw === 'number' ? pendingConfidenceRaw : 1.0;
    const pendingPlanLen = Array.isArray(pendingModulePlan) ? pendingModulePlan.length : 0;
    const pendingReasonCodes = Array.isArray(pendingReasonCodesRaw) ? pendingReasonCodesRaw : [];
    session.pendingPlan = null;
    clearPendingPlan(session.id);
    res.json({ ok: true });

    // Execute the held plan asynchronously
    try {
      session.status = 'working';
      sessionEvents.emit('event', session.id, {
        ts: Date.now(), type: 'status', payload: { status: 'working' },
      });

      tlog('[session] Confirm: executing held plan (%d tasks, %d attached files)',
        tasks.length, Array.isArray(uploads) ? uploads.length : 0);

      // ── Pre-stage Dockerfiles from router-emitted task.dockerfile ──
      // The router picks the canonical Dockerfile filename per task (set in
      // router.md output contract). We copy the template from
      // `<scope>/<dockerfile>` (the template's component-root Dockerfiles —
      // `backend/Dockerfile.node`, `database/Dockerfile.postgres`, etc. — which
      // .template-manifest.yml whitelists so they survive Clean) into
      // `<scope>/Dockerfile` BEFORE phase agents dispatch, so agents focus on
      // app code and never touch Dockerfile authoring. The auto-fill safety net
      // in agent.js (ensureScopeDockerfile) stays as a defensive backstop for
      // older router outputs that omit the field.
      try {
        const fs = await import('node:fs');
        for (const t of tasks) {
          if (!t || !t.scope || !t.dockerfile) continue;
          const src = path.join(WORKSPACE_DIR, t.scope, t.dockerfile);
          const dest = path.join(WORKSPACE_DIR, t.scope, 'Dockerfile');
          if (!fs.existsSync(src)) {
            tlog('[session] Pre-stage skipped scope=%s — template %s not on disk', t.scope, t.dockerfile);
            continue;
          }
          if (fs.existsSync(dest)) continue; // user already has one
          try {
            // Create the scope folder if it doesn't exist yet. Previously
            // the workspace was bootstrapped from a sibling template repo
            // that pre-created backend/, frontend/, etc.; with the bootstrap
            // removed (2026-05-21, post-spike-becomes-main migration) the
            // workspace starts empty and we have to ensure the destination
            // parent exists before copy.
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            tlog('[session] Pre-staged %s/Dockerfile from %s', t.scope, t.dockerfile);
          } catch (err) {
            logAndSwallow(err, `[session] Pre-stage FAILED scope=${t.scope}`);
          }
        }
      } catch (err) {
        logAndSwallow(err, '[session] Dockerfile pre-stage step failed (non-fatal)');
      }

      // ── Pre-stage nginx configs when frontend is in scope ─────────────
      // The Dockerfile.react template's runtime stage runs `nginx -g 'daemon off;'`
      // and expects /etc/nginx/conf.d/default.conf to be configured. Production:
      // mounts `frontend/nginx.conf` (no /api proxy — Traefik handles it). Local
      // dev compose: mounts `frontend/nginx.local.conf` (with /api proxy →
      // backend:3000). Both files need to exist on disk before compose build,
      // OR the build copies them into the image. Canonical sources live at
      // snippets/frontend/nginx-{production,local-proxy}.conf — no scope agent
      // should be authoring nginx by hand (it's platform-mandated).
      try {
        const fs = await import('node:fs');
        const hasFrontend = tasks.some((t) => t && t.scope === 'frontend');
        if (hasFrontend) {
          const nginxCopies = [
            { from: 'snippets/frontend/nginx-production.conf', to: 'frontend/nginx.conf' },
            { from: 'snippets/frontend/nginx-local-proxy.conf', to: 'frontend/nginx.local.conf' },
          ];
          for (const { from, to } of nginxCopies) {
            const src = path.join(WORKSPACE_DIR, from);
            const dest = path.join(WORKSPACE_DIR, to);
            if (!fs.existsSync(src)) {
              tlog('[session] Pre-stage skipped nginx — template %s not on disk', from);
              continue;
            }
            if (fs.existsSync(dest)) continue;
            try {
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.copyFileSync(src, dest);
              tlog('[session] Pre-staged %s from %s', to, from);
            } catch (err) {
              logAndSwallow(err, `[session] Pre-stage FAILED ${to}`);
            }
          }
        }
      } catch (err) {
        logAndSwallow(err, '[session] nginx pre-stage step failed (non-fatal)');
      }

      // ── Pre-stage MGA assistants from router-emitted mga_assistants[] ──
      // Walk the top-level array (one entry = one assistant), POST /assistants
      // on the MGA platform for each, attach tools, and write
      // MGA_API_KEY/MGA_BASE_URL/MGA_ASSISTANT_ID + MGA_ASSISTANT_ID_<KEY>
      // for each entry to a workspace-root .env.
      //
      // Failure policy: FATAL when the user asked for AI features. Shipping
      // a chatbot whose backing assistant failed to provision is shipping
      // broken code — the user clicked "build a chatbot" and the chatbot
      // has no brain. Better to abort, surface the error, let the user
      // retry or decide to remove the AI feature. If mga_assistants is
      // empty (router emitted no AI specs), this whole block is a no-op
      // and the build proceeds normally for non-AI apps.
      //
      // MGA_SKIP_PRESTAGE=true (set by smoke runs): skip the actual POST
      // calls to keep the smoke gate fast and orphan-free, but still write
      // a placeholder .env so downstream subagents get the env var names.
      // Real e2e validation is manual.
      const specs = Array.isArray(mgaAssistants) ? mgaAssistants : [];
      if (specs.length > 0) {
        const { provisionMgaAssistants } = await import('./mga-provisioning.js');
        const prov = await provisionMgaAssistants(session, specs,
          { apiContract, dataModel, businessLogicContract, uiContract }, { getCredentials });
        if (!prov.ok) {
          const event = appendEvent(session.id, 'cline', {
            say: 'text',
            text: `[mga] ${prov.error}\n\nThe app needs a working MGA assistant for its AI feature. Build aborted before code generation. Check MGA connectivity (https://chat.int.bayer.com/api/v2 reachable? API key valid?), then re-confirm.`,
          });
          sessionEvents.emit('event', session.id, event);
          const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
          sessionEvents.emit('event', session.id, idleEvent);
          return;
        }
      }

      const msgStart = Date.now();
      // Phase C continuation routing: when the router emits a single task
      // whose scope matches the last successfully-dispatched subagent's
      // scope, skip the orchestrator hop and dispatch direct to that
      // subagent — reusing its MGA conversation_id so the assistant has
      // full prior context. Multi-scope tasks or scope-switches go through
      // the orchestrator.
      const VALID_SUBAGENT_SCOPES = ['database', 'backend', 'frontend', 'vectordb', 'integration'];
      const isSameScopeContinuation =
        session.lastActiveSubagentScope &&
        tasks.length === 1 &&
        tasks[0].scope === session.lastActiveSubagentScope &&
        VALID_SUBAGENT_SCOPES.includes(tasks[0].scope);

      let result;
      if (isSameScopeContinuation) {
        const scope = tasks[0].scope;
        const enrichedMessage = buildPromptFromSpec({ tasks }, envCtx, { uploads });
        const priorConvo = session.coderConversationIds?.[scope] || null;
        tlog('[session] Continuation: direct-to-subagent scope=%s convo=%s (skipping orchestrator)',
          scope, priorConvo || 'new');
        emitScopeStatus(session.id, { scope, status: 'running' });
        const { runCustomAgent } = await import('../agent/agent.js');
        result = await runCustomAgent(session.id, enrichedMessage, {
          conversationId: priorConvo,
          scope,
          priorTokenTotals: session.coderTokenTotals || null,
          phase: PHASES.SUBAGENT,
        });
        if (result.conversationId) {
          session.coderConversationIds = session.coderConversationIds || {};
          session.coderConversationIds[scope] = result.conversationId;
        }
        accumulateAgentTotals(session, result);
        emitScopeStatus(session.id, { scope, status: 'completed', exitCode: result.exitCode });
      } else {
        // Fresh task / multi-scope / scope-switch: dispatch via the
        // deterministic build-dispatcher. Replaces runLlmOrchestrator (per
        // the "deterministic where possible" architectural decision —
        // dispatch order and sync/background grouping are prompt-hardcoded
        // in practice, so a JS loop saves ~20-40K tokens + ~50-70s of
        // latency per build without behaviour change). Single-scope fresh
        // tasks still go through this path; JS-fanout was retired in Phase C.
        // Hybrid module layer — runs before build-dispatcher to optionally
        // enrich the contract. Falls through unchanged when flag is off,
        // modulePlan is null, or confidence is below threshold.
        let dispatchTasks = tasks;
        let dispatchDataModel = dataModel;
        let dispatchApiContract = apiContract;
        let dispatchVectorEngine = vectorEngine;
        let dispatchUiContract = uiContract;
        let dispatchBusinessLogicContract = businessLogicContract;
        try {
          const { runHybridRouter } = await import('../agent/hybrid-router.js');
          const hybridResult = await runHybridRouter({
            modulePlan: pendingModulePlan || null,
            confidence: pendingConfidence,
            contract: { tasks, dataModel, apiContract, vectorEngine, uiContract, businessLogicContract },
            session,
            envContext: envCtx,
          });
          // Persist module state on session so concierge + session-state can read it.
          session.lastModulePlan = hybridResult.modulePlan || null;
          session.lastReasonCodes = (hybridResult.reasonCodes && hybridResult.reasonCodes.length > 0)
            ? hybridResult.reasonCodes
            : pendingReasonCodes;
          if (hybridResult.modulesRan) {
            const c = hybridResult.contract;
            dispatchTasks = c.tasks;
            dispatchDataModel = c.dataModel;
            dispatchApiContract = c.apiContract;
            dispatchVectorEngine = c.vectorEngine;
            dispatchUiContract = c.uiContract;
            dispatchBusinessLogicContract = c.businessLogicContract;
            tlog(
              `[confirm] hybrid-router: modules ran, contract enriched (confidence=${pendingConfidence.toFixed(2)}, modulePlanLen=${pendingPlanLen})`,
            );
          } else {
            tlog(
              `[confirm] hybrid-router: skipped (${hybridResult.skippedReason || 'no-plan'}) (confidence=${pendingConfidence.toFixed(2)}, modulePlanLen=${pendingPlanLen})`,
            );
          }
        } catch (err) {
          logAndSwallow(err, '[confirm] hybrid-router failed (non-fatal, proceeding deterministic)');
        }

        result = await runBuildDispatch(dispatchTasks, envCtx, session, { uploads, dataModel: dispatchDataModel, apiContract: dispatchApiContract, vectorEngine: dispatchVectorEngine, uiContract: dispatchUiContract, businessLogicContract: dispatchBusinessLogicContract, flags: pendingFlags || [], mgaAssistants: mgaAssistants || [] });

        // Deterministic end-of-build authoring — replaces the LLM
        // orchestrator's write_harness_state tool call + LLM-authored build
        // report. State.md + contract types are telemetry-class writes
        // (must not block); the build report is emitted as a cline
        // completion_result event so the existing UI rendering path picks
        // it up unchanged. Skip when the dispatcher produced no scopes
        // (would write a meaningless "failed" placeholder).
        if (dispatchProducedScopes(result)) {
          try {
            // Initial build: priorBuilt=null so generateBuildSummary returns
            // a fresh map from current dispatch alone (all 5 scopes typically).
            // We still write built.json so iterate paths can read it later
            // instead of falling back to state.md parsing.
            const { stateMd, buildReport, built } = generateBuildSummary({
              contract: { tasks: dispatchTasks, dataModel: dispatchDataModel, apiContract: dispatchApiContract, vectorEngine: dispatchVectorEngine, uiContract: dispatchUiContract, businessLogicContract: dispatchBusinessLogicContract, mgaAssistants },
              completionReports: result.completionReports,
              dispatchedScopes: result.dispatchedScopes,
              iterate: null,
            });
            try { writeStateMd(WORKSPACE_DIR, stateMd); }
            catch (err) { logAndSwallow(err, '[confirm] writeStateMd failed'); }
            try { writeBuilt(WORKSPACE_DIR, built); }
            catch (err) { logAndSwallow(err, '[confirm] writeBuilt failed'); }
            try { generateContractTypes(WORKSPACE_DIR); }
            catch (err) { logAndSwallow(err, '[confirm] generateContractTypes failed'); }
            const reportEvent = appendEvent(session.id, 'cline', {
              say: 'completion_result',
              text: buildReport,
            });
            sessionEvents.emit('event', session.id, reportEvent);
          } catch (err) {
            logAndSwallow(err, '[confirm] build summary generation failed');
          }
        }
      }
      tlog('[session] Confirm: plan executed (%dms, exit=%s)', Date.now() - msgStart, result.exitCode);

      const totalMs = Date.now() - msgStart;
      const completedScopes = tasks.map(t => t.scope);
      const completionText = completedScopes.length > 1
        ? `All ${completedScopes.length} tasks completed (${completedScopes.join(', ')}) in ${Math.round(totalMs / 1000)}s.`
        : `Task completed in ${Math.round(totalMs / 1000)}s. You can now test your application or ask me to make changes.`;
      const completionEvent = appendEvent(session.id, 'completion', {
        text: completionText, scopes: completedScopes, totalMs,
      });
      sessionEvents.emit('event', session.id, completionEvent);

      if (activeSession?.id === session.id) {
        session.hasExecuted = true;
        // Track last-active subagent scope for next-turn continuation routing.
        // Single-scope success → set to that scope (next same-scope turn skips
        // the orchestrator). Multi-scope or failure → clear (next turn replans).
        if (result.exitCode === 0 && tasks.length === 1 && VALID_SUBAGENT_SCOPES.includes(tasks[0].scope)) {
          session.lastActiveSubagentScope = tasks[0].scope;
        } else {
          session.lastActiveSubagentScope = null;
        }
        upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
      }

      // ── Auto-start: boot the app and ask the user if they want to open it.
      //   - Only when the plan succeeded (exit code 0).
      //   - Only when there's a docker-compose.yml to boot (tryAutoStartApp
      //     handles the "no compose" case internally).
      //   - Cancellation mid-plan skips this whole branch.
      //
      // tryAutoStartApp is the authoritative build oracle: it runs the
      // cross-scope reconciler, deterministic validators, `docker-compose
      // build` + `up -d` + waitForHttp + backend log scan. Failures there
      // surface a clear diagnostic to the user.
      if (result.exitCode === 0 && !session.cancelled) {
        try {
          tlog('[session] DEBUG: entering tryAutoStartApp');
          await tryAutoStartApp(session, envContext, {
            dataModel, apiContract, uiContract, businessLogicContract,
            // Pass tasks so the reconciler-judge can read scope summaries
            // as "build intent" — needed to decide whether an extra fits
            // the app's purpose (e.g., /admin route on a single-user
            // tracker = noise; same route on team admin app = legitimate).
            tasks,
            // PR 2 / Alt A — the contract agent's messages[] so the
            // reconciler-judge can continue the conversation it started
            // when emitting the contract. May be null if planner fell
            // back to legacy /chat/agent.
            contractAgentMessages,
          });
          tlog('[session] DEBUG: tryAutoStartApp resolved');
        } catch (err) { logAndSwallow(err, '[session] Auto-start failed (non-fatal)'); }
      } else if (!session.cancelled) {
        // Dispatch (runLlmOrchestrator or continuation-direct) returned
        // exitCode != 0 — e.g. orchestrator hit MAX_ITERATIONS while polling
        // phase agents, or a phase agent threw. Auto-start is moot — there's
        // nothing to validate. Without this branch the smoke harness sits
        // with no terminal signal until its 12-min wall clock fires (observed
        // on t11 ORCH in the 2026-05-04 final gate).
        tlog('[session] Auto-start skipped — dispatch failed (exitCode=%d)', result.exitCode);
        emitScopeStatus(session.id, { scope: 'auto-start', status: 'skipped', reason: 'dispatch failed' });
      }

      // W1.TEL Section M item 6 — write one run-summary record per build /
      // iteration. Pulls per-call costUsd + tokens + MGA-call count from the
      // session's run-logs/<sessionId>/<phase>/llm-calls.jsonl files. The
      // reconcilerVerdicts + snippetFetches columns are reserved as zeroed
      // defaults — W3.TEL fills them.
      tlog('[session] DEBUG: about to writeRunSummary');
      try {
        const stats = aggregateSessionLlmStats(session.id, { sinceTs: msgStart });
        // Status: exit-zero AND not cancelled → 'built'; exit-non-zero non-
        // cancelled → 'partial'; cancelled → 'partial' (we still wrote files
        // but didn't reach attempt_completion). 'infeasible' is reserved for
        // a future router signal (W2.ROUTER) — never emitted today.
        const status = (result?.exitCode === 0 && !session.cancelled) ? 'built'
                     : (session.cancelled ? 'partial' : 'partial');
        writeRunSummary(session.id, {
          intent: tasks?.[0]?.summary || null,
          action: 'execute', // W2.ROUTER will widen this to iterate/diagnose
          startedAt: msgStart,
          endedAt: Date.now(),
          totalMs: Date.now() - msgStart,
          scopes: completedScopes,
          status,
          tokens: stats.tokens,
          costUsd: stats.costKnown ? Math.round(stats.costUsd * 1_000_000) / 1_000_000 : null,
          mgaCalls: stats.mgaCalls,
          toolCalls: stats.toolCalls,
          // session.reengageCount isn't tracked today (Section F territory);
          // empty map for now, W3.RECOV will populate.
          retryAttemptsByScope: session.retryAttemptsByScope || {},
          // W3.TEL — same per-build sinks as the iterate branch above. The
          // defaults guarantee key presence so runs-report.js's aggregator
          // can rely on it regardless of whether the build actually hit
          // every code path (e.g. an early-aborted build with no investigator).
          reconcilerVerdicts: session.reconcilerVerdictCounts
            || { ok: 0, mismatch: 0, legitimate: 0, noise: 0 },
          snippetFetches: getSnippetFetchMirror(session.id),
          autoRecoveryAttempts: session.autoRecoveryAttempts || [],
          investigatorRecords: session.investigatorRecords || [],
          contractAttempt: session.lastContractAttempt || null,
          endpointProbe: session.endpointProbeSummary || null,
          uiSanity: session.uiSanitySummary || null,
          security: session.securitySummary || null,
          contractStore: {
            ...(session.contractStoreStats || { mergedKinds: [], adoptedRoutes: 0 }),
            revisionCount: (() => { try { return (readContracts(WORKSPACE_DIR)?.data?.revisions || []).length; } catch { return 0; } })(),
          },
        });
      } catch (err) {
        // writeRunSummary already wraps in logAndSwallow but belt-and-braces
        // — a stats-aggregation throw must not crash the confirm handler.
        logAndSwallow(err, '[telemetry-run-summary-write]');
      }

      tlog('[session] DEBUG: writeRunSummary done; emitting final idle event');
      if (activeSession?.id === session.id) {
        session.status = 'idle';
      }
      const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, idleEvent);
      tlog('[session] DEBUG: idle event emitted');

      // W2.DISPATCH — drain any messages queued during this confirm-driven
      // build (status was 'working' while they arrived).
      maybeDrainIterationQueue(session, dispatchQueuedMessage);
    } catch (err) {
      logAndSwallow(err, '[session] Confirm execution failed');
      if (activeSession?.id === session.id) {
        session.status = 'error';
      }
      const errEvent = appendEvent(session.id, 'status', { status: 'error', error: err.message });
      sessionEvents.emit('event', session.id, errEvent);
    }
  });

  // ── Revise: user wants changes to the plan before confirming ──
  // Discard the current plan and send user feedback as a new message through the router.
  app.post('/api/session/:sessionId/revise', async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'working') return res.status(409).json({ error: 'Already working' });

    const { feedback } = req.body;
    if (!feedback) return res.status(400).json({ error: 'feedback is required' });

    // W1.TEL Section M item 7 — typed user_action event.
    emitUserAction(session.id, 'revise', { feedbackLen: (feedback || '').length });

    // Hold onto uploads across the revise cycle — the user attached them to
    // the original request and they're still relevant for the revised plan.
    const carryUploads = session.pendingPlan?.uploads || null;

    // Discard current pending plan
    session.pendingPlan = null;
    clearPendingPlan(session.id);
    // Reset router conversation so revisions re-route fresh
    session.routerConversationId = null;
    session.routerMessages = [];
    session.clarifyRound = 0;

    res.json({ ok: true });

    // Emit a user message into the stream so the history shows the revision request
    const userEvent = appendEvent(session.id, 'user', { message: feedback });
    sessionEvents.emit('event', session.id, userEvent);

    // Re-run the full routing + plan cycle with the feedback message
    try {
      session.status = 'working';
      sessionEvents.emit('event', session.id, {
        ts: Date.now(), type: 'status', payload: { status: 'working' },
      });

      upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });

      if (middlewareReady) {
        try {
          const envContext = await refreshEnvContext();
          const routerResult = await routeMessage(feedback, envContext, {
            conversationId: null,
            priorMessages: [],
            uploads: carryUploads,
            onProgress: ({ chars, elapsedMs }) => {
              sessionEvents.emit('event', session.id, {
                ts: Date.now(), type: 'router_status', payload: { phase: 'streaming', chars, elapsedMs },
              });
            },
          });
          emitRouterSoftCorrects(session.id, routerResult);
          session.routerConversationId = routerResult.conversationId;
          // Seed history with this fresh-start turn so any subsequent clarify
          // rounds see the original revise-feedback prompt.
          session.routerMessages = [
            { role: 'user', content: routerResult.sentUserMessage },
            { role: 'assistant', content: routerResult.rawAssistantResponse },
          ];
          // W2.ROUTER — reset session-baseline char count for the prompt-size
          // cost-watch since revise starts a fresh router conversation.
          session.routerFirstMessageChars = typeof routerResult.sentUserMessage === 'string'
            ? routerResult.sentUserMessage.length
            : null;

          if (routerResult.action === 'clarify') {
            session.clarifyRound = 1;
            const clarifyEvent = appendEvent(session.id, 'cline', {
              say: 'text',
              text: routerResult.message,
              questions: routerResult.questions && routerResult.questions.length ? routerResult.questions : undefined,
            });
            sessionEvents.emit('event', session.id, clarifyEvent);
          } else {
            // Emit revised plan summary
            if (routerResult.message) {
              const summaryEvent = appendEvent(session.id, 'cline', { say: 'text', text: routerResult.message });
              sessionEvents.emit('event', session.id, summaryEvent);
            }
            // Hold for confirmation again — keep the uploads attached.
            // Step 7d/7e: also persist data_model + api_contract + vector_engine
            // through the revise→confirm gap.
            session.pendingPlan = {
              tasks: routerResult.tasks,
              envContext,
              uploads: carryUploads,
              dataModel: routerResult.dataModel || null,
              apiContract: routerResult.apiContract || null,
              vectorEngine: routerResult.vectorEngine || null,
              uiContract: routerResult.uiContract || null,
              businessLogicContract: routerResult.businessLogicContract || null,
              mgaAssistants: routerResult.mgaAssistants || [],
              contractAgentMessages: routerResult.contractAgentMessages || null,
              // Hybrid module plan fields
              modulePlan: routerResult.modulePlan || null,
              confidence: typeof routerResult.confidence === 'number' ? routerResult.confidence : 1.0,
              reasonCodes: Array.isArray(routerResult.reasonCodes) ? routerResult.reasonCodes : [],
              // RAG architecture decision
              ragArchitecture: routerResult.ragArchitecture || null,
            };
            savePendingPlan(session.id, session.pendingPlan);
            const planPreviewEvent = appendEvent(session.id, 'plan_preview', {
              message: routerResult.message || '',
              tasks: routerResult.tasks.map(t => ({
                scope: t.scope,
                summary: t.summary || '',
                task: t.task,
              })),
              flags: routerResult.flags || [],
              dataModel: routerResult.dataModel || null,
              apiContract: routerResult.apiContract || null,
              vectorEngine: routerResult.vectorEngine || null,
              uiContract: routerResult.uiContract || null,
              businessLogicContract: routerResult.businessLogicContract || null,
              mgaAssistants: routerResult.mgaAssistants || [],
            });
            sessionEvents.emit('event', session.id, planPreviewEvent);
            session.routerConversationId = null;
            session.routerMessages = [];
            session.clarifyRound = 0;
          }
        } catch (err) {
          logAndSwallow(err, '[session] Revise: router failed');
          const errEvent = appendEvent(session.id, 'cline', {
            say: 'text',
            text: `Sorry, I couldn't revise the plan: ${err.message}. Please try again.`,
          });
          sessionEvents.emit('event', session.id, errEvent);
        }
      }

      session.status = 'idle';
      upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
      const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, idleEvent);
    } catch (err) {
      logAndSwallow(err, '[session] Revise failed');
      if (activeSession?.id === session.id) {
        session.status = 'error';
      }
      const errEvent = appendEvent(session.id, 'status', { status: 'error', error: err.message });
      sessionEvents.emit('event', session.id, errEvent);
    }
  });

  // ── Pause: kill all active agent processes, go idle ──
  app.post('/api/session/:sessionId/pause', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // W1.TEL Section M item 7 — typed user_action event.
    emitUserAction(session.id, 'pause');

    killAllProcs(session);

    session.pausedAt = Date.now();
    session.status = 'idle';

    const pausedEvent = appendEvent(session.id, 'cline', {
      say: 'text',
      text: '⏸ Task paused.',
    });
    sessionEvents.emit('event', session.id, pausedEvent);

    const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
    sessionEvents.emit('event', session.id, idleEvent);

    tlog('[session] Task paused by user: %s', session.id);
    res.json({ ok: true });
  });

  // ── Discard: throw away pending plan, go idle so user can retype ──
  app.post('/api/session/:sessionId/discard', (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // W1.TEL Section M item 7 — typed user_action event.
    emitUserAction(session.id, 'discard');

    session.pendingPlan = null;
    clearPendingPlan(session.id);
    // Reset router conversation so next message starts fresh routing
    session.routerConversationId = null;
    session.routerMessages = [];
    session.clarifyRound = 0;

    const discardEvent = appendEvent(session.id, 'cline', {
      say: 'text',
      text: '✏️ Plan discarded. Please describe what you\'d like to build and I\'ll create a new plan.',
    });
    sessionEvents.emit('event', session.id, discardEvent);

    if (session.status !== 'idle') {
      session.status = 'idle';
      const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, idleEvent);
    }

    tlog('[session] Plan discarded by user: %s', session.id);
    res.json({ ok: true });
  });

  app.get('/api/session/:sessionId/history', (req, res) => {
    const tail = parseInt(req.query.tail) || 100;
    const sessionId = cleanSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });
    const events = readTail(sessionId, tail);
    res.json({ events });
  });

  // ── Session list & resume ──

  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: listSessions() });
  });

  // ── Rename a session ──
  app.patch('/api/session/:sessionId/rename', (req, res) => {
    const { sessionId } = req.params;
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    renameSession(sessionId, title.trim());
    tlog('[session] Renamed session %s → "%s"', logSafe(sessionId), logSafe(title.trim().slice(0, 60)));
    res.json({ ok: true });
  });

  // ── Branch: fork a session at a given user turn ──
  //
  // Creates a new session whose transcript is a copy of the source session's
  // events up to (but not including) the selected user turn, and reverts the
  // workspace files to the snapshot captured just before that turn ran.
  // Body: { fromEventTs: number } — ts of the user event to branch from.
  app.post('/api/session/:sessionId/branch', (req, res) => {
    try {
      const sourceSessionId = cleanSessionId(req.params.sessionId);
      if (!sourceSessionId) return res.status(400).json({ error: 'Invalid session id' });
      const { fromEventTs } = req.body || {};
      if (typeof fromEventTs !== 'number') {
        return res.status(400).json({ error: 'fromEventTs (number, ts of the user turn) is required' });
      }

      // 1. Locate the branch point in the source transcript.
      const allEvents = readAll(sourceSessionId);
      const idx = allEvents.findIndex(e => e.ts === fromEventTs && e.type === 'user');
      if (idx === -1) {
        return res.status(404).json({ error: 'no user event at that ts in this session' });
      }
      const branchEvent = allEvents[idx];
      const snapshotSha = branchEvent.payload?.snapshotSha || null;

      // 2. Restore workspace files to the pre-turn snapshot, if we have one.
      //    Falls back to no-restore (conversation-only branch) when the SHA is
      //    missing (turns recorded before snapshots shipped).
      let restored = false;
      if (snapshotSha && snapshotExists(sourceSessionId, snapshotSha)) {
        restored = restoreSnapshot(sourceSessionId, snapshotSha);
      }

      // 3. Create the new session (in-memory, persisted on first message —
      //    consistent with resume). Kill any active session first so we don't
      //    leave stray subagent procs pointing at the source session.
      //    Shape mirrors the resume handler (post-Cline multi-agent model); a
      //    branched session restarts the assistant's memory (fresh coder/router
      //    conversation) while the UI still shows the pre-branch transcript.
      killAllProcs(activeSession);
      const newSessionId = randomUUID();
      const now = Date.now();
      activeSession = {
        id: newSessionId,
        routerConversationId: null,
        routerMessages: [],
        routerFirstMessageChars: null,
        coderConversationId: null,
        iterationQueue: [],
        status: 'idle',
        activeProcs: new Set(),
        startedAt: now,
      };

      // 4. Seed the new transcript with the source's events up to the branch.
      //    Write directly (preserving original ts) rather than appendEvent so
      //    the pre-branch conversation renders with accurate timestamps.
      if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
      const newTranscriptPath = path.join(TRANSCRIPTS_DIR, `${newSessionId}.jsonl`);
      const eventsToCopy = allEvents.slice(0, idx);
      const seedText = eventsToCopy.map(e => JSON.stringify(e)).join('\n');
      writeFileSync(newTranscriptPath, seedText ? seedText + '\n' : '');

      // 5. Structural marker so the frontend / anyone debugging the transcript
      //    can tell this session was branched, from where, at which SHA. Not a
      //    user/cline event, so it doesn't disturb turn-grouping.
      appendEvent(newSessionId, 'status', {
        status: 'branched',
        branchedFrom: sourceSessionId,
        fromEventTs,
        snapshotSha,
        restored,
      });

      tlog('[session] Branch: %s → %s at ts=%d (restored=%s, sha=%s)',
        sourceSessionId.slice(0, 8), newSessionId.slice(0, 8),
        Number(fromEventTs), restored, snapshotSha ? snapshotSha.slice(0, 8) : 'none');

      res.json({ newSessionId, restored, snapshotSha });
    } catch (err) {
      terr('[session] Branch failed:', err.message);
      res.status(500).json({ error: 'Branch failed: ' + err.message });
    }
  });

  // ── Delete a session (index entry + transcript file) ──
  app.delete('/api/session/:sessionId', async (req, res) => {
    const sessionId = cleanSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });

    // If this is the currently active session, kill it first.
    // Delete any MGA assistants while we still have the session object —
    // once activeSession is nulled, createdMgaAssistantIds is gone.
    if (activeSession?.id === sessionId) {
      if (activeSession.createdMgaAssistantIds?.length) {
        try {
          const { deleteAssistant } = await import('../agent/llm/mga-assistant.js');
          const creds = getCredentials();
          for (const id of activeSession.createdMgaAssistantIds) {
            try {
              await deleteAssistant(id, creds);
              tlog('[session] Deleted MGA assistant %s on session delete', id);
            } catch (e) {
              tlog('[session] Failed to delete MGA assistant %s: %s', id, e.message);
            }
          }
        } catch (e) {
          tlog('[session] MGA cleanup skipped on delete: %s', e.message);
        }
      }
      killAllProcs(activeSession);
      activeSession = null;
    }

    // Remove from index
    removeSession(sessionId);

    // Remove the session's workspace-snapshot shadow repo.
    deleteSnapshotsFor(sessionId);

    // Remove transcript file — TRANSCRIPTS_DIR is imported at top of file via paths.js
    // We resolve the path the same way paths.js does (relative to CHAT_APP_DIR)
    const transcriptPath = path.join(CHAT_APP_DIR, 'chat-data', 'transcripts', `${sessionId}.jsonl`);
    try {
      if (existsSync(transcriptPath)) {
        rmSync(transcriptPath, { force: true });
      }
    } catch { /* non-fatal */ }

    tlog('[session] Deleted session %s', sessionId);
    res.json({ ok: true });
  });

  app.post('/api/session/:sessionId/resume', async (req, res) => {
    try {
      const creds = getCredentials();
      if (!creds) {
        return res.status(400).json({ error: 'Missing config' });
      }

      const sessionId = cleanSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: 'Invalid session id' });

      // If this session is already active, just return it
      if (activeSession?.id === sessionId) {
        return res.json({ sessionId });
      }

      // Kill any currently active session
      killAllProcs(activeSession);

      const sessions = listSessions();
      const entry = sessions.find(s => s.sessionId === sessionId);

      setSensitiveStrings([creds.apiKey, ...listAppSecretValues(WORKSPACE_DIR)]);

      activeSession = {
        id: sessionId,
        routerConversationId: null,
        routerMessages: [],
        // W2.ROUTER — char count of the FIRST router-call outbound message in
        // this session. Threaded into subsequent routeMessage opts so the
        // prompt-size cost-watch can compare iteration prompts against the
        // session baseline (Section M / Addition 3c). Set on round 0; never
        // overwritten thereafter.
        routerFirstMessageChars: null,
        coderConversationId: entry?.coderConversationId || null,
        // W2.DISPATCH — iteration queue. Resumed sessions start empty;
        // queue is in-memory only and doesn't survive restart.
        iterationQueue: [],
        status: 'idle',
        activeProcs: new Set(),
        startedAt: entry?.createdAt || Date.now(),
        // A plan held for confirmation survives a server restart (see
        // pending-plan-store.js); envContext is re-gathered on confirm.
        pendingPlan: loadPendingPlan(sessionId),
      };
      if (activeSession.pendingPlan) {
        tlog('[session] Resume: restored pending plan (%d task(s)) for confirmation', activeSession.pendingPlan.tasks.length);
      }
      // Restore the session-cumulative token total so a continuation grows the
      // chip instead of resetting it (coderTokenTotals is in-memory only).
      restoreCoderTokenTotals(activeSession);

      res.json({ sessionId });
    } catch (err) {
      logAndSwallow(err, '[session] Resume failed');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to resume session: ' + err.message });
      }
    }
  });

  // ── P1: Hybrid trace + approval routes ────────────────────────────────────
  // Mounted here so they share the same Express app and getSession closure.
  mountTraceRoutes(app, getSession);
  mountApprovalRoutes(app, getSession);
}
