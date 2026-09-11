/**
 * Shared telemetry assertions for the integration + smoke tiers.
 *
 * Why this exists: integration tests assert against synthetic telemetry
 * (writes through the real W3.TEL writers running against a mocked harness
 * + test workspace); smoke tests assert against real telemetry (real MGA
 * + real Docker + real `.harness/`). Without a shared assertion layer, a
 * telemetry-shape regression ships through integration before smoke catches
 * it — same bug, different repro, two places to fix. One implementation,
 * two tiers' coverage.
 *
 * Design notes:
 *   - Helpers are tier-agnostic. They take a `workspaceDir` and read JSONL
 *     files from it. Whether that workspace was populated by a mock (integration)
 *     or by real MGA + Docker (smoke) is irrelevant to the helper.
 *   - Failure messages name the file checked, what was expected, and what was
 *     actually found — so a smoke regression's diagnostic is immediately
 *     actionable.
 *   - Helpers use `node:assert` (strict) for throws. No custom error types.
 *   - W3.TEL artifacts:
 *       <workspaceDir>/.harness/snippet-fetches.jsonl       (W3.TEL §M item 3)
 *       <workspaceDir>/.harness/reconciler-verdicts.jsonl   (W3.TEL §M item 4)
 *     W1.TEL artifact:
 *       chat/server/agent/run-logs/_summaries/<sessionId>.jsonl  (W1.TEL §M item 6)
 *     The run-summary file is GLOBAL (one per sessionId across all workspaces),
 *     so the helpers accept a `summariesDir` override and fall back to the
 *     canonical global dir when neither workspaceDir nor override resolves a
 *     populated file. Auto-recovery + investigator records live as arrays
 *     INSIDE the run-summary record (not a separate file).
 *   - assertLogAndSwallowContained is a standalone helper: it doesn't read
 *     filesystem artifacts; it inspects stderr text the caller captured.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The W1.TEL canonical run-summaries dir, computed from this file's path.
// tests/util/ → ../../server/agent/run-logs/_summaries/
const CANONICAL_SUMMARIES_DIR = path.resolve(
  __dirname, '..', '..', 'server', 'agent', 'run-logs', '_summaries'
);

function readJsonl(filePath) {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, 'utf-8').trim();
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`telemetry-asserts: ${filePath} line ${idx + 1} is not valid JSON: ${err.message}`);
    }
  });
}

function resolveSummariesPath(workspaceDir, opts) {
  if (opts.summariesDir) {
    return opts.summariesDir;
  }
  // First try workspace-local .harness/run-summaries.jsonl (smoke + future
  // worker-app convention). If absent, fall back to the canonical global dir.
  if (workspaceDir) {
    const local = path.join(workspaceDir, '.harness', 'run-summaries.jsonl');
    if (existsSync(local)) return path.dirname(local);
  }
  return CANONICAL_SUMMARIES_DIR;
}

function loadRunSummaryRecords(workspaceDir, opts) {
  const summariesDir = resolveSummariesPath(workspaceDir, opts);
  // Two layouts supported:
  //   1. per-sessionId file: <summariesDir>/<sessionId>.jsonl  (W1.TEL canonical)
  //   2. workspace-local single file: <workspaceDir>/.harness/run-summaries.jsonl
  if (opts.sessionId) {
    const perSession = path.join(summariesDir, `${opts.sessionId}.jsonl`);
    const rows = readJsonl(perSession);
    if (rows !== null) return { rows, source: perSession };
  }
  // Try workspace-local single file.
  if (workspaceDir) {
    const local = path.join(workspaceDir, '.harness', 'run-summaries.jsonl');
    const rows = readJsonl(local);
    if (rows !== null) return { rows, source: local };
  }
  // Last resort: scan the summaries dir for any file matching sessionId, or
  // surface the most-recent sessionId file's contents.
  if (opts.sessionId) {
    const perSession = path.join(summariesDir, `${opts.sessionId}.jsonl`);
    throw new Error(`telemetry-asserts: run-summary file not found at ${perSession}`);
  }
  throw new Error(
    `telemetry-asserts: no run-summary records found. ` +
    `Checked workspaceDir=${workspaceDir || '<none>'} summariesDir=${summariesDir}. ` +
    `Pass {sessionId} to target a specific session.`,
  );
}

/**
 * Assert that a run-summary record exists for the given session.
 *
 * Reads `<summariesDir>/<sessionId>.jsonl` (W1.TEL canonical) or
 * `<workspaceDir>/.harness/run-summaries.jsonl` (smoke / worker-app fallback).
 *
 * @param {string} workspaceDir absolute path to test workspace
 * @param {object} [opts]
 * @param {string} [opts.sessionId] filter to this specific sessionId (default: latest record)
 * @param {string[]} [opts.requireFields] field names that must be present non-empty
 * @param {string} [opts.action] assert summary.action matches
 * @param {string} [opts.status] assert summary.status matches
 * @param {string} [opts.summariesDir] override the summaries directory
 * @returns {object} the matched record
 */
export function assertHasRunSummary(workspaceDir, opts = {}) {
  const { rows, source } = loadRunSummaryRecords(workspaceDir, opts);
  assert.ok(rows.length > 0,
    `assertHasRunSummary: no records found in ${source}`);

  // If sessionId was passed, all records in the per-sessionId file are already
  // for that session. If not, take the most-recent one (assumes append-only).
  const matched = opts.sessionId
    ? rows.filter(r => r.sessionId === opts.sessionId)
    : rows;
  assert.ok(matched.length > 0,
    `assertHasRunSummary: no records match sessionId=${opts.sessionId} in ${source}`);

  const latest = matched[matched.length - 1];

  if (opts.action != null) {
    assert.equal(latest.action, opts.action,
      `assertHasRunSummary: action mismatch (expected ${opts.action}, got ${latest.action})`);
  }
  if (opts.status != null) {
    assert.equal(latest.status, opts.status,
      `assertHasRunSummary: status mismatch (expected ${opts.status}, got ${latest.status})`);
  }
  if (Array.isArray(opts.requireFields)) {
    for (const field of opts.requireFields) {
      const val = latest[field];
      const empty = val == null || val === '' ||
        (Array.isArray(val) && val.length === 0) ||
        (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0);
      assert.ok(!empty,
        `assertHasRunSummary: required field "${field}" is empty/missing (source=${source})`);
    }
  }
  return latest;
}

/**
 * Assert that snippet-fetches.jsonl exists with the expected fetches.
 *
 * Reads `<workspaceDir>/.harness/snippet-fetches.jsonl` (W3.TEL §M item 3).
 *
 * @param {string} workspaceDir absolute path to test workspace
 * @param {object} [opts]
 * @param {string} [opts.sessionId] filter to rows with this sessionId
 * @param {string[]} [opts.expectedScopes] each scope must appear at least once
 * @param {number} [opts.minCount] minimum total row count after filtering
 * @param {string} [opts.snippetPath] at least one row must reference this path
 * @returns {object[]} the matched rows
 */
export function assertHasSnippetFetches(workspaceDir, opts = {}) {
  assert.ok(workspaceDir, 'assertHasSnippetFetches: workspaceDir is required');
  const file = path.join(workspaceDir, '.harness', 'snippet-fetches.jsonl');
  const rows = readJsonl(file);
  if (rows === null) {
    assert.fail(`assertHasSnippetFetches: file not found: ${file}`);
  }
  let matched = rows;
  if (opts.sessionId != null) {
    matched = matched.filter(r => r.sessionId === opts.sessionId);
  }
  if (opts.snippetPath != null) {
    matched = matched.filter(r => r.snippetPath === opts.snippetPath);
  }
  const minCount = typeof opts.minCount === 'number' ? opts.minCount : 1;
  assert.ok(matched.length >= minCount,
    `assertHasSnippetFetches: expected at least ${minCount} matching row(s), got ${matched.length} ` +
    `(filters: ${JSON.stringify({ sessionId: opts.sessionId, snippetPath: opts.snippetPath })}, file: ${file})`);

  if (Array.isArray(opts.expectedScopes)) {
    const seen = new Set(matched.map(r => r.scope));
    for (const scope of opts.expectedScopes) {
      assert.ok(seen.has(scope),
        `assertHasSnippetFetches: expected scope "${scope}" not found in fetches (seen: [${[...seen].join(',')}], file: ${file})`);
    }
  }
  return matched;
}

/**
 * Assert reconciler-verdicts.jsonl exists with verdicts of expected kinds.
 *
 * Reads `<workspaceDir>/.harness/reconciler-verdicts.jsonl` (W3.TEL §M item 4).
 *
 * @param {string} workspaceDir absolute path to test workspace
 * @param {object} [opts]
 * @param {string} [opts.sessionId] filter to rows with this sessionId (rare;
 *   verdicts don't always carry sessionId — accepts undefined sessionId rows)
 * @param {string} [opts.kind] data_model | api_contract | ui_contract
 * @param {string} [opts.verdict] ok | mismatch | legitimate | noise
 * @param {string} [opts.scope] filter to this scope
 * @param {number} [opts.minCount] minimum row count after filtering (default 1)
 * @returns {object[]} the matched rows
 */
export function assertHasReconcilerVerdicts(workspaceDir, opts = {}) {
  assert.ok(workspaceDir, 'assertHasReconcilerVerdicts: workspaceDir is required');
  const file = path.join(workspaceDir, '.harness', 'reconciler-verdicts.jsonl');
  const rows = readJsonl(file);
  if (rows === null) {
    assert.fail(`assertHasReconcilerVerdicts: file not found: ${file}`);
  }
  let matched = rows;
  if (opts.sessionId != null) {
    matched = matched.filter(r => r.sessionId === opts.sessionId || r.sessionId == null);
  }
  if (opts.kind != null) {
    matched = matched.filter(r => r.kind === opts.kind);
  }
  if (opts.verdict != null) {
    matched = matched.filter(r => r.verdict === opts.verdict);
  }
  if (opts.scope != null) {
    matched = matched.filter(r => r.scope === opts.scope);
  }
  const minCount = typeof opts.minCount === 'number' ? opts.minCount : 1;
  assert.ok(matched.length >= minCount,
    `assertHasReconcilerVerdicts: expected at least ${minCount} matching row(s), got ${matched.length} ` +
    `(filters: ${JSON.stringify({ sessionId: opts.sessionId, kind: opts.kind, verdict: opts.verdict, scope: opts.scope })}, file: ${file})`);
  return matched;
}

/**
 * Assert auto-recovery attempt records exist in the run-summary.
 *
 * Auto-recovery records are written as `autoRecoveryAttempts[]` inside the
 * run-summary record (not a separate file). This helper resolves the
 * run-summary the same way `assertHasRunSummary` does, then filters the
 * autoRecoveryAttempts array.
 *
 * @param {string} workspaceDir absolute path to test workspace
 * @param {object} [opts]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.scope]
 * @param {number} [opts.minAttempts] minimum number of records after filtering (default 1)
 * @param {boolean} [opts.exhausted] require at least one record with exhausted===true
 * @param {string} [opts.triggeredBy] 'reconciler' | 'smoke'
 * @param {string} [opts.summariesDir] override the summaries directory
 * @returns {object[]} the matched records
 */
export function assertHasAutoRecoveryAttempts(workspaceDir, opts = {}) {
  const { rows, source } = loadRunSummaryRecords(workspaceDir, opts);
  const records = rows.flatMap(r => Array.isArray(r.autoRecoveryAttempts) ? r.autoRecoveryAttempts : []);
  let matched = records;
  if (opts.scope != null) {
    matched = matched.filter(r => r.scope === opts.scope);
  }
  if (opts.triggeredBy != null) {
    matched = matched.filter(r => r.triggeredBy === opts.triggeredBy);
  }
  const minAttempts = typeof opts.minAttempts === 'number' ? opts.minAttempts : 1;
  assert.ok(matched.length >= minAttempts,
    `assertHasAutoRecoveryAttempts: expected at least ${minAttempts} record(s), got ${matched.length} ` +
    `(filters: ${JSON.stringify({ scope: opts.scope, triggeredBy: opts.triggeredBy })}, source: ${source})`);
  if (opts.exhausted === true) {
    assert.ok(matched.some(r => r.exhausted === true),
      `assertHasAutoRecoveryAttempts: expected at least one record with exhausted===true (source: ${source})`);
  }
  return matched;
}

/**
 * Assert investigator record exists in the run-summary.
 *
 * Investigator records are written as `investigatorRecords[]` inside the
 * run-summary record (not a separate file). Mirror shape of
 * `assertHasAutoRecoveryAttempts`.
 *
 * @param {string} workspaceDir absolute path to test workspace
 * @param {object} [opts]
 * @param {string} [opts.sessionId]
 * @param {number} [opts.confidence] minimum confidence on at least one record
 * @param {boolean} [opts.branched] true → at least one record with hasContractChange truthy or recommendedFix present
 * @param {number} [opts.minFilesRead] minimum filesRead count on at least one record
 * @param {string} [opts.summariesDir]
 * @returns {object[]} the matched records
 */
export function assertHasInvestigatorRecords(workspaceDir, opts = {}) {
  const { rows, source } = loadRunSummaryRecords(workspaceDir, opts);
  const records = rows.flatMap(r => Array.isArray(r.investigatorRecords) ? r.investigatorRecords : []);
  assert.ok(records.length > 0,
    `assertHasInvestigatorRecords: no investigatorRecords found in run-summary (source: ${source})`);
  if (typeof opts.confidence === 'number') {
    assert.ok(records.some(r => typeof r.confidence === 'number' && r.confidence >= opts.confidence),
      `assertHasInvestigatorRecords: expected at least one record with confidence >= ${opts.confidence} ` +
      `(seen: [${records.map(r => r.confidence).join(',')}], source: ${source})`);
  }
  if (opts.branched === true) {
    assert.ok(records.some(r => r.recommendedFix && (r.recommendedFix.scope || r.recommendedFix.description)),
      `assertHasInvestigatorRecords: expected at least one record with recommendedFix populated (source: ${source})`);
  }
  if (typeof opts.minFilesRead === 'number') {
    assert.ok(records.some(r => Array.isArray(r.filesRead) && r.filesRead.length >= opts.minFilesRead),
      `assertHasInvestigatorRecords: expected at least one record with filesRead.length >= ${opts.minFilesRead} (source: ${source})`);
  }
  return records;
}

/**
 * Assert that a telemetry write failure was contained by logAndSwallow.
 *
 * The caller provides the captured stderr text (typically captured via a
 * process.stderr.write monkey-patch in the surrounding test). This helper
 * asserts: (a) the test process did not crash (implied by the helper being
 * reached), (b) stderr contains a `[telemetry-X]` label confirming the
 * containment path fired.
 *
 * @param {object} opts
 * @param {string} opts.stderr captured stderr text
 * @param {string} [opts.label] e.g. 'telemetry-reconciler-verdicts'; default
 *   matches any `[telemetry-...]` prefix
 */
export function assertLogAndSwallowContained(opts = {}) {
  assert.ok(opts && typeof opts.stderr === 'string',
    'assertLogAndSwallowContained: opts.stderr is required (captured stderr text)');
  const label = opts.label || null;
  if (label) {
    const re = new RegExp(`\\[${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`);
    assert.ok(re.test(opts.stderr),
      `assertLogAndSwallowContained: expected stderr to contain [${label}], got: ${opts.stderr.slice(0, 200)}`);
  } else {
    assert.ok(/\[telemetry-[a-z0-9-]+\]/.test(opts.stderr),
      `assertLogAndSwallowContained: expected stderr to contain a [telemetry-X] label, got: ${opts.stderr.slice(0, 200)}`);
  }
}

// Exposed for tests of the helper itself.
export const __test = {
  CANONICAL_SUMMARIES_DIR,
};
