/**
 * Orchestration stash — per-session state that the LLM-orchestrator path
 * needs to share with the spawn-handler tools (Part B).
 *
 * Why this exists: `runLlmOrchestrator` in chat/server/session/llm-orchestrator.js
 * builds the resolved tasks-by-scope map + envContext + uploads; the spawn
 * handlers in chat/server/agent/tools/phase-tools.js need that map at dispatch
 * time so each phase agent gets a properly-scoped user message via
 * `buildSpawnUserMessage`. Threading it through the ctx object would force
 * agent.js to import getSession from session/routes.js (circular) — instead
 * this neutral module holds the data, keyed by sessionId, set by
 * session/llm-orchestrator.js and read by tools/phase-tools.js. Background
 * spawns also write completion reports back here so any subsequent sync
 * spawn picks them up.
 *
 * Lifetime: set at the top of `runLlmOrchestrator`, cleared at the bottom
 * (success and error paths). Only one orchestrator run per session at a
 * time, so single-key-per-session is fine.
 *
 * W1.STATE — disk persistence layer (HARNESS_EVOLUTION.md §A):
 *   The in-memory STASH stays as the hot read path for spawn handlers; on
 *   plan finalization (when `setOrchestrationContext` first receives the
 *   contracts payload), we ALSO persist the contracts to
 *   `<workspace>/.harness/contracts.json` via writeContracts. Session resume
 *   in a new connection rehydrates the in-memory stash from disk via
 *   `hydrateOrchestrationContextFromDisk(sessionId)`. This is what gives
 *   iterations access to "what the last build agreed on" without re-routing
 *   through the planner.
 */
import { WORKSPACE_DIR } from '../core/paths.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { readContracts, writeContracts } from '../session/harness-state.js';
import { nextRevisions } from './coordinator/contract-store.js';
import { computeFileStructure } from '../session/compute-file-structure.js';
import { invalidateContractsCache } from './tools/util/check-permissions.js';

const STASH = new Map();

/**
 * Initialize the orchestration context for a session.
 *
 * @param {string} sessionId
 * @param {{
 *   envContext: object,
 *   uploads: Array | null,
 *   tasksByScope: Object<string, {scope, task, rules, snippets, primarySnippet}>,
 *   dataModel: {tables: Array<{name, columns: Array<{name, type}>}>} | null,
 *   apiContract: {endpoints: Array<{method, path, query?, request?, response?}>} | null,
 *   vectorEngine: 'pgvector' | 'qdrant' | 'chroma' | null,
 *   uiContract: {primary_view, primary_action, secondary_views?, components?} | null,
 *   businessLogicContract: {triggers?, rules?, side_effects?} | null,
 *   preStagedFiles?: Array<{relPath: string, content: string}>,
 * }} ctx
 */
export function setOrchestrationContext(sessionId, ctx) {
  // Compute file_structure deterministically from tasks + flags. Done here
  // (not in the router) so the layout is single-sourced and consistent across
  // pre-stage / reconciler / type-gen / checkPermissions consumers. Done on
  // plan finalization (this is the call site invoked from runLlmOrchestrator
  // right before dispatch) so the disk-backed contracts.json carries it.
  const tasksArray = Object.values(ctx.tasksByScope || {});
  const flags = ctx.flags || [];
  let fileStructure = null;
  try {
    fileStructure = computeFileStructure({ tasks: tasksArray, flags });
  } catch (err) {
    logAndSwallow(err, '[orchestration-stash] computeFileStructure failed');
  }

  STASH.set(sessionId, {
    envContext: ctx.envContext || null,
    uploads: ctx.uploads || null,
    tasksByScope: ctx.tasksByScope || {},
    // Step 7d/7e + Track A1/A2: structured cross-scope contracts from the router.
    // Inlined into every consuming agent's spawn message via prompt-builder/core.js,
    // scope-gated (database+backend see dataModel; backend+frontend see
    // apiContract; vectordb+backend+integration see vectorEngine; frontend
    // sees uiContract; backend+integration see businessLogicContract).
    dataModel: ctx.dataModel || null,
    apiContract: ctx.apiContract || null,
    vectorEngine: ctx.vectorEngine || null,
    uiContract: ctx.uiContract || null,
    businessLogicContract: ctx.businessLogicContract || null,
    // W2.DISPATCH — iterate-mode payload. When present, spawn handlers
    // inline an "=== ITERATE DIFFS ===" block scope-gated to the spawning
    // agent's slice (same gating as full contracts). Null on execute
    // dispatch — sections silently skipped.
    iterate: ctx.iterate || null,
    fileStructure,
    completionReports: {}, // mutated by spawn handlers as agents finish
    inFlightSpawns: new Set(), // scopes currently dispatched (sync or background)
    // Pre-stage manifest (scaffold-first). Files the runtime emitted into the
    // workspace BEFORE any subagent ran. buildSpawnUserMessage inlines the
    // scope-filtered subset into each spawn's user message so the LLM has
    // authoritative file content from turn 1 — preventing replace_in_file
    // SEARCH mismatches that come from the LLM imagining file contents.
    preStagedFiles: Array.isArray(ctx.preStagedFiles) ? ctx.preStagedFiles : [],
    // UI kit staged this build — gates the KIT CATALOG section in frontend spawns.
    uiKitStaged: !!ctx.uiKitStaged,
  });

  // W1.STATE — disk-back the contracts so iterations + resumed sessions see
  // what the last finalized plan agreed on. Telemetry-class IO: never block
  // a build if the write fails.
  try {
    // Revision log: an iterate preserves history (appending its merge entry
    // when the dispatcher produced one); a fresh finalization resets it.
    let revisions = [{ ts: Date.now(), summary: 'contract finalized', kinds: ['all'] }];
    if (ctx.iterate) {
      let prior = [];
      try { prior = readContracts(WORKSPACE_DIR)?.data?.revisions || []; } catch { /* fresh workspace */ }
      revisions = nextRevisions(prior, ctx.contractRevision || null);
    }
    writeContracts(WORKSPACE_DIR, {
      dataModel: ctx.dataModel || null,
      apiContract: ctx.apiContract || null,
      vectorEngine: ctx.vectorEngine || null,
      uiContract: ctx.uiContract || null,
      businessLogicContract: ctx.businessLogicContract || null,
      fileStructure,
      tasksByScope: ctx.tasksByScope || {},
      revisions,
    });
    // W1.PATH — invalidate the checkPermissions contracts cache so the next
    // write-tool dispatch sees the freshly-finalized fileStructure +
    // forbidden_paths instead of the previous build's cached envelope.
    invalidateContractsCache(WORKSPACE_DIR);
  } catch (err) {
    logAndSwallow(err, '[orchestration-stash] writeContracts (disk-back) failed');
  }
}

/**
 * Rehydrate the in-memory stash from disk for a session being resumed in a
 * new connection. Only the contracts portion survives a restart — the
 * envContext / uploads / completionReports are per-build ephemera. Returns
 * `true` when contracts were loaded, `false` when no `.harness/contracts.json`
 * exists yet (fresh workspace).
 *
 * Callers (session/routes.js resume handler, future Phase 2 iterate path)
 * decide whether to call this lazily on first dispatch or eagerly on resume.
 */
export function hydrateOrchestrationContextFromDisk(sessionId, workspaceDir = WORKSPACE_DIR) {
  if (STASH.has(sessionId)) return true; // already hydrated, nothing to do

  let envelope = null;
  try {
    envelope = readContracts(workspaceDir);
  } catch (err) {
    logAndSwallow(err, '[orchestration-stash] readContracts (hydrate) failed');
    return false;
  }
  if (!envelope || !envelope.data) return false;

  const data = envelope.data;
  STASH.set(sessionId, {
    envContext: null,
    uploads: null,
    tasksByScope: data.tasksByScope || {},
    dataModel: data.dataModel || null,
    apiContract: data.apiContract || null,
    vectorEngine: data.vectorEngine || null,
    uiContract: data.uiContract || null,
    businessLogicContract: data.businessLogicContract || null,
    fileStructure: data.fileStructure || null,
    completionReports: {},
    inFlightSpawns: new Set(),
  });
  return true;
}

/**
 * Read the orchestration context for a session, if one is active.
 * Returns null when called outside an orchestrator run.
 */
export function getOrchestrationContext(sessionId) {
  return STASH.get(sessionId) || null;
}

/**
 * Record a phase agent's completion report so subsequent sibling spawns can
 * see it via auto-injection in `buildSpawnUserMessage`.
 */
export function recordCompletionReport(sessionId, scope, completionText) {
  const ctx = STASH.get(sessionId);
  if (!ctx || !scope || !completionText) return;
  ctx.completionReports[scope] = completionText;
}

/**
 * Mark a scope as currently in-flight (dispatched but not yet reported back).
 * Closes the Rule 1 race: when the orchestrator emits a duplicate spawn for a
 * scope whose original background spawn hasn't recorded its completion yet,
 * the dup-guard checks this set and rejects. Cleared by the spawn handler when
 * the agent settles (success or failure).
 */
export function markScopeInFlight(sessionId, scope) {
  const ctx = STASH.get(sessionId);
  if (!ctx || !scope) return;
  ctx.inFlightSpawns.add(scope);
}

/**
 * Clear the in-flight marker for a scope. Pair with `markScopeInFlight` —
 * call after the spawn settles (in both success and failure paths) so a
 * legitimate retry isn't blocked by stale state.
 */
export function clearScopeInFlight(sessionId, scope) {
  const ctx = STASH.get(sessionId);
  if (!ctx || !scope) return;
  ctx.inFlightSpawns.delete(scope);
}

/**
 * Clear the orchestration context for a session. Call at the end of
 * `runLlmOrchestrator` regardless of outcome.
 */
export function clearOrchestrationContext(sessionId) {
  STASH.delete(sessionId);
}
