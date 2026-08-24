/**
 * Phase-agent spawn family — orchestrator-only tools (Part B).
 *
 * These tools are available to the Orchestrator (PHASES.ORCHESTRATING) only —
 * the phase whitelist in phase.js blocks them for any other phase. They
 * dispatch a child runCustomAgent (passed via ctx to avoid a circular import
 * between tools and agent) with phase=SUBAGENT and the requested scope,
 * which routes to the matching MGA assistant (subagent-database, etc.).
 *
 * Background variants register in TaskRunner so the orchestrator can poll
 * status, inject mid-flight messages, or cancel.
 */

import {
  registerTask,
  setTaskPromise,
  getTask,
  cancelTask as runnerCancelTask,
  injectMessage,
  markCompleted,
  markFailed,
  generateTaskId,
  listTasksForSession,
} from './task-runner.js';
import { PHASES } from '../loop/phase.js';
import { buildSpawnUserMessage } from '../prompt-builder/core.js';
import { getOrchestrationContext, recordCompletionReport, markScopeInFlight, clearScopeInFlight } from '../orchestration-stash.js';
import { flagAmbiguousPaths } from '../../reconciler/ambiguous-paths.js';
import { tlog } from '../../util/timestamped-log.js';
import { ITERATE_MINIMAL_CHANGE_POLICY } from '../iterate-policy.js';
import { normalizeContractDiffs, diffHasRemovals } from '../coordinator/contract-store.js';
import { KIT_CATALOG } from '../coordinator/frontend-kit-generator.js';

// Scopes that have a dedicated subagent MGA assistant (with rules + canonical
// scaffold baked into the system prompt at upload time). The orchestrator may
// only dispatch these — phase.js's resolvePhaseAssistant rejects any other
// scope at runtime. Cross-scope contract checking is deterministic (reconciler/),
// not a phase-agent dispatch.
const SUBAGENT_SCOPES = new Set(['database', 'backend', 'frontend', 'vectordb', 'integration']);

function ctxRequireSpawn(ctx, toolName) {
  if (!ctx.runCustomAgent || !ctx.sessionId) {
    return `ERROR: ${toolName} requires sessionId + runCustomAgent in ctx (orchestrator dispatch only).`;
  }
  if ((ctx.subagentDepth || 0) > 0) {
    return `ERROR: ${toolName} cannot be called from within a phase agent. Only the orchestrator (depth 0) may dispatch.`;
  }
  return null;
}

function buildEnrichedTask({ task, context }) {
  if (!context) return task || '';
  return `${task || ''}\n\n=== CONTEXT FROM ORCHESTRATOR ===\n${context}`;
}

/**
 * Reject a spawn for a scope that has already completed in this orchestrator
 * run. Empirically observed (smoke t11-backend-db-multi, 2026-05-02): the
 * orchestrator can land in a database↔backend ping-pong where each phase
 * agent reports complete, the orchestrator notices a minor sibling-contract
 * mismatch, and re-dispatches the just-completed scope instead of advancing
 * to integration. The runtime guard hard-stops that loop with a synthetic
 * error pointing the orchestrator back at the right corrective action
 * (dispatch a different scope, or finalize via attempt_completion).
 *
 * Returns null when the spawn should proceed, or an error string to return
 * to the model. Only fires for SUBAGENT_SCOPES — any non-subagent scope is
 * rejected later by phase.js's resolvePhaseAssistant.
 */
function rejectIfScopeAlreadyCompleted(sessionId, scope) {
  if (!SUBAGENT_SCOPES.has(scope)) return null;
  const stash = getOrchestrationContext(sessionId);
  if (!stash) return null;
  const isCompleted = stash.completionReports && stash.completionReports[scope];
  const isInFlight = stash.inFlightSpawns && stash.inFlightSpawns.has(scope);
  if (!isCompleted && !isInFlight) return null;
  // List the planning-spec scopes still pending so the error is directive,
  // not just prohibitive. Empirically (smoke t11, 2026-05-02), the
  // orchestrator was correctly identifying duplicates as wrong but not
  // picking the right next scope — naming pending scopes here removes that
  // ambiguity in one shot.
  const completedScopes = Object.keys(stash.completionReports || {});
  const inFlightScopes = stash.inFlightSpawns ? Array.from(stash.inFlightSpawns) : [];
  const planningScopes = stash.tasksByScope ? Object.keys(stash.tasksByScope) : [];
  const pendingScopes = planningScopes.filter(s => !completedScopes.includes(s) && !inFlightScopes.includes(s));
  const pendingHint = pendingScopes.length > 0
    ? `Still pending in the planning spec: [${pendingScopes.join(', ')}]. Dispatch ONE of those next.`
    : `All planning-spec build scopes are completed or in-flight. Emit <attempt_completion> with the build report once in-flight scopes settle — do NOT spawn any further phase agents.`;
  // Distinguish in-flight from completed in the error message — different
  // remediation: completed = "the report is in your context, finalize"; in-flight =
  // "wait for the existing dispatch (a sync spawn or attempt_completion auto-waits)
  // before re-dispatching." Race fix: closes the Rule 1 hole where a turn-2
  // background dup-spawn slipped through because turn-1's recordCompletionReport
  // hadn't fired yet (observed on t33 ORCH 2026-05-04).
  const stateBlurb = isCompleted
    ? `has already completed in this orchestration. Its [PHASE AGENT RESULT — ${scope}] block is already in your context.`
    : `is currently in-flight (dispatched in a prior turn, agent has not yet reported back). The next sync spawn (or attempt_completion if no other phases pending) auto-waits for in-flight backgrounds — re-dispatching is wasted.`;
  return (
    `ERROR: scope=${scope} ${stateBlurb} ` +
    `Already-completed scopes: [${completedScopes.join(', ')}]. ` +
    `In-flight scopes: [${inFlightScopes.join(', ')}]. ${pendingHint} ` +
    `Re-dispatching the same scope is not allowed — the phase agent has no ` +
    `memory across spawns and would start fresh, producing duplicate or ` +
    `divergent files. If a sibling contract mismatch needs resolving, ` +
    `dispatch a pending scope with refined <task>/<context> so it conforms ` +
    `to the already-completed scopes. The completed scopes are the source of truth.`
  );
}

/**
 * Reject a spawn for a scope that isn't in the planning spec's tasks[].
 * Rule 5 enforcement (orchestrator.md). Closes the hallucination hole observed
 * on t33 ORCH 2026-05-04: orchestrator received a 3-scope spec, dispatched
 * correctly in turn 1, then in turn 2 added a 4th `frontend` scope unprompted,
 * which had no real work and led to graceful-skip FAIL.
 *
 * The set of valid scopes for an orchestration run is fixed at
 * `runLlmOrchestrator` setup time (session/llm-orchestrator.js), stored in stash.tasksByScope.
 * Any spawn whose scope isn't in that set is by definition out-of-spec.
 * Non-subagent scopes (none currently) bypass this check; phase.js's
 * resolvePhaseAssistant rejects them downstream with a clearer error.
 */
function rejectIfScopeNotInPlan(sessionId, scope) {
  if (!SUBAGENT_SCOPES.has(scope)) return null; // delegate rejection to phase.js
  const stash = getOrchestrationContext(sessionId);
  if (!stash || !stash.tasksByScope) return null; // outside orchestrator run
  if (stash.tasksByScope[scope]) return null; // scope is in the plan
  const planScopes = Object.keys(stash.tasksByScope);
  return (
    `ERROR: scope=${scope} is not in the planning specification. ` +
    `Planning spec defines these build scopes: [${planScopes.join(', ')}]. ` +
    `Dispatch ONLY scopes from the planning spec — do not invent new scopes ` +
    `even if a sibling report mentions one (e.g. integration's compose may ` +
    `mention a frontend service that wasn't dispatched). Sibling references ` +
    `to non-dispatched scopes are bugs in those outputs to be fixed via a ` +
    `<context> refinement on a re-spawn of an in-spec scope, never by ` +
    `spawning the referenced scope. If all in-spec scopes have completed, ` +
    `emit <attempt_completion>.`
  );
}

/**
 * Build the user message a phase agent will receive for a spawn dispatch.
 *
 * For the 5 subagent scopes (database/backend/frontend/vectordb/integration)
 * the deployed MGA system prompt already carries the scope's rules + canonical
 * scaffold + folder lockdown (see chat/scripts/upload-assistant-prompt.js).
 * Use the lean per-spawn builder so the user message only contributes per-task
 * dynamics: env, sibling completion reports, orchestrator refinement, uploads,
 * and the task text itself.
 *
 * For any non-subagent scope (defensive — phase.js rejects them earlier),
 * fall back to a simple two-block format.
 */
export function buildPhaseAgentUserMessage(sessionId, { scope, task, context }) {
  if (!SUBAGENT_SCOPES.has(scope)) {
    return buildEnrichedTask({ task, context });
  }
  const stash = getOrchestrationContext(sessionId);
  const resolvedTask = (stash && stash.tasksByScope && stash.tasksByScope[scope])
    || { scope, rules: [], snippets: [], primarySnippet: null };

  // W2.DISPATCH — iterate-diffs block for this scope, when the orchestrator
  // is running in iterate mode. Scope-gated: each subagent only sees its
  // slice of the diff (database+backend see data_model; backend+frontend
  // see api_contract; frontend sees ui_contract; backend+integration see
  // business_logic_contract; vectordb+backend+integration see
  // vector_engine). The orchestrator's own message already contains the
  // full diffs; subagents get the focused per-scope view.
  const iterateBlock = (stash && stash.iterate)
    ? buildIterateDiffsBlockForScope(scope, stash.iterate)
    : '';

  // Step 7f: the ROUTER'S task.task is authoritative — the orchestrator's
  // <task> param is ignored when the scope exists in the router's tasks[].
  // Reasons:
  //   - The orchestrator paraphrases the router's intent, and paraphrasing
  //     leaks model biases (e.g., "pgvector + database = one container",
  //     observed t32 collapse on 2026-05-05).
  //   - The router has the full cross-scope context + emits structured
  //     contracts (data_model / api_contract / vector_engine). Its task.task
  //     IS the source of truth.
  //   - Orchestrator refinements still flow via `<context>` parameter (kept
  //     as `orchestratorContext` below) — that's the right channel for
  //     sibling-report-based addendums.
  // Fallback to orch's <task> ONLY when scope wasn't in router's tasks[]
  // (rejectIfScopeNotInPlan should already prevent this; safety belt only).
  const taskText = resolvedTask.task || task || '';
  const syntheticTask = { ...resolvedTask, scope, task: taskText };
  // For iterate mode, layer orchestratorContext + iterate-diffs together so
  // the existing CROSS-SCOPE COORDINATION block in buildSpawnUserMessage
  // surfaces both. Diffs come AFTER orchestratorContext so they're the most-
  // recent guidance the model reads before the task.
  let layeredContext = iterateBlock
    ? `${context || ''}\n\n${iterateBlock}`.trim()
    : (context || '');
  // UI kit catalog for the frontend spawn — the kit source is staged on
  // disk (write-locked) but deliberately not inlined; the catalog carries
  // the import surface + composition rules.
  if (scope === 'frontend' && stash && stash.uiKitStaged) {
    layeredContext = `${layeredContext}\n\n${KIT_CATALOG}`.trim();
  }
  return buildSpawnUserMessage(syntheticTask, stash ? stash.envContext : null, {
    orchestratorContext: layeredContext,
    completionReports: stash ? stash.completionReports : {},
    uploads: stash ? stash.uploads : null,
    // Step 7d/7e: thread router-emitted contracts through to every spawn.
    // prompt-builder scope-gates which scope sees what:
    //   data_model:    db+backend
    //   api_contract:  backend+frontend
    //   vector_engine: vectordb+backend+integration
    //   required_services: integration only (deterministic from tasksByScope)
    // Stash absent → nulls → sections silently skipped.
    dataModel: stash ? stash.dataModel : null,
    apiContract: stash ? stash.apiContract : null,
    vectorEngine: stash ? stash.vectorEngine : null,
    uiContract: stash ? stash.uiContract : null,
    businessLogicContract: stash ? stash.businessLogicContract : null,
    allTaskScopes: stash ? Object.keys(stash.tasksByScope || {}) : [],
    // Scaffold-first: pre-staged file contents the runtime wrote BEFORE
    // dispatch. buildSpawnUserMessage filters by scope and inlines them
    // under `=== PRE-STAGED FILES ===` so the LLM has authoritative file
    // content from turn 1 (kills the replace_in_file SEARCH-mismatch
    // failure mode where the LLM imagines content from stale stubs).
    preStagedFiles: stash ? (stash.preStagedFiles || []) : [],
  });
}

/**
 * W2.DISPATCH — scope-gated iterate-diffs block for a single subagent
 * spawn. Mirrors the gating in prompt-builder/core.js. Returns the diffs
 * block string or empty string when nothing applies to this scope.
 *
 * @param {string} scope - subagent scope (database/backend/frontend/etc)
 * @param {{summary: string, contractDiffs: object, affectedScopes: string[]}} iterate
 */
function buildIterateDiffsBlockForScope(scope, iterate) {
  if (!iterate || !iterate.affectedScopes || !iterate.affectedScopes.includes(scope)) {
    return ''; // scope not affected — no diff to inject
  }
  const diffs = normalizeContractDiffs(iterate.contractDiffs || {});
  const slices = [];
  const dataModel = diffs.data_model || diffs.dataModel;
  const apiContract = diffs.api_contract || diffs.apiContract;
  const uiContract = diffs.ui_contract || diffs.uiContract;
  const businessLogic = diffs.business_logic_contract || diffs.businessLogicContract;
  const vectorEngine = diffs.vector_engine || diffs.vectorEngine;

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

  const header = [
    '=== ITERATE DIFFS ===',
    '',
    `Iteration intent: ${iterate.summary || 'iteration'}`,
    '',
  ];
  if (slices.length === 0) {
    header.push('(No contract diff applies to this scope. Apply the intent directly to your existing files.)');
  } else {
    header.push('The following contract changes apply to your scope. Treat them as');
    header.push('additions/changes to apply on top of the previously-built code. Files');
    header.push('and contracts not mentioned remain as-is — see `.harness/contracts.json`');
    header.push('for the full pre-iterate state.');
    if (diffHasRemovals(diffs)) {
      header.push('');
      header.push('Entries under `remove_*` keys are DELETIONS, not additions: delete the');
      header.push('named routes/components/views/rules and every reference to them —');
      header.push('handlers, call sites, imports, navigation entries. Leave no dead code.');
    }
    header.push('');
    header.push(...slices);
  }
  header.push('');
  header.push('=== END ITERATE DIFFS ===');
  header.push('');
  header.push(ITERATE_MINIMAL_CHANGE_POLICY);
  return header.join('\n');
}

// Structured event for the frontend chip: every dispatch/completion/failure
// emits one of these so the UI can show a "N tasks running" indicator + a
// drilldown drawer. Same Cline-event channel; UI matches on `say==='phase_status'`.
function emitPhaseStatus(ctx, payload) {
  ctx.emit({ say: 'phase_status', text: JSON.stringify(payload) });
}

// Record the agent's completion report — or, when a FAILED agent already
// wrote files this dispatch, a synthetic partial one. Without it the scope
// has no report at all and build-summary's deriveStatus scores the whole
// build `failed` even when gates/probe verify the written files green
// (observed live: database agent wrote schema + migration, died before
// reporting, working app reported Status: failed). Cancelled runs (130)
// stay unreported — the user aborted, silence is honest there.
function recordReportOrSyntheticPartial(ctx, scope, finalState, result) {
  if (finalState === 'completed' && result.completionText) {
    recordCompletionReport(ctx.sessionId, scope, result.completionText);
  } else if (finalState === 'failed' && (result.writtenPaths || []).length > 0) {
    recordCompletionReport(ctx.sessionId, scope, [
      '--- PHASE AGENT REPORT ---',
      `**Scope:** ${scope}`,
      '**Status:** partial',
      `**Files written:** ${result.writtenPaths.join(', ')}`,
      '',
      '**Summary:** Agent terminated before reporting; the files above were written this dispatch and are verified by the downstream gates.',
    ].join('\n'));
    tlog('[phase-tools] scope=%s failed after writing %d file(s) — recorded synthetic partial report',
      scope, result.writtenPaths.length);
  }
}

// A scope agent that emits prose twice with zero tool calls dies with
// `stalled: true` and nothing written (observed live: vectordb produced no
// files and the empty scope sat until the type-gate noticed ~5 minutes
// later). A stall with no side effects is safe to retry immediately with a
// fresh conversation — one retry, then the normal failure path resumes.
async function runAgentWithStallRetry(ctx, userMessage, opts, scope) {
  const result = await ctx.runCustomAgent(ctx.sessionId, userMessage, opts);
  const wroteNothing = !(result.writtenPaths || []).length && !result.completionText;
  if (result.stalled && wroteNothing) {
    tlog('[phase-tools] scope=%s stalled with no side effects — re-dispatching once (fresh conversation)', scope);
    ctx.emit({ say: 'text', text: `[orchestrator] ${scope} agent stalled without doing anything — retrying once.` });
    // Escalated retry: re-sending the identical message reproduces a
    // DETERMINISTIC prose-stall verbatim (observed live: two identical
    // 20k-char prose dumps, zero tool calls). The preamble names the
    // failure and demands tool calls only. Safe by construction — this
    // path only runs where the build has already failed.
    const retryPreamble = [
      '=== RETRY — TOOL CALLS ONLY ===',
      'Your previous attempt emitted prose/markdown instead of tool calls and',
      'produced NO files. This retry must consist of tool calls only: write',
      'every file with write_to_file (full content), then attempt_completion.',
      'Never describe or preview code in plain text.',
      '=== END RETRY NOTE ===',
      '',
    ].join('\n');
    return ctx.runCustomAgent(ctx.sessionId, retryPreamble + userMessage, { ...opts, conversationId: null });
  }
  return result;
}

export async function toolSpawnPhaseAgent(params, ctx) {
  const guard = ctxRequireSpawn(ctx, 'spawn_phase_agent');
  if (guard) return guard;
  const { description, scope, task, context } = params;
  if (!scope) return 'ERROR: spawn_phase_agent missing required <scope> param.';
  if (!task) return 'ERROR: spawn_phase_agent missing required <task> param.';
  const dupGuard = rejectIfScopeAlreadyCompleted(ctx.sessionId, scope);
  if (dupGuard) return dupGuard;
  const planGuard = rejectIfScopeNotInPlan(ctx.sessionId, scope);
  if (planGuard) return planGuard;
  // Mark in-flight BEFORE the await so a sibling spawn dispatched in the same
  // multi-tool batch sees this scope as in-flight and gets correctly rejected
  // by the dup-guard. Cleared in the success/failure paths below.
  markScopeInFlight(ctx.sessionId, scope);

  const syncTaskId = generateTaskId();
  const startedAt = Date.now();
  ctx.emit({ say: 'text', text: `[orchestrator] dispatching ${scope} phase agent (sync): ${description || '(no description)'}` });
  emitPhaseStatus(ctx, { taskId: syncTaskId, scope, description: description || '', state: 'running', mode: 'sync', startedAt });

  const userMessage = buildPhaseAgentUserMessage(ctx.sessionId, { scope, task, context });
  let result;
  try {
    result = await runAgentWithStallRetry(ctx, userMessage, {
      conversationId: null,
      scope,
      priorTokenTotals: null,
      phase: PHASES.SUBAGENT,
      subagentDepth: 1,
      signal: ctx.signal,
      // Build-phase awareness so agent.js picks INITIAL_BUILD_MODEL vs
      // ITERATE_MODEL. Set in build-dispatcher.js ctx.
      isIterate: !!ctx.isIterate,
    }, scope);
  } catch (err) {
    clearScopeInFlight(ctx.sessionId, scope);
    emitPhaseStatus(ctx, { taskId: syncTaskId, scope, state: 'failed', error: err.message, startedAt });
    throw err;
  }

  const finalState = result.exitCode === 0 ? 'completed' : (result.exitCode === 130 ? 'cancelled' : 'failed');
  // Capture sibling-visible completion text for auto-injection into any
  // subsequent spawn that fires later in this orchestrator run.
  recordReportOrSyntheticPartial(ctx, scope, finalState, result);
  // Clear in-flight after recordCompletionReport so the dup-guard sees the
  // completion record rather than briefly seeing neither (otherwise a
  // narrowly-timed re-spawn in the same response could slip through during
  // the gap). The completionReports check fires first; in-flight is the
  // backstop for the bg case where this sequence is delayed.
  clearScopeInFlight(ctx.sessionId, scope);
  emitPhaseStatus(ctx, {
    taskId: syncTaskId, scope, state: finalState, startedAt,
    writtenPaths: result.writtenPaths || [],
    tokens: result.runTokenTotals || null,
  });

  // W1.PATH — reconciler advisory: flag any ambiguous-shape paths that made
  // it through resolveWorkspacePath + checkPermissions. Informational only;
  // the file already landed in the right place. Surfaces "subagent ignoring
  // the workspace-root-relative rule" as a tlog signal for prompt-tightening.
  try {
    const { ambiguous } = flagAmbiguousPaths(result.writtenPaths || []);
    for (const entry of ambiguous) {
      tlog('[path-sanity] scope=%s ambiguous=%s — %s', scope, entry.path, entry.reason);
    }
  } catch { /* advisory only — never block on this */ }

  // Auto-wait for in-flight background siblings before returning. This
  // eliminates the orchestrator's polling overhead — when a sync spawn
  // returns, every background spawn fired in the same dispatch turn is
  // also guaranteed done, with its report in the orchestration stash. The
  // orchestrator's next turn can immediately call attempt_completion (or
  // pivot to a missed scope) instead of polling check_phase_agent.
  // Empirically (smoke t11, 2026-05-02): cuts ~5 polling turns × ~5K
  // tokens each.
  const inFlight = listTasksForSession(ctx.sessionId, { state: 'running' })
    .filter(t => t.promise && t.taskId !== syncTaskId);
  if (inFlight.length > 0) {
    ctx.emit({ say: 'text', text: `[orchestrator] sync ${scope} done; auto-waiting for ${inFlight.length} background sibling(s)` });
    await Promise.allSettled(inFlight.map(t => t.promise));
  }

  // Build a result block that aggregates the sync agent's report PLUS any
  // background sibling reports that completed during the wait. The
  // orchestrator gets a single bundled block and can finalize without
  // polling. Sync agent's report appears first, siblings follow.
  const blocks = [
    `[PHASE AGENT RESULT — ${scope} — ${description || 'no description'}]`,
    `Status: ${finalState}`,
    `Files written: ${(result.writtenPaths || []).join(', ') || 'none'}`,
    `Tokens used: prompt=${result.runTokenTotals?.promptTokens ?? '?'} completion=${result.runTokenTotals?.completionTokens ?? '?'}`,
    '',
    result.completionText || '(no completion text)',
    `[/PHASE AGENT RESULT]`,
  ];
  for (const t of inFlight) {
    const r = t.result;
    if (!r) continue; // task failed/cancelled — markFailed already emitted phase_status
    const tFinal = r.exitCode === 0 ? 'completed' : (r.exitCode === 130 ? 'cancelled' : 'failed');
    blocks.push(
      '',
      `[PHASE AGENT RESULT — ${t.scope} — ${t.description || 'no description'}]`,
      `Status: ${tFinal}`,
      `Files written: ${(r.writtenPaths || []).join(', ') || 'none'}`,
      `Tokens used: prompt=${r.runTokenTotals?.promptTokens ?? '?'} completion=${r.runTokenTotals?.completionTokens ?? '?'}`,
      '',
      r.completionText || '(no completion text)',
      `[/PHASE AGENT RESULT]`,
    );
  }
  return blocks.join('\n');
}

export async function toolSpawnPhaseAgentBackground(params, ctx) {
  const guard = ctxRequireSpawn(ctx, 'spawn_phase_agent_background');
  if (guard) return guard;
  const { description, scope, task, context } = params;
  if (!scope) return 'ERROR: spawn_phase_agent_background missing required <scope> param.';
  if (!task) return 'ERROR: spawn_phase_agent_background missing required <task> param.';
  const dupGuard = rejectIfScopeAlreadyCompleted(ctx.sessionId, scope);
  if (dupGuard) return dupGuard;
  const planGuard = rejectIfScopeNotInPlan(ctx.sessionId, scope);
  if (planGuard) return planGuard;
  // Mark in-flight BEFORE we register the task so a sibling spawn dispatched
  // in the same multi-tool batch sees this scope as in-flight and gets
  // correctly rejected by the dup-guard. The async run cleanup below handles
  // both completion and failure paths.
  markScopeInFlight(ctx.sessionId, scope);

  const taskId = generateTaskId();
  const ac = new AbortController();

  registerTask(taskId, {
    sessionId: ctx.sessionId,
    scope,
    description: description || '(no description)',
    abortController: ac,
  });

  const startedAt = Date.now();
  ctx.emit({
    say: 'text',
    text: `[orchestrator] dispatching ${scope} phase agent (background): taskId=${taskId} ${description || ''}`,
  });
  emitPhaseStatus(ctx, { taskId, scope, description: description || '', state: 'running', mode: 'background', startedAt });

  const userMessage = buildPhaseAgentUserMessage(ctx.sessionId, { scope, task, context });

  // Fire-and-track. The Promise settles independently. Sibling sync spawns
  // (toolSpawnPhaseAgent) auto-await all in-flight tasks before returning,
  // so the orchestrator typically doesn't need to poll via check_phase_agent
  // when its dispatch pattern is "N-1 background + 1 sync in turn 1".
  // check_phase_agent remains available for ad-hoc polling.
  const runPromise = runAgentWithStallRetry(ctx, userMessage, {
    conversationId: null,
    scope,
    priorTokenTotals: null,
    phase: PHASES.SUBAGENT,
    subagentDepth: 1,
    signal: ac.signal,
    // See sync-spawn handler above for rationale.
    isIterate: !!ctx.isIterate,
  }, scope);
  // Stash the awaitable handle on the task record so toolSpawnPhaseAgent
  // can await all in-flight backgrounds before returning to the orchestrator.
  setTaskPromise(taskId, runPromise);
  runPromise.then(
    (result) => {
      markCompleted(taskId, result);
      const finalState = result.exitCode === 0 ? 'completed' : (result.exitCode === 130 ? 'cancelled' : 'failed');
      // Capture this background phase's completion text into the orchestration
      // stash so any sync spawn fired afterwards (e.g. integration after
      // backend+database finish in parallel) auto-injects it as a sibling
      // contract.
      recordReportOrSyntheticPartial(ctx, scope, finalState, result);
      // Promote from in-flight to settled. completionReports[scope] is set
      // above for completed runs; for cancelled/failed runs no completion
      // report exists. Either way, clearing in-flight matches "agent has
      // settled, dup-guard logic should now consult completionReports".
      clearScopeInFlight(ctx.sessionId, scope);
      emitPhaseStatus(ctx, {
        taskId, scope, state: finalState, startedAt,
        writtenPaths: result.writtenPaths || [],
        tokens: result.runTokenTotals || null,
      });
      // W1.PATH — reconciler advisory (background-spawn path).
      try {
        const { ambiguous } = flagAmbiguousPaths(result.writtenPaths || []);
        for (const entry of ambiguous) {
          tlog('[path-sanity] scope=%s ambiguous=%s — %s', scope, entry.path, entry.reason);
        }
      } catch { /* advisory only — never block on this */ }
    },
    (err) => {
      // Loud by design: a rejected background spawn previously vanished with
      // zero log lines — the scope just came up empty at the type-gate.
      tlog('[phase-tools] BACKGROUND SPAWN FAILED scope=%s: %s', scope, String(err?.message || err).slice(0, 200));
      markFailed(taskId, err);
      clearScopeInFlight(ctx.sessionId, scope);
      emitPhaseStatus(ctx, { taskId, scope, state: 'failed', error: err.message, startedAt });
    },
  );

  return `[PHASE AGENT DISPATCHED — taskId=${taskId} scope=${scope} description="${description || ''}"]\nUse check_phase_agent <task_id>${taskId}</task_id> to poll status, cancel_phase_agent to abort, or inject_phase_message to forward updates.`;
}

export async function toolCheckPhaseAgent(params, ctx) {
  const taskId = params.task_id || params.taskId;
  if (!taskId) return 'ERROR: check_phase_agent missing required <task_id> param.';
  const t = getTask(taskId);
  if (!t) return `[CHECK ${taskId}] not found (already dropped or unknown id).`;
  if (t.state === 'running') {
    const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
    return `[CHECK ${taskId}] state=running scope=${t.scope} elapsed=${elapsed}s`;
  }
  if (t.state === 'completed') {
    const r = t.result;
    return [
      `[CHECK ${taskId}] state=completed scope=${t.scope}`,
      `Files written: ${(r.writtenPaths || []).join(', ') || 'none'}`,
      `Tokens: prompt=${r.runTokenTotals?.promptTokens ?? '?'} completion=${r.runTokenTotals?.completionTokens ?? '?'}`,
      '',
      r.completionText || '(no completion text)',
    ].join('\n');
  }
  if (t.state === 'failed') {
    return `[CHECK ${taskId}] state=failed scope=${t.scope} error=${t.error?.message || 'unknown'}`;
  }
  if (t.state === 'cancelled') {
    return `[CHECK ${taskId}] state=cancelled scope=${t.scope}`;
  }
  return `[CHECK ${taskId}] state=${t.state}`;
}

export async function toolCancelPhaseAgent(params, ctx) {
  const taskId = params.task_id || params.taskId;
  if (!taskId) return 'ERROR: cancel_phase_agent missing required <task_id> param.';
  const reason = params.reason || 'cancelled by orchestrator';
  const t = runnerCancelTask(taskId, reason);
  if (!t) return `[CANCEL ${taskId}] task not found.`;
  return `[CANCEL ${taskId}] state=${t.state} (was running before cancel; signal aborted).`;
}

export async function toolInjectPhaseMessage(params, ctx) {
  const taskId = params.task_id || params.taskId;
  const message = params.message || '';
  if (!taskId) return 'ERROR: inject_phase_message missing required <task_id> param.';
  if (!message) return 'ERROR: inject_phase_message missing required <message> param.';
  const t = injectMessage(taskId, message);
  if (!t) return `[INJECT ${taskId}] task not found or no longer running; message NOT queued.`;
  return `[INJECT ${taskId}] message queued (queue depth ${t.pendingInjects.length}). Phase agent will see it on next turn boundary.`;
}
