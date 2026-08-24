/**
 * Run-summary writer. Section M item 6 (HARNESS_EVOLUTION.md W1.TEL).
 *
 * One JSON record per build / iteration appended to
 *   chat/server/agent/run-logs/_summaries/<sessionId>.jsonl
 *
 * NB: jsonl, not json — long-lived sessions that build → iterate → iterate
 * produce multiple records under the same sessionId, ordered by `startedAt`.
 *
 * Record shape (Section M item 6, with W3.TEL columns now populated):
 *   {
 *     sessionId, intent, action,
 *     startedAt, endedAt, totalMs,
 *     scopes: [string],
 *     status: 'built' | 'partial' | 'infeasible',
 *     tokens: { prompt, completion, cached, total },
 *     costUsd: number | null,
 *     mgaCalls: number,
 *     toolCalls: number,
 *     retryAttemptsByScope: { [scope]: number },
 *     reconcilerVerdicts: { ok, mismatch, legitimate, noise }, // W3.TEL — counts from session sink
 *     snippetFetches: [{ sessionId, scope, phase, snippetPath,
 *                        fetchedAt, sizeBytes, source }],       // W3.TEL — copied from mirror
 *     autoRecoveryAttempts: [{ scope, attemptN, triggeredBy,    // W3.TEL Section M item 10
 *                              failureSummary, fixedAt?, exhausted }],
 *     investigatorRecords: [{ symptom, filesRead, logsRead,     // W3.TEL Section M item 11
 *                             rootCause, confidence,
 *                             recommendedFix }],
 *   }
 *
 * Writes are wrapped in `logAndSwallow` per L.5 — a failed telemetry write
 * must never crash a build.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logAndSwallow } from './log-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// run-summary.js lives at chat/server/util/, run-logs at chat/server/agent/run-logs/.
const SUMMARIES_DIR = path.join(__dirname, '..', 'agent', 'run-logs', '_summaries');

/**
 * Append one run-summary record for a session.
 *
 * @param {string} sessionId - The session UUID.
 * @param {object} summary  - Free-form summary object; see file header for shape.
 *                            Missing optional fields are filled with defaults so
 *                            downstream aggregation can rely on key presence.
 */
export function writeRunSummary(sessionId, summary) {
  if (!sessionId) return;
  try {
    mkdirSync(SUMMARIES_DIR, { recursive: true });
    const record = {
      sessionId,
      intent: summary.intent || null,
      action: summary.action || null,
      startedAt: summary.startedAt || null,
      endedAt: summary.endedAt || Date.now(),
      totalMs: summary.totalMs || null,
      scopes: Array.isArray(summary.scopes) ? summary.scopes : [],
      status: summary.status || 'partial',
      tokens: {
        prompt: summary.tokens?.prompt || 0,
        completion: summary.tokens?.completion || 0,
        cached: summary.tokens?.cached || 0,
        total: summary.tokens?.total || 0,
      },
      costUsd: typeof summary.costUsd === 'number' ? summary.costUsd : null,
      mgaCalls: summary.mgaCalls || 0,
      toolCalls: summary.toolCalls || 0,
      retryAttemptsByScope: summary.retryAttemptsByScope || {},
      // W3.TEL populates these from per-build sinks (session.reconcilerVerdictCounts,
      // session.snippetFetches mirror or telemetry-snippets.getSnippetFetchMirror,
      // session.autoRecoveryAttempts, session.investigatorRecords). All four
      // default to a safe empty shape so older call sites still produce valid
      // jsonl records — Phase 4's runs-report.js relies on key presence.
      reconcilerVerdicts: summary.reconcilerVerdicts || { ok: 0, mismatch: 0, legitimate: 0, noise: 0 },
      snippetFetches: Array.isArray(summary.snippetFetches) ? summary.snippetFetches : [],
      autoRecoveryAttempts: Array.isArray(summary.autoRecoveryAttempts) ? summary.autoRecoveryAttempts : [],
      investigatorRecords: Array.isArray(summary.investigatorRecords) ? summary.investigatorRecords : [],
      // A6 process telemetry: contract validation-retry count (prompt-drift
      // signal) + post-compose endpoint verification outcome.
      contractAttempt: summary.contractAttempt || null,
      endpointProbe: summary.endpointProbe || null,
      uiSanity: summary.uiSanity || null,
      // CDD health: what the contract store did this run — diff kinds merged
      // on iterate, routes adopted from reconciler-legitimate verdicts, and
      // the envelope's revision count at write time. Aggregated across runs:
      // adoption trending to zero = contracts converging; rising = agents
      // keep adding undeclared routes (prompt drift).
      contractStore: {
        mergedKinds: Array.isArray(summary.contractStore?.mergedKinds) ? summary.contractStore.mergedKinds : [],
        adoptedRoutes: summary.contractStore?.adoptedRoutes || 0,
        revisionCount: summary.contractStore?.revisionCount || 0,
      },
    };
    const filePath = path.join(SUMMARIES_DIR, `${sessionId}.jsonl`);
    appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch (err) {
    logAndSwallow(err, '[telemetry-run-summary]');
  }
}

// Exported for unit testing.
export const __test = { SUMMARIES_DIR };
