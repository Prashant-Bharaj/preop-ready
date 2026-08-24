#!/usr/bin/env node
/**
 * Persistent per-scenario smoke metrics.
 *
 * - `recordSmokeMetric(result)` is called from smoke.js's runScenario /
 *   runMultiScopeScenario before they return, and appends one JSON line to
 *   chat/server/agent/smoke-metrics.jsonl. Every smoke run grows the file
 *   by one line per scenario; the file is committed for shared baseline.
 *
 * - Run as a CLI (`npm run smoke:metrics`) to read the JSONL, group by
 *   scenarioId, keep the latest entry, and print a summary table.
 *
 * Phase C collapsed dispatch to a single mode: every multi-scope run
 * goes through the LLM orchestrator, every single-scope run goes through
 * the deployed scope-specific subagent. The legacy mode discriminator
 * (JS-fanout vs orchestrator for multi; coder vs subagent for single)
 * is gone — see docs/RETIRED_JS_FANOUT.md and Surgery B's commit.
 *
 * The schema is permissive: any field may be null; readers must handle
 * missing keys for older entries (pre-Phase-C) which still carry a `mode`
 * field of "JS-fanout"/"coder"/etc. that this writer no longer emits.
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// chat/tests/smoke/smoke-metrics.js → spike root is 3 levels up
const SPIKE_ROOT = path.resolve(__dirname, '..', '..', '..');
const METRICS_PATH = path.join(__dirname, 'smoke-metrics.jsonl');

// ── Git context ──────────────────────────────────────────────────────────────

function gitContext() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: SPIKE_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const sha = execSync('git rev-parse --short HEAD', { cwd: SPIKE_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { branch, sha };
  } catch {
    return { branch: null, sha: null };
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

/**
 * Append one JSON line to smoke-metrics.jsonl. Called from runScenario and
 * runMultiScopeScenario in smoke.js. Errors are swallowed — metrics must
 * never break a smoke run.
 *
 * @param {object} result - the result object returned by the runner.
 *   Multi-scope: { scenario, status, durationMs, observed, assertNotes, error, sessionId }
 *   Single-scope: { scenario, status, durationMs, result, assertNotes, sessionId, error? }
 */
export function recordSmokeMetric(result) {
  try {
    const scenario = result.scenario || {};
    const isMulti = scenario.mode === 'multi-scope';

    // Tokens / api calls only available for single-scope (multi-scope runs
    // in a subprocess and doesn't pipe aggregated totals back today).
    const tokens = result.result?.runTokenTotals || {};
    const promptTokens = isMulti ? null : (tokens.promptTokens ?? null);
    const completionTokens = isMulti ? null : (tokens.completionTokens ?? null);
    const apiCalls = isMulti ? null : (tokens.apiCalls ?? null);

    // Multi-scope-specific fields from observed.
    const observed = result.observed || {};
    const composeMs = isMulti ? (observed.composeUpDurationMs ?? null) : null;
    const scopes = isMulti ? (observed.scopes?.join('+') || null) : (scenario.scope || null);
    const retries = isMulti ? (observed.retries ?? 0) : null;

    const entry = {
      scenarioId: scenario.id,
      timestamp: new Date().toISOString(),
      status: result.status,
      durationMs: result.durationMs ?? null,
      promptTokens,
      completionTokens,
      apiCalls,
      composeMs,
      scopes,
      retries,
      assertNotes: result.assertNotes || null,
      error: result.error || null,
      git: gitContext(),
    };

    appendFileSync(METRICS_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Swallow — metrics MUST NOT break smoke runs.
    console.error(`[smoke-metrics] WARN: append failed: ${err.message}`);
  }
}

// ── Reader ───────────────────────────────────────────────────────────────────

function readAllEntries() {
  if (!existsSync(METRICS_PATH)) return [];
  const lines = readFileSync(METRICS_PATH, 'utf-8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); }
    catch { /* skip malformed */ }
  }
  return entries;
}

/**
 * Group by scenarioId, keep the latest by timestamp.
 */
function latestPerScenario(entries) {
  const map = new Map();
  for (const e of entries) {
    const prev = map.get(e.scenarioId);
    if (!prev || e.timestamp > prev.timestamp) map.set(e.scenarioId, e);
  }
  return [...map.values()];
}

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtStatus(status) {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  if (status === 'error') return 'ERR ';
  return '?   ';
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printSummary() {
  const all = readAllEntries();
  if (all.length === 0) {
    console.log('[smoke-metrics] no entries yet — run `npm run smoke -- --only=<scenario>` to seed.');
    return;
  }
  const latest = latestPerScenario(all);

  // Order: multi-scope first, then single-scope; alpha within each group.
  latest.sort((a, b) => {
    const aMulti = a.composeMs != null;
    const bMulti = b.composeMs != null;
    if (aMulti !== bMulti) return aMulti ? -1 : 1;
    return (a.scenarioId || '').localeCompare(b.scenarioId || '');
  });

  const multi = latest.filter(e => e.composeMs != null);
  const single = latest.filter(e => e.composeMs == null);

  if (multi.length > 0) {
    console.log('');
    console.log('── Multi-scope ─────────────────────────────────────────────────────────────────────');
    console.log('scenario                  status  duration  composeMs  scopes                    retries');
    console.log('─'.repeat(95));
    for (const e of multi) {
      const composeStr = e.composeMs != null ? fmtMs(e.composeMs) : '—';
      console.log(
        `${(e.scenarioId || '').padEnd(26)}${fmtStatus(e.status).padEnd(8)}${fmtMs(e.durationMs).padStart(8)}  ${composeStr.padStart(9)}  ${(e.scopes || '').padEnd(26)}${String(e.retries ?? 0).padStart(7)}`
      );
    }
  }

  if (single.length > 0) {
    console.log('');
    console.log('── Single-scope ───────────────────────────────────────────────────────────────────');
    console.log('scenario                  status  duration  promptTok  apiCalls  scope');
    console.log('─'.repeat(85));
    for (const e of single) {
      console.log(
        `${(e.scenarioId || '').padEnd(26)}${fmtStatus(e.status).padEnd(8)}${fmtMs(e.durationMs).padStart(8)}  ${fmtTok(e.promptTokens).padStart(9)}  ${String(e.apiCalls ?? '—').padStart(8)}  ${e.scopes || ''}`
      );
    }
  }

  console.log('');
  console.log(`(${all.length} total runs in smoke-metrics.jsonl; showing latest per scenario)`);
}

// CLI entry — only run when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  printSummary();
}
