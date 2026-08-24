/**
 * Hybrid Trace Store — append-only per-session trace for module execution steps.
 *
 * Each specialist call appends a step to session.hybridTrace[].
 * No external IO — reads/writes the session object only.
 *
 * Step shape:
 *   { module, input, output, durationMs, status, ts }
 *
 * Public surface:
 *   appendTraceStep(session, step)    — append one step
 *   getTrace(session)                 — return a copy of hybridTrace[]
 *   clearTrace(session)               — reset for a new build
 */

import { tlog } from '../../util/timestamped-log.js';

/**
 * Append one step to session.hybridTrace[].
 *
 * @param {object} session  the session record (mutated)
 * @param {{ module: string, input: string|null, output: string|null, durationMs: number, status: 'completed'|'failed'|'skipped' }} step
 */
export function appendTraceStep(session, step) {
  if (!Array.isArray(session.hybridTrace)) {
    session.hybridTrace = [];
  }
  const entry = {
    module: typeof step.module === 'string' ? step.module : 'unknown',
    input: step.input ?? null,
    output: step.output ?? null,
    durationMs: typeof step.durationMs === 'number' ? step.durationMs : 0,
    status: step.status || 'completed',
    ts: Date.now(),
  };
  session.hybridTrace.push(entry);
  tlog('[trace-store] session=%s module=%s status=%s durationMs=%d',
    session.id, entry.module, entry.status, entry.durationMs);
}

/**
 * Return a shallow copy of the trace array (safe to send as API response).
 * Returns empty array when no trace exists.
 *
 * @param {object} session
 * @returns {Array}
 */
export function getTrace(session) {
  return Array.isArray(session.hybridTrace) ? [...session.hybridTrace] : [];
}

/**
 * Clear the trace — called at the start of each new build to prevent
 * stale trace data from a prior build showing up in GET /trace.
 *
 * @param {object} session
 */
export function clearTrace(session) {
  session.hybridTrace = [];
}
