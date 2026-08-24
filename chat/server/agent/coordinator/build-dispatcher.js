/**
 * Deterministic build dispatcher — replaces the LLM orchestrator's coordination role.
 *
 * Today's orchestrator is an LLM that decides scope dispatch order + sync/background
 * grouping, but per audit those decisions are prompt-hardcoded in practice (always
 * canonical order, always parallel-first). This module encodes the same decisions
 * directly in JS without a round-trip through the LLM — saving ~20-40K tokens and
 * ~50-70s of latency per build with no behavior change.
 *
 * Reuses existing infrastructure:
 *   - orchestration-stash.js for per-session state + disk-persisted contracts.json
 *   - phase-tools.js spawn handlers (toolSpawnPhaseAgent / Background) verbatim —
 *     called directly with a constructed ctx instead of via an LLM tool call
 *   - The spawn handlers' guards, auto-wait, sibling-report injection all work
 *     identically; the dispatcher is just the loop that calls them.
 *
 * Returns { exitCode, completionReports, dispatchedScopes } — same shape the old
 * runLlmOrchestrator returned, so routes.js dispatch downstream is unchanged.
 *
 * NOT replaced by this module: the end-of-build state.md + build report authoring.
 * That's handled deterministically by build-summary.js, called after the dispatcher
 * returns.
 */

import { tlog } from '../../util/timestamped-log.js';
import { logAndSwallow } from '../../util/log-helpers.js';
import { appendEvent } from '../../session/transcript.js';
import { sessionEvents } from '../../session/events.js';
import { emitScopeStatus } from '../../session/lifecycle.js';
import {
  setOrchestrationContext,
  clearOrchestrationContext,
  getOrchestrationContext,
  recordCompletionReport,
} from '../orchestration-stash.js';
import { toolSpawnPhaseAgent, toolSpawnPhaseAgentBackground } from '../tools/phase-tools.js';
import { CANONICAL_SCOPE_ORDER } from './scope-order.js';
import { preStageScaffolds } from './pre-stage-scaffolds.js';
import { mergeContractDiffs } from './contract-store.js';

/**
 * Dispatch a build's subagents deterministically.
 *
 * @param {Array<{scope:string, summary:string, task:string, rules?, snippets?, primarySnippet?, dockerfile?}>} tasks
 *   from the validated contract
 * @param {object} envContext  the per-session env context (workspace dir, hasStructure, etc.)
 * @param {object} session     the session record (has .id; everything else read from stash)
 * @param {object} opts
 * @param {Array}  opts.uploads
 * @param {object} opts.dataModel
 * @param {object} opts.apiContract
 * @param {string} opts.vectorEngine
 * @param {object} opts.uiContract
 * @param {object} opts.businessLogicContract
 * @param {Array<string>} opts.flags
 * @param {{summary:string, affectedScopes:string[], contractDiffs:object}|null} opts.iterate
 *
 * @returns {Promise<{exitCode:number, completionReports:Object<string,string>, dispatchedScopes:string[], error?:string}>}
 */
export async function runBuildDispatch(tasks, envContext, session, opts = {}) {
  const {
    uploads = null,
    dataModel = null,
    apiContract = null,
    vectorEngine = null,
    uiContract = null,
    businessLogicContract = null,
    flags = [],
    iterate = null,
  } = opts;

  tasks = tasks || [];
  const isIterate = !!(iterate && Array.isArray(iterate.affectedScopes) && iterate.affectedScopes.length > 0);

  // On iterate, merge contract diffs into the prior contract through the
  // contract-store (single merge path — endpoints by method+path, views by
  // name, tables/columns by name, business-logic upserts) so the envelope,
  // generated types, api-client, endpoint probe, and visual check all see
  // the NEW surface. A stale envelope makes every downstream gate blind.
  let effective = { dataModel, apiContract, vectorEngine, uiContract, businessLogicContract };
  let contractRevision = null;
  if (isIterate && iterate.contractDiffs) {
    tlog('[contract-store] iterate raw diff keys: %s', JSON.stringify(
      Object.fromEntries(Object.entries(iterate.contractDiffs).map(([k, v]) => [k, v && typeof v === 'object' ? Object.keys(v) : typeof v]))));
    const { merged, changes } = mergeContractDiffs(effective, iterate.contractDiffs);
    if (changes.length) {
      effective = merged;
      contractRevision = { ts: Date.now(), summary: iterate.summary || 'iterate', kinds: changes };
      session.contractStoreStats = session.contractStoreStats || { mergedKinds: [], adoptedRoutes: 0 };
      session.contractStoreStats.mergedKinds.push(...changes);
      tlog('[contract-store] build-dispatcher: iterate diffs merged: %s', changes.join(', '));
    }
  }
  const effectiveApiContract = effective.apiContract;
  tlog('[session] build-dispatcher: %d tasks [%s]%s',
    tasks.length, tasks.map(t => t.scope).join(', '),
    isIterate ? ` (ITERATE — scopes=[${iterate.affectedScopes.join(',')}])` : '');

  // ── 1. Determine dispatch order (pure — extracted for testability) ──
  // logicalScopes = every contract-declared scope (canonical order).
  // dispatchOrder = the subset we actually dispatch to LLM subagents (after
  //                 pre-stage may have absorbed some scopes deterministically).
  const logicalScopes = computeDispatchOrder(tasks, isIterate ? iterate : null);
  let dispatchOrder = [...logicalScopes];

  if (logicalScopes.length === 0) {
    tlog('[session] build-dispatcher: no scopes to dispatch (empty tasks or iterate filter eliminated all)');
    return { exitCode: 0, completionReports: {}, dispatchedScopes: [] };
  }

  // ── 1b. Pre-stage deterministic scaffolds (fresh builds only) ──
  // Emits contracts.ts, route stubs, api-client, component stubs, backend
  // helpers, schema SQL, and copies the canonical DB Dockerfile — all
  // deterministically from the contract. Locks the structural surface so
  // subagents only author bodies/business logic. Iterate path is unchanged
  // for now; that comes in the iterate-mode segment.
  const scaffold = preStageScaffolds({
    workspaceDir: envContext?.workspaceDir || null,
    contract: { dataModel: effective.dataModel, apiContract: effectiveApiContract, uiContract: effective.uiContract, vectorEngine: effective.vectorEngine, businessLogicContract: effective.businessLogicContract, flags, mgaAssistants: opts.mgaAssistants || [], tasks },
    isIterate,
    iterateDiffs: isIterate ? (iterate.contractDiffs || null) : null,
  });

  // When the database scope was fully scaffolded (schema + Dockerfile both
  // emitted), skip its LLM dispatch. The runtime-synthesized completion
  // report is seeded into the stash below so downstream siblings still see
  // a `=== COMPLETED: DATABASE ===` block when their user message is built.
  let preSeededReports = {};
  if (scaffold.databaseHandled) {
    dispatchOrder = dispatchOrder.filter(s => s !== 'database');
    if (scaffold.databaseReport) {
      preSeededReports.database = scaffold.databaseReport;
    }
    tlog('[session] build-dispatcher: database scope scaffolded deterministically; dispatch order now [%s]',
      dispatchOrder.join(', '));
  }
  if (scaffold.vectordbHandled) {
    dispatchOrder = dispatchOrder.filter(s => s !== 'vectordb');
    if (scaffold.vectordbReport) {
      preSeededReports.vectordb = scaffold.vectordbReport;
    }
    tlog('[session] build-dispatcher: vectordb scope scaffolded deterministically; dispatch order now [%s]',
      dispatchOrder.join(', '));
  }

  // If pre-stage handled every scope, return early — nothing to dispatch.
  if (dispatchOrder.length === 0) {
    tlog('[session] build-dispatcher: all scopes handled by pre-stage; skipping LLM dispatch entirely');
    return { exitCode: 0, completionReports: preSeededReports, dispatchedScopes: [] };
  }

  // ── 2. Set the orchestration stash (existing utility) ──
  // The stash is read by the spawn handlers (phase-tools.js) when building each
  // subagent's user message — sibling reports, cross-scope contracts, iterate
  // diffs all flow through here. Same shape llm-orchestrator.js used.
  const tasksByScope = Object.fromEntries(
    (tasks || []).map(t => [t.scope, t])
  );
  setOrchestrationContext(session.id, {
    envContext: envContext || null,
    uploads: uploads || null,
    tasksByScope,
    dataModel: effective.dataModel,
    apiContract: effectiveApiContract,
    vectorEngine: effective.vectorEngine,
    uiContract: effective.uiContract,
    businessLogicContract: effective.businessLogicContract,
    iterate: isIterate ? iterate : null,
    contractRevision,
    flags,
    // Pre-staged files manifest — surfaced into subagent user messages by
    // buildSpawnUserMessage so the LLM has authoritative file content from
    // turn 1 (vs imagining content from memory and tripping replace_in_file
    // SEARCH mismatches). Empty list on iterate or when nothing was staged.
    preStagedFiles: scaffold.files || [],
    uiKitStaged: !!scaffold.uiKitStaged,
  });

  // Seed any pre-staged completion reports (e.g. the synthesized database
  // report) into the stash so sibling subagents see them under their
  // CROSS-SCOPE COORDINATION blocks. recordCompletionReport mutates the
  // stash entry we just set.
  for (const [scope, reportText] of Object.entries(preSeededReports)) {
    recordCompletionReport(session.id, scope, reportText);
  }

  // ── 3. Build the ctx the spawn handlers expect ──
  // Mirrors what agent.js constructs for the orchestrator LLM. subagentDepth=0
  // satisfies ctxRequireSpawn (phase-tools.js:42-44). emit goes to the same
  // session-event channel runCustomAgent uses.
  const emit = (payload) => {
    const event = appendEvent(session.id, 'cline', payload);
    sessionEvents.emit('event', session.id, event);
  };
  const ctx = {
    sessionId: session.id,
    runCustomAgent: (await import('../agent.js')).runCustomAgent,
    emit,
    subagentDepth: 0,
    signal: null,
    // Threaded into runCustomAgent so it can pick the right model per
    // build phase: smarter (Opus) for the initial build where contract
    // accuracy matters most, cheaper (Sonnet) for iterate where the
    // surface is already correct and we just need to apply diffs. See
    // INITIAL_BUILD_MODEL / ITERATE_MODEL in chat/server/config/defaults.js.
    isIterate,
  };

  emitScopeStatus(session.id, { scope: 'orchestrator', status: 'running' });

  // ── 4. Dispatch: N-1 background + 1 sync ──
  // The sync spawn (toolSpawnPhaseAgent) auto-waits for in-flight backgrounds
  // before returning (phase-tools.js:344-357). After the sync call, every
  // dispatched scope has a recorded completion report in the stash.
  let dispatchError = null;
  try {
    for (let i = 0; i < dispatchOrder.length - 1; i++) {
      const scope = dispatchOrder[i];
      const params = buildSpawnParams(scope, tasksByScope[scope]);
      const handlerResult = await toolSpawnPhaseAgentBackground(params, ctx);
      // Background dispatcher returns either a [PHASE AGENT DISPATCHED ...] handle
      // or an ERROR: string from a guard. Log errors but don't abort the whole
      // dispatch — same forgiving posture the LLM had (pending scopes still try).
      if (typeof handlerResult === 'string' && handlerResult.startsWith('ERROR:')) {
        tlog('[session] build-dispatcher: background spawn refused for scope=%s: %s',
          scope, handlerResult.slice(0, 200));
      }
    }

    // Last scope sync — auto-waits for in-flight backgrounds.
    const lastScope = dispatchOrder[dispatchOrder.length - 1];
    const syncParams = buildSpawnParams(lastScope, tasksByScope[lastScope]);
    const syncResult = await toolSpawnPhaseAgent(syncParams, ctx);
    if (typeof syncResult === 'string' && syncResult.startsWith('ERROR:')) {
      tlog('[session] build-dispatcher: sync spawn returned error string for scope=%s', lastScope);
    }
  } catch (err) {
    logAndSwallow(err, '[session] build-dispatcher threw');
    dispatchError = err;
    emitScopeStatus(session.id, { scope: 'orchestrator', status: 'failed' });
  }

  // ── 5. Collect from stash, clear, return ──
  const stash = getOrchestrationContext(session.id);
  const completionReports = stash?.completionReports || {};
  clearOrchestrationContext(session.id);

  if (!dispatchError) {
    emitScopeStatus(session.id, { scope: 'orchestrator', status: 'completed', exitCode: 0 });
  }

  return {
    exitCode: dispatchError ? 1 : 0,
    completionReports,
    // Return the full logical scope list (incl. pre-staged scopes) so the
    // deterministic build-summary's state.md reflects ALL scopes that have
    // a completion report — including the synthesized database one.
    dispatchedScopes: logicalScopes,
    error: dispatchError?.message,
  };
}

/**
 * Build the params object the spawn handlers expect — same shape the orchestrator
 * LLM would have emitted via <spawn_phase_agent ...> XML.
 *
 * The `task` param is conventionally ignored by phase-tools.js when the scope is
 * in the stash's tasksByScope (router's task.task is authoritative). We still
 * pass it for completeness + as a fallback.
 */
function buildSpawnParams(scope, task) {
  return {
    description: task?.summary || `${scope} subagent`,
    scope,
    task: task?.task || '',
    context: '',
  };
}

/**
 * Pure helper: compute the ordered list of scopes to dispatch.
 * Exported for unit testing — no IO, no LLM, no side effects.
 *
 * @param {Array<{scope:string}>} tasks  — contract.tasks
 * @param {{affectedScopes:string[]}|null} iterate  — when present, intersect
 *   the canonical order with affected_scopes
 * @returns {string[]} ordered scope names
 */
export function computeDispatchOrder(tasks, iterate) {
  const taskList = Array.isArray(tasks) ? tasks : [];
  const scopesPresent = new Set(taskList.map(t => t?.scope).filter(Boolean));
  const naturalOrder = CANONICAL_SCOPE_ORDER.filter(s => scopesPresent.has(s));
  if (iterate && Array.isArray(iterate.affectedScopes) && iterate.affectedScopes.length > 0) {
    return naturalOrder.filter(s => iterate.affectedScopes.includes(s));
  }
  return naturalOrder;
}
