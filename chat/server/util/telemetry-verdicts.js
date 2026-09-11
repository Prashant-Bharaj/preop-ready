/**
 * Structured reconciler-verdict writer. HARNESS_EVOLUTION.md Section M item 4
 * (W3.TEL).
 *
 * One JSON line per contract-item classification appended to
 *   <workspaceDir>/.harness/reconciler-verdicts.jsonl
 *
 * Record shape (verbatim from Section M item 4):
 *   { scope, contractItem, kind: 'data_model'|'api_contract'|'ui_contract',
 *     verdict: 'ok'|'mismatch'|'legitimate'|'noise',
 *     target?, reasoning? }
 *
 * Verdict tokens:
 *   - 'ok'         — comparator-only matched-without-judge path (compare.js)
 *   - 'mismatch'   — judge classified `mismatch:<id>` (judge-extras.js).
 *                    `<id>` is normalised into the `target` field.
 *   - 'legitimate' — judge classified `legitimate` (judge-extras.js)
 *   - 'noise'      — judge classified `noise` (judge-extras.js)
 *
 * Backward-compatible: this writer emits ALONGSIDE the existing
 * `[reconciler-judge] call ... verdict=...` tlog line — never replaces it.
 * The Phase 4 runs-report.js aggregator will eventually consume the jsonl
 * exclusively, at which point the tlog can be dropped.
 *
 * Writes wrap in `logAndSwallow` per L.5 — a failed telemetry write must
 * never crash a build.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { logAndSwallow } from './log-helpers.js';
import { HARNESS_DIRNAME } from '../session/harness-state.js';

// Per-workspace in-memory verdict buffer. Flushed at phase boundaries
// (end of judgeExtras() batch, end of compareScopes(), belt-and-braces at
// end of runReconcilerLoop) so a single multi-scope reconciler pass costs
// one appendFileSync, not N. Post-W3.TEL smoke (sha 7563b51) showed t32
// regressed PASS-WITH-FLAG 243s → ERROR 721s wall-clock; sync per-verdict
// writes across 30+ extras × 4 scopes were the dominant added cost.
// Back-compat: appendReconcilerVerdict() = push + immediate flush; the
// hot-path callers (judge-extras.js + compare.js) push only and let the
// batch-flush at their boundaries amortize the I/O.
const verdictBuffers = new Map(); // workspaceDir -> record[]

function makeRecord(record) {
  return {
    scope: record.scope || null,
    contractItem: record.contractItem || null,
    kind: record.kind || null,
    verdict: record.verdict || null,
    target: record.target || null,
    reasoning: record.reasoning || null,
    ts: record.ts || Date.now(),
  };
}

/**
 * Push a single reconciler-verdict record onto the per-workspace buffer.
 * No I/O — pair with `flushReconcilerVerdicts(workspaceDir)` at the
 * phase boundary to write the batch in one appendFileSync call.
 *
 * @param {string} workspaceDir — absolute path. Falsy → no-op.
 * @param {object} record — must include scope, contractItem, kind, verdict.
 */
export function pushReconcilerVerdict(workspaceDir, record) {
  if (!workspaceDir || !record) return;
  let buf = verdictBuffers.get(workspaceDir);
  if (!buf) {
    buf = [];
    verdictBuffers.set(workspaceDir, buf);
  }
  buf.push(makeRecord(record));
}

/**
 * Flush the per-workspace verdict buffer to `.harness/reconciler-verdicts.jsonl`.
 * Idempotent — empty / missing buffer is a no-op. Detaches the buffer
 * before the write so a thrown FS error drops the records rather than
 * accumulating forever; logAndSwallow surfaces the failure to ops.
 *
 * @param {string} workspaceDir — absolute path. Falsy → no-op.
 */
export function flushReconcilerVerdicts(workspaceDir) {
  if (!workspaceDir) return;
  const buf = verdictBuffers.get(workspaceDir);
  if (!buf || buf.length === 0) return;
  verdictBuffers.delete(workspaceDir);
  try {
    const dir = path.join(workspaceDir, HARNESS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'reconciler-verdicts.jsonl');
    const payload = buf.map(r => JSON.stringify(r)).join('\n') + '\n';
    appendFileSync(filePath, payload);
  } catch (err) {
    logAndSwallow(err, '[telemetry-reconciler-verdicts]');
  }
}

/**
 * Back-compat: push + immediate flush. Tests + callers that expect
 * synchronous file-write semantics keep working. The hot-path callers
 * (judge-extras.js + compare.js) use push + explicit phase-boundary flush.
 *
 * @param {string} workspaceDir — absolute path. Falsy → no-op.
 * @param {object} record — must include scope, contractItem, kind, verdict.
 */
export function appendReconcilerVerdict(workspaceDir, record) {
  pushReconcilerVerdict(workspaceDir, record);
  flushReconcilerVerdicts(workspaceDir);
}

/**
 * Normalise judge-extras' verdict token (`legitimate` / `mismatch:<id>` /
 * `noise`) into the 4-token shape this writer records.
 *
 * Returns `{ verdict, target }` where `target` is the `<id>` portion of a
 * mismatch verdict (null for the other three tokens).
 */
export function normaliseJudgeVerdict(judgeToken) {
  if (!judgeToken) return { verdict: 'legitimate', target: null };
  const s = String(judgeToken).trim();
  const m = s.match(/^mismatch:(.+)$/i);
  if (m) return { verdict: 'mismatch', target: m[1].trim() };
  if (/^legitimate$/i.test(s)) return { verdict: 'legitimate', target: null };
  if (/^noise$/i.test(s)) return { verdict: 'noise', target: null };
  // Default unknown tokens to legitimate — matches judge-extras' parser
  // fallback (treat unparseable as legitimate; never block a build).
  return { verdict: 'legitimate', target: null };
}

/**
 * Map a reconciler extra's `kind` to one of the three contract-kind tokens
 * Section M item 4 enumerates. Used so the jsonl record's `kind` field is
 * consistent regardless of which specific extra-kind the comparator emitted.
 *
 *   data_model    — backend↔database column refs (db-column-missing etc.)
 *   api_contract  — backend↔frontend route checks + coverage
 *   ui_contract   — frontend UI-component coverage
 *
 * Anything we can't classify defaults to 'api_contract' (the most common
 * surface — extras over routes are the dominant case at runtime).
 */
export function classifyContractKind(extraOrMismatch) {
  if (!extraOrMismatch) return 'api_contract';
  const kind = extraOrMismatch.kind || '';
  if (kind === 'db-column-missing' || kind.includes('column')) return 'data_model';
  if (kind === 'coverage-gap-ui-component' || kind.includes('ui-component')) return 'ui_contract';
  return 'api_contract';
}
