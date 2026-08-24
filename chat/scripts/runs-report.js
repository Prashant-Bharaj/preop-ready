#!/usr/bin/env node
/**
 * On-demand aggregation report over the harness's structured run logs.
 *
 * HARNESS_EVOLUTION.md §M item 9 — W4.BUDGET.3.
 *
 *   node chat/scripts/runs-report.js [--since=7d] [--scenario=<id>] [--scope=<scope>] [--out=<file>]
 *
 * Inputs (read-only):
 *   - chat/server/agent/run-logs/_summaries/<sessionId>.jsonl  (W1.TEL + W3.TEL)
 *   - chat/server/agent/run-logs/<sessionId>/<phase>/llm-calls.jsonl  (W1.TEL — per-call latency + cost)
 *   - chat/tests/smoke/smoke-metrics.jsonl  (per-scenario pass/fail/duration)
 *   - chat/tests/smoke/*.flake-notes.md  (known-flake classification rules)
 *
 * Output: markdown to stdout (or --out=<file>). Six sections:
 *   1. Top 5 most-failing scopes (last N runs in window)
 *   2. Token trends per scope (avg prompt/completion/cached, first-half vs second-half)
 *   3. Regression alerts — pass→fail flips since prior window (flake-notes honoured)
 *   4. Highest-cost runs (top 5 by costUsd)
 *   5. Snippet hit rate (which snippets pulled vs ignored — zero-fetch = pruning candidate)
 *   6. Reconciler verdict distribution (ok/mismatch/legitimate/noise)
 *
 * Run-summary records may not exist yet on a fresh repo; sections that depend
 * on them gracefully report "no data" rather than erroring. Smoke metrics are
 * the canonical scenario tracker so sections 1-3 work even with no summaries.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname, '..', '..');
const SUMMARIES_DIR = path.join(SPIKE_ROOT, 'chat', 'server', 'agent', 'run-logs', '_summaries');
const RUN_LOGS_DIR = path.join(SPIKE_ROOT, 'chat', 'server', 'agent', 'run-logs');
const SMOKE_METRICS_PATH = path.join(SPIKE_ROOT, 'chat', 'tests', 'smoke', 'smoke-metrics.jsonl');
const SMOKE_DIR = path.join(SPIKE_ROOT, 'chat', 'tests', 'smoke');

// ── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { since: '7d', scenario: null, scope: null, out: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--since=')) opts.since = arg.slice('--since='.length);
    else if (arg.startsWith('--scenario=')) opts.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--scope=')) opts.scope = arg.slice('--scope='.length);
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node chat/scripts/runs-report.js [--since=7d] [--scenario=<id>] [--scope=<scope>] [--out=<file>]');
      process.exit(0);
    }
  }
  return opts;
}

function parseDuration(s) {
  const m = String(s).match(/^(\d+)([hdw])$/);
  if (!m) throw new Error(`bad --since value "${s}" (expected like 24h / 7d / 2w)`);
  const n = parseInt(m[1], 10);
  const unitMs = { h: 3600_000, d: 86400_000, w: 7 * 86400_000 }[m[2]];
  return n * unitMs;
}

// ── JSONL readers ──────────────────────────────────────────────────────

function readJsonlLines(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); }
    catch { /* skip malformed line; data corruption is rare and shouldn't block the report */ }
  }
  return out;
}

function readAllRunSummaries() {
  if (!existsSync(SUMMARIES_DIR)) return [];
  const files = readdirSync(SUMMARIES_DIR).filter(f => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    for (const rec of readJsonlLines(path.join(SUMMARIES_DIR, f))) {
      records.push(rec);
    }
  }
  return records;
}

function readSmokeMetrics() {
  return readJsonlLines(SMOKE_METRICS_PATH);
}

// Walk run-logs/<sessionId>/<phase>/llm-calls.jsonl for sessions that have
// no run-summary record (older runs predating W1.TEL). Used by sections 2 and 4
// as a fallback when summaries are sparse.
function readLlmCallsForSession(sessionId) {
  const sessionDir = path.join(RUN_LOGS_DIR, sessionId);
  if (!existsSync(sessionDir)) return [];
  let allCalls = [];
  for (const entry of readdirSync(sessionDir)) {
    const phaseDir = path.join(sessionDir, entry);
    let isDir = false;
    try { isDir = statSync(phaseDir).isDirectory(); } catch { /* skip */ }
    if (!isDir) continue;
    const llmFile = path.join(phaseDir, 'llm-calls.jsonl');
    for (const c of readJsonlLines(llmFile)) {
      allCalls.push({ ...c, phase: entry });
    }
  }
  return allCalls;
}

// ── Flake-notes parser ─────────────────────────────────────────────────

function readKnownFlakes() {
  // Read every *.flake-notes.md file under chat/tests/smoke/ and extract
  // scenarioIds marked as known-flake. Looks for backtick-quoted scenario IDs
  // appearing in lines that mention "flake", "known-flake", or "pass-rate trend
  // only" — heuristic but stable across the existing flake-notes documents.
  if (!existsSync(SMOKE_DIR)) return new Set();
  const flakes = new Set();
  for (const f of readdirSync(SMOKE_DIR)) {
    if (!f.endsWith('.flake-notes.md')) continue;
    let text;
    try { text = readFileSync(path.join(SMOKE_DIR, f), 'utf8'); } catch { continue; }
    const re = /[`"]([\w-]+)[`"][^\n]*(known.flake|flake-prone|pass.rate trend only)/gi;
    let m;
    while ((m = re.exec(text)) !== null) flakes.add(m[1]);
  }
  return flakes;
}

// ── Section builders ───────────────────────────────────────────────────

function sectionHeader(opts, windowMs, summaries, smoke, flakes) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const lines = [];
  lines.push('# Harness runs report');
  lines.push('');
  lines.push(`- Window: since ${since} (--since=${opts.since})`);
  if (opts.scenario) lines.push(`- Scenario filter: \`${opts.scenario}\``);
  if (opts.scope) lines.push(`- Scope filter: \`${opts.scope}\``);
  lines.push(`- Run-summary records in window: ${summaries.length}`);
  lines.push(`- Smoke-metric records in window: ${smoke.length}`);
  lines.push(`- Known-flake scenarios (excluded from regression alerts): ${[...flakes].sort().join(', ') || '(none)'}`);
  lines.push('');
  return lines.join('\n');
}

function sectionTopFailingScopes(smoke, opts) {
  const lines = ['## 1. Top 5 most-failing scopes', ''];
  const counts = new Map(); // scope -> { pass, fail }
  for (const r of smoke) {
    if (opts.scenario && r.scenarioId !== opts.scenario) continue;
    const scopes = (r.scopes || '').split('+').filter(Boolean);
    if (opts.scope && !scopes.includes(opts.scope)) continue;
    for (const s of scopes) {
      if (!counts.has(s)) counts.set(s, { pass: 0, fail: 0 });
      const c = counts.get(s);
      if (r.status === 'pass') c.pass += 1;
      else c.fail += 1;
    }
  }
  const rows = [...counts.entries()]
    .map(([scope, c]) => ({ scope, ...c, total: c.pass + c.fail, failRate: c.fail / Math.max(c.pass + c.fail, 1) }))
    .sort((a, b) => b.fail - a.fail)
    .slice(0, 5);
  if (rows.length === 0) {
    lines.push('_No smoke data in window._');
  } else {
    lines.push('| scope | runs | pass | fail | fail-rate |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const r of rows) {
      lines.push(`| ${r.scope} | ${r.total} | ${r.pass} | ${r.fail} | ${(r.failRate * 100).toFixed(1)}% |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function sectionTokenTrends(smoke, summaries, opts) {
  const lines = ['## 2. Token trends per scope', ''];
  // Prefer run-summaries (richer token breakdown). Fall back to smoke
  // promptTokens for older entries.
  const buckets = new Map(); // scope -> { firstHalf: {p,c,k,n}, secondHalf: {p,c,k,n} }
  const sortedSummaries = summaries
    .filter(s => Number.isFinite(s.startedAt))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (sortedSummaries.length < 2) {
    // Fall through to smoke-derived single-bucket if too few summaries
    lines.push('_Insufficient run-summary records for trend (need ≥2); falling back to smoke promptTokens single-bucket._');
    lines.push('');
    const scopeAgg = new Map();
    for (const r of smoke) {
      if (opts.scenario && r.scenarioId !== opts.scenario) continue;
      const scopes = (r.scopes || '').split('+').filter(Boolean);
      const pt = r.promptTokens;
      if (!Number.isFinite(pt)) continue;
      for (const s of scopes) {
        if (opts.scope && s !== opts.scope) continue;
        if (!scopeAgg.has(s)) scopeAgg.set(s, { sum: 0, n: 0 });
        const a = scopeAgg.get(s);
        a.sum += pt;
        a.n += 1;
      }
    }
    if (scopeAgg.size === 0) {
      lines.push('_No smoke promptToken data in window._');
    } else {
      lines.push('| scope | avg promptTokens | samples |');
      lines.push('|---|---:|---:|');
      for (const [scope, a] of [...scopeAgg].sort((x, y) => y[1].n - x[1].n)) {
        lines.push(`| ${scope} | ${Math.round(a.sum / a.n).toLocaleString()} | ${a.n} |`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }
  const mid = sortedSummaries[Math.floor(sortedSummaries.length / 2)].startedAt;
  for (const s of sortedSummaries) {
    for (const scope of (s.scopes || [])) {
      if (opts.scope && scope !== opts.scope) continue;
      if (!buckets.has(scope)) {
        buckets.set(scope, { firstHalf: { p: 0, c: 0, k: 0, n: 0 }, secondHalf: { p: 0, c: 0, k: 0, n: 0 } });
      }
      const b = buckets.get(scope);
      const half = s.startedAt < mid ? b.firstHalf : b.secondHalf;
      half.p += s.tokens?.prompt || 0;
      half.c += s.tokens?.completion || 0;
      half.k += s.tokens?.cached || 0;
      half.n += 1;
    }
  }
  lines.push('| scope | 1st-half avg prompt | 2nd-half avg prompt | Δ | 1st-half avg completion | 2nd-half avg completion |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [scope, b] of buckets) {
    const p1 = b.firstHalf.n ? b.firstHalf.p / b.firstHalf.n : 0;
    const p2 = b.secondHalf.n ? b.secondHalf.p / b.secondHalf.n : 0;
    const c1 = b.firstHalf.n ? b.firstHalf.c / b.firstHalf.n : 0;
    const c2 = b.secondHalf.n ? b.secondHalf.c / b.secondHalf.n : 0;
    const delta = p1 ? (((p2 - p1) / p1) * 100).toFixed(1) + '%' : '—';
    lines.push(`| ${scope} | ${Math.round(p1).toLocaleString()} | ${Math.round(p2).toLocaleString()} | ${delta} | ${Math.round(c1).toLocaleString()} | ${Math.round(c2).toLocaleString()} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function sectionRegressionAlerts(smoke, flakes, opts, windowMs) {
  const lines = ['## 3. Regression alerts (pass→fail flips, flakes excluded)', ''];
  // Compare scenarios in the current window vs the prior window of equal size.
  const now = Date.now();
  const cur = smoke.filter(r => (now - new Date(r.timestamp).getTime()) <= windowMs);
  const prior = smoke.filter(r => {
    const age = now - new Date(r.timestamp).getTime();
    return age > windowMs && age <= 2 * windowMs;
  });
  function latestStatusBy(records) {
    const out = new Map();
    for (const r of records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
      out.set(r.scenarioId, r.status);
    }
    return out;
  }
  const curStatus = latestStatusBy(cur);
  const priorStatus = latestStatusBy(prior);
  const regressed = [];
  for (const [id, curS] of curStatus) {
    if (opts.scenario && id !== opts.scenario) continue;
    if (flakes.has(id)) continue;
    const priorS = priorStatus.get(id);
    if (priorS === 'pass' && curS !== 'pass') regressed.push({ scenarioId: id, prior: priorS, cur: curS });
  }
  if (regressed.length === 0) {
    lines.push('_No regressions detected._');
  } else {
    lines.push('| scenario | prior window | current window |');
    lines.push('|---|---|---|');
    for (const r of regressed) lines.push(`| ${r.scenarioId} | ${r.prior} | ${r.cur} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function sectionHighestCost(summaries, opts) {
  const lines = ['## 4. Highest-cost runs (top 5 by costUsd)', ''];
  const filtered = summaries.filter(s => Number.isFinite(s.costUsd));
  if (filtered.length === 0) {
    lines.push('_No costUsd data in window. Cost rollup requires `costUsd` on run-summary records (W1.TEL pricing table)._');
    lines.push('');
    return lines.join('\n');
  }
  let rows = [...filtered].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  if (opts.scenario) {
    // intent often carries scenarioId in smoke runs; fall back to scopes if not
    rows = rows.filter(r => (r.intent || '').includes(opts.scenario));
  }
  if (opts.scope) rows = rows.filter(r => (r.scopes || []).includes(opts.scope));
  rows = rows.slice(0, 5);
  if (rows.length === 0) {
    lines.push('_No matches after filters._');
  } else {
    lines.push('| sessionId | scopes | totalMs | costUsd | mgaCalls |');
    lines.push('|---|---|---:|---:|---:|');
    for (const r of rows) {
      lines.push(`| ${(r.sessionId || '').slice(0, 8)} | ${(r.scopes || []).join('+')} | ${Math.round((r.totalMs || 0) / 1000)}s | $${(r.costUsd || 0).toFixed(4)} | ${r.mgaCalls || 0} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function sectionSnippetHitRate(summaries, opts) {
  const lines = ['## 5. Snippet hit rate (paths pulled vs ignored)', ''];
  const counts = new Map(); // snippetPath -> count
  let totalFetches = 0;
  for (const s of summaries) {
    for (const f of (s.snippetFetches || [])) {
      if (opts.scope && f.scope !== opts.scope) continue;
      const p = f.snippetPath || '(unknown)';
      counts.set(p, (counts.get(p) || 0) + 1);
      totalFetches += 1;
    }
  }
  if (totalFetches === 0) {
    lines.push('_No snippet-fetch data in window. snippetFetches[] is populated by W3.TEL via the run-summary mirror._');
    lines.push('');
    return lines.join('\n');
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  lines.push(`Total fetches in window: ${totalFetches}. Unique snippets: ${counts.size}.`);
  lines.push('');
  lines.push('| snippet | fetches | share |');
  lines.push('|---|---:|---:|');
  for (const [snippetPath, n] of sorted.slice(0, 20)) {
    lines.push(`| \`${snippetPath}\` | ${n} | ${((n / totalFetches) * 100).toFixed(1)}% |`);
  }
  // Zero-fetch snippets — list catalog vs fetched-set to flag pruning candidates
  const snippetsDir = path.join(SPIKE_ROOT, 'snippets');
  if (existsSync(snippetsDir)) {
    const cataloged = new Set();
    function walk(dir) {
      try {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isDirectory()) walk(full);
          else if (/\.(js|jsx|ts|tsx|py|sql|yml|yaml|md|conf)$/i.test(entry)) {
            const rel = path.relative(snippetsDir, full).replace(/\\/g, '/');
            cataloged.add(rel);
          }
        }
      } catch { /* skip unreadable */ }
    }
    walk(snippetsDir);
    const fetched = new Set([...counts.keys()].map(p => {
      // Normalize MCP-style paths to relative-snippets paths
      const m = String(p).match(/snippets\/(.+)$/);
      return m ? m[1] : p;
    }));
    const orphans = [...cataloged].filter(p => !fetched.has(p));
    lines.push('');
    if (orphans.length > 0) {
      lines.push(`**Zero-fetch snippets (pruning candidates):** ${orphans.length} of ${cataloged.size} cataloged.`);
      lines.push('');
      for (const o of orphans.slice(0, 20)) lines.push(`- \`${o}\``);
      if (orphans.length > 20) lines.push(`- ...and ${orphans.length - 20} more`);
    } else {
      lines.push('**Zero-fetch snippets:** none (all cataloged snippets fetched at least once in window).');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function sectionReconcilerVerdicts(summaries, opts) {
  const lines = ['## 6. Reconciler verdict distribution', ''];
  const totals = { ok: 0, mismatch: 0, legitimate: 0, noise: 0 };
  const byScope = new Map(); // scope -> { ok, mismatch, legitimate, noise }
  let withVerdicts = 0;
  for (const s of summaries) {
    const v = s.reconcilerVerdicts || {};
    const hasAny = (v.ok || 0) + (v.mismatch || 0) + (v.legitimate || 0) + (v.noise || 0) > 0;
    if (!hasAny) continue;
    withVerdicts += 1;
    for (const k of ['ok', 'mismatch', 'legitimate', 'noise']) totals[k] += v[k] || 0;
    for (const scope of (s.scopes || [])) {
      if (opts.scope && scope !== opts.scope) continue;
      if (!byScope.has(scope)) byScope.set(scope, { ok: 0, mismatch: 0, legitimate: 0, noise: 0 });
      const acc = byScope.get(scope);
      // Run-summary's reconcilerVerdicts is build-level (not per-scope) today;
      // attribute proportionally to scopes participating in the build. This is
      // an approximation; W4 telemetry can later split verdicts per-scope.
      const fraction = 1 / (s.scopes?.length || 1);
      for (const k of ['ok', 'mismatch', 'legitimate', 'noise']) {
        acc[k] += (v[k] || 0) * fraction;
      }
    }
  }
  if (withVerdicts === 0) {
    lines.push('_No reconciler verdict data in window. reconcilerVerdicts is populated by W3.TEL via the run-summary mirror; requires a multi-scope build with reconciler activity._');
    lines.push('');
    return lines.join('\n');
  }
  const grand = totals.ok + totals.mismatch + totals.legitimate + totals.noise;
  lines.push('**Totals across window:**');
  lines.push('');
  lines.push('| verdict | count | share |');
  lines.push('|---|---:|---:|');
  for (const k of ['ok', 'mismatch', 'legitimate', 'noise']) {
    lines.push(`| ${k} | ${totals[k]} | ${((totals[k] / grand) * 100).toFixed(1)}% |`);
  }
  lines.push('');
  if (byScope.size > 0) {
    lines.push('**By scope (proportionally attributed):**');
    lines.push('');
    lines.push('| scope | ok | mismatch | legitimate | noise |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const [scope, acc] of byScope) {
      lines.push(`| ${scope} | ${acc.ok.toFixed(1)} | ${acc.mismatch.toFixed(1)} | ${acc.legitimate.toFixed(1)} | ${acc.noise.toFixed(1)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv);
  const windowMs = parseDuration(opts.since);
  const now = Date.now();
  const cutoff = now - windowMs;
  const allSummaries = readAllRunSummaries();
  const allSmoke = readSmokeMetrics();
  const summaries = allSummaries.filter(s => (s.startedAt || s.endedAt || 0) >= cutoff);
  const smoke = allSmoke.filter(r => new Date(r.timestamp).getTime() >= cutoff);
  const flakes = readKnownFlakes();
  const out = [
    sectionHeader(opts, windowMs, summaries, smoke, flakes),
    sectionTopFailingScopes(smoke, opts),
    sectionTokenTrends(smoke, summaries, opts),
    sectionRegressionAlerts(allSmoke, flakes, opts, windowMs),
    sectionHighestCost(summaries, opts),
    sectionSnippetHitRate(summaries, opts),
    sectionReconcilerVerdicts(summaries, opts),
  ].join('\n');
  if (opts.out) {
    writeFileSync(opts.out, out);
    console.error(`runs-report written to ${opts.out}`);
  } else {
    process.stdout.write(out);
  }
}

main();
