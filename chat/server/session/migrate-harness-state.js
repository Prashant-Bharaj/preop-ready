/**
 * One-shot backfill: synthesise `.harness/` artifacts from an existing
 * session transcript on the first message after Phase 1 deploy.
 *
 * Problem this solves: sessions that started before W1.STATE landed have a
 * full transcript but no `.harness/contracts.json` + `.harness/state.md`.
 * The Phase 2 router (which reads those on iteration) would treat them as
 * "fresh workspace, replan from scratch" — losing the previous build's
 * agreed contracts and forcing the user to redo the conversation.
 *
 * Mechanism: walk the transcript JSONL, extract the most recent
 * `plan_preview` (router output, carries data_model / api_contract /
 * vector_engine / ui_contract / business_logic_contract + tasks) and the
 * most recent `completion` (orchestrator's final build report). Synthesise
 * a minimal-but-correct contracts.json (v1 envelope) + state.md so the
 * router's iteration prompt has context.
 *
 * Idempotent: if `.harness/contracts.json` already exists in the workspace,
 * this is a no-op. Re-runs are safe.
 *
 * Failure policy: telemetry-class. A failed migration must NEVER block a
 * build — the worst case is "iteration replans from scratch", which is the
 * same behaviour as a fresh session.
 *
 * Wired into POST /api/session/:id/message BEFORE router dispatch.
 */
import { WORKSPACE_DIR } from '../core/paths.js';
import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { readAll } from './transcript.js';
import {
  isHarnessPopulated,
  writeContracts,
  writeStateMd,
} from './harness-state.js';
import { computeFileStructure } from './compute-file-structure.js';

/**
 * Walk the transcript and return the most recent `plan_preview` payload, or
 * null if none exists. plan_preview is the router's structured output —
 * tasks + data_model + api_contract + vector_engine + ui_contract +
 * business_logic_contract (see routes.js POST /confirm).
 */
function findLatestPlanPreview(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'plan_preview' && e?.payload) return e.payload;
  }
  return null;
}

/**
 * Find the most recent `completion` event — orchestrator's final scope list
 * + summary. Used to populate `built` / `next_likely_actions` sections of
 * state.md with at least a coarse "X scopes ran" record.
 */
function findLatestCompletion(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'completion' && e?.payload) return e.payload;
  }
  return null;
}

/**
 * Build the state.md payload from the salvaged plan_preview + completion.
 * Best-effort — we know the scopes that ran but not the per-file detail
 * (that lives in agent reports, which aren't always replayable). The
 * synthesized state.md will be overwritten the next time the orchestrator
 * runs `write_harness_state` so this is a transitional record.
 */
function synthesizeState({ planPreview, completion }) {
  const stack = {};
  if (planPreview?.vectorEngine) stack.vector_engine = planPreview.vectorEngine;

  // Derive backend language from the matching task, if present.
  const backendTask = (planPreview?.tasks || []).find(t => t?.scope === 'backend');
  if (backendTask?.language) stack.backend_language = backendTask.language;

  const built = {};
  const scopes = completion?.scopes || (planPreview?.tasks || []).map(t => t?.scope).filter(Boolean);
  for (const scope of scopes) {
    built[scope] = '(synthesised from prior transcript — file-level detail not recoverable)';
  }

  return {
    stack,
    active_contracts: '`.harness/contracts.json` (v1, backfilled)',
    built,
    known_issues: [],
    next_likely_actions: [],
  };
}

/**
 * Run the one-shot migration for a session. Idempotent: returns
 * `{ migrated: false, reason: 'already-populated' }` when `.harness/` is
 * already there.
 *
 * @param {string} sessionId
 * @param {string} [workspaceDir]
 * @returns {Promise<{ migrated: boolean, reason?: string }>}
 */
export async function migrateHarnessState(sessionId, workspaceDir = WORKSPACE_DIR) {
  if (!sessionId) return { migrated: false, reason: 'no-session-id' };

  // Idempotency gate — if contracts.json already exists, we're done.
  try {
    if (isHarnessPopulated(workspaceDir)) {
      return { migrated: false, reason: 'already-populated' };
    }
  } catch (err) {
    logAndSwallow(err, '[migrate-harness] isHarnessPopulated probe failed');
    return { migrated: false, reason: 'probe-failed' };
  }

  // Walk the transcript.
  let events;
  try {
    events = readAll(sessionId) || [];
  } catch (err) {
    logAndSwallow(err, '[migrate-harness] transcript read failed');
    return { migrated: false, reason: 'transcript-read-failed' };
  }
  if (events.length === 0) return { migrated: false, reason: 'empty-transcript' };

  const planPreview = findLatestPlanPreview(events);
  if (!planPreview) {
    // No prior router emission to salvage — likely a session that never got
    // past the welcome turn. Leaving `.harness/` empty is the correct outcome.
    return { migrated: false, reason: 'no-plan-preview' };
  }
  const completion = findLatestCompletion(events);

  // Build the contracts payload — v1 envelope via writeContracts.
  const tasksByScope = Object.fromEntries(
    (planPreview.tasks || [])
      .filter(t => t?.scope)
      .map(t => [t.scope, t])
  );

  let fileStructure = null;
  try {
    fileStructure = computeFileStructure({
      tasks: planPreview.tasks || [],
      flags: planPreview.flags || [],
    });
  } catch (err) {
    logAndSwallow(err, '[migrate-harness] computeFileStructure failed');
  }

  try {
    writeContracts(workspaceDir, {
      dataModel: planPreview.dataModel || null,
      apiContract: planPreview.apiContract || null,
      vectorEngine: planPreview.vectorEngine || null,
      uiContract: planPreview.uiContract || null,
      businessLogicContract: planPreview.businessLogicContract || null,
      fileStructure,
      tasksByScope,
    });
  } catch (err) {
    logAndSwallow(err, '[migrate-harness] writeContracts failed');
    return { migrated: false, reason: 'contracts-write-failed' };
  }

  try {
    writeStateMd(workspaceDir, synthesizeState({ planPreview, completion }));
  } catch (err) {
    logAndSwallow(err, '[migrate-harness] writeStateMd failed');
    // contracts already on disk — partial backfill is still better than none.
  }

  tlog('[migrate-harness] backfilled .harness/ from transcript session=%s scopes=%s',
    sessionId, (completion?.scopes || []).join(',') || 'none');
  return { migrated: true };
}
