/**
 * Structured snippet-fetch writer. HARNESS_EVOLUTION.md Section M item 3
 * (W3.TEL).
 *
 * One JSON line per `get_snippet` MCP fetch appended to
 *   <workspaceDir>/.harness/snippet-fetches.jsonl
 *
 * Record shape (verbatim from Section M item 3):
 *   { sessionId, scope, phase, snippetPath, fetchedAt, sizeBytes,
 *     source: 'cache'|'disk' }
 *
 * Path-A implementation note (per worker brief addition #3):
 *
 * Path A1 (tool-input parameter, threading `_context` through every MCP
 * caller) vs Path A2 (per-process active-context registry) tradeoff was
 * evaluated. The chosen approach is a hybrid leaning toward A1's clean
 * separation, executed at the SMALLEST possible diff:
 *
 *   - The agent loop's tool dispatcher (`toolUseMcpTool` in
 *     agent/tools/exec-tools.js) already has `sessionId`, `scope`, and
 *     `phase` available on its `ctx` object via runCustomAgent's bookkeeping.
 *   - That dispatcher threads `{ sessionId, scope, phase }` into
 *     `callMcpTool`'s opts in one place — touched ONCE, in code the harness
 *     owns (not in subagent prompts).
 *   - The MCP handler (`getSnippet`) reads opts.sessionId/scope/phase from
 *     the same opts bag that already carries `workspaceDir`.
 *
 * Net diff: ~5 lines in exec-tools.js + ~10 lines in handlers.js to call
 * this writer. Zero changes to subagent prompts; zero risk of an LLM forgetting
 * to pass `_context`. Concurrency note: subagent dispatches DO run in parallel
 * within the orchestrator's phase, but each subagent has its own ctx in the
 * agent loop — the values are passed per-call, never read from shared module
 * state, so concurrency is safe without a registry.
 *
 * Writes wrap in `logAndSwallow` per L.5 — a failed telemetry write must
 * never crash a build.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { logAndSwallow } from './log-helpers.js';
import { HARNESS_DIRNAME } from '../session/harness-state.js';

// Per-session in-memory mirrors of snippet-fetch records. The run-summary
// writer reads from here at end-of-build instead of re-parsing the jsonl —
// `session.snippetFetches[]` and this map carry the same data.
//
// Tradeoff: the jsonl on disk is the source of truth (survives restarts,
// readable post-hoc); the in-memory mirror exists because writeRunSummary
// runs at the SAME moment the build ends, and re-reading + filtering a
// growing jsonl is wasted I/O. Doubly-stored data is fine here — each side
// has a distinct consumer.
const _mirrorBySession = new Map(); // sessionId → Array<record>

/**
 * Append a single snippet-fetch record to the workspace's
 * `.harness/snippet-fetches.jsonl` AND mirror it into the per-session
 * in-memory ring.
 *
 * @param {string} workspaceDir — absolute path to the user-app workspace.
 *   Falsy values short-circuit (no-op).
 * @param {object} record — { sessionId, scope, phase, snippetPath, sizeBytes,
 *   source }. fetchedAt is filled by the writer when absent.
 */
export function appendSnippetFetch(workspaceDir, record) {
  if (!workspaceDir || !record) return;
  const normalized = {
    sessionId: record.sessionId || null,
    scope: record.scope || null,
    phase: record.phase || null,
    snippetPath: record.snippetPath || null,
    fetchedAt: record.fetchedAt || Date.now(),
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : null,
    source: record.source === 'cache' ? 'cache' : 'disk',
  };
  try {
    const dir = path.join(workspaceDir, HARNESS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'snippet-fetches.jsonl');
    appendFileSync(filePath, JSON.stringify(normalized) + '\n');
  } catch (err) {
    logAndSwallow(err, '[telemetry-snippet-fetches]');
  }
  // Mirror push: always-on, separate from the disk write. We wrap this in
  // its own try too so a future schema-validation throw can't take down the
  // MCP handler — array.push can't fail today but consistency with the
  // file-write path per the worker brief's "wrap them anyway".
  if (normalized.sessionId) {
    try {
      const arr = _mirrorBySession.get(normalized.sessionId) || [];
      arr.push(normalized);
      _mirrorBySession.set(normalized.sessionId, arr);
    } catch (err) {
      logAndSwallow(err, '[telemetry-snippet-fetches-mirror]');
    }
  }
}

/**
 * Read the in-memory mirror for a session. Returns `[]` for any session
 * that never fetched a snippet. The array is the live reference; callers
 * MUST NOT mutate. Run-summary writer copies into the record.
 */
export function getSnippetFetchMirror(sessionId) {
  if (!sessionId) return [];
  return _mirrorBySession.get(sessionId) || [];
}

/**
 * Reset the mirror for a session. Exposed for tests + for the future-case
 * where a long-lived session crosses many builds and the mirror should be
 * pruned at run-summary write boundaries (not used today; the mirror grows
 * unbounded across a session's lifetime, which matches the build/iterate
 * model where N records per session is small).
 */
export function resetSnippetFetchMirror(sessionId) {
  if (!sessionId) return;
  _mirrorBySession.delete(sessionId);
}
