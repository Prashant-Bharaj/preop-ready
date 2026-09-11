#!/usr/bin/env node
/**
 * Probe: is MGA /chat/completions deterministic at temperature 0?
 *
 * Bypasses /chat/agent and assistant_id entirely. Sends the same prompt
 * N_RUNS times directly to /chat/completions with explicit model +
 * temperature + seed. Measures variance magnitude (char range across
 * outputs) — not just hash uniqueness.
 *
 * If outputs are byte-identical or have tiny char-range (<5% spread),
 * /chat/completions is deterministic → /chat/agent has the determinism
 * bug, not the underlying inference layer.
 *
 * Usage:
 *   node chat/scripts/probe-completions-determinism.js
 *   PROBE_PROMPT="..." node chat/scripts/probe-completions-determinism.js
 *   node chat/scripts/probe-completions-determinism.js --model=<id> --temperature=<t>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_MODEL = 'gpt-4o-2024-08-06';
const N_RUNS = 5;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_SEED = 42;
const DEFAULT_PROMPT = 'Explain recursion to a beginner.';

function parseArgs(argv) {
  const opts = {
    model: DEFAULT_MODEL,
    temperature: DEFAULT_TEMPERATURE,
    seed: DEFAULT_SEED,
    nRuns: N_RUNS,
    noTemperature: false,
    noSeed: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--model=')) opts.model = arg.slice('--model='.length);
    else if (arg.startsWith('--temperature=')) opts.temperature = Number(arg.slice('--temperature='.length));
    else if (arg.startsWith('--seed=')) opts.seed = Number(arg.slice('--seed='.length));
    else if (arg.startsWith('--runs=')) opts.nRuns = Number(arg.slice('--runs='.length));
    else if (arg === '--no-temperature') opts.noTemperature = true;
    else if (arg === '--no-seed') opts.noSeed = true;
  }
  return opts;
}

function loadSecrets() {
  const secretsPath = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  if (!fs.existsSync(secretsPath)) throw new Error(`secrets.json not found at ${secretsPath}`);
  const data = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL || data.baseUrl;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || data.apiKey;
  if (!baseUrl || !apiKey) throw new Error('No baseUrl or apiKey resolved');
  return { baseUrl, apiKey };
}

function extractContent(response) {
  if (typeof response?.choices?.[0]?.message?.content === 'string') {
    return response.choices[0].message.content;
  }
  if (typeof response?.content === 'string') return response.content;
  return null;
}

function hashContent(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

async function callCompletions({ model, temperature, seed, message, baseUrl, apiKey, noTemperature, noSeed }) {
  const body = {
    messages: [{ role: 'user', content: message }],
    model,
    stream: false,
  };
  if (!noTemperature) body.temperature = temperature;
  if (!noSeed) body.seed = seed;
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Response not JSON: ${text.slice(0, 500)}`); }
}

function analyseRuns(results) {
  const valid = results.filter(r => r.contentLength != null);
  if (valid.length === 0) return null;
  const lengths = valid.map(r => r.contentLength).sort((a, b) => a - b);
  const min = lengths[0];
  const max = lengths[lengths.length - 1];
  const mean = lengths.reduce((s, n) => s + n, 0) / lengths.length;
  const range = max - min;
  const spreadPct = mean > 0 ? (range / mean) * 100 : 0;
  const uniqueHashes = new Set(valid.map(r => r.hash)).size;
  return { min, max, mean: Math.round(mean), range, spreadPct, uniqueHashes, n: valid.length, lengths };
}

function verdictFromStats(stats) {
  if (!stats) return { label: 'INVALID', detail: 'No valid responses captured' };
  if (stats.uniqueHashes === 1) {
    return { label: 'DETERMINISTIC', detail: 'All outputs byte-identical' };
  }
  if (stats.spreadPct < 1) {
    return { label: 'EFFECTIVELY DETERMINISTIC', detail: `${stats.uniqueHashes} unique hashes but <1% char-range spread (probably whitespace/punctuation variance)` };
  }
  if (stats.spreadPct < 5) {
    return { label: 'LOW VARIANCE', detail: `${stats.uniqueHashes} unique outputs, ${stats.spreadPct.toFixed(1)}% spread — surface drift only` };
  }
  if (stats.spreadPct < 15) {
    return { label: 'MODERATE VARIANCE', detail: `${stats.uniqueHashes} unique outputs, ${stats.spreadPct.toFixed(1)}% spread` };
  }
  return { label: 'HIGH VARIANCE', detail: `${stats.uniqueHashes} unique outputs, ${stats.spreadPct.toFixed(1)}% spread — structural differences run-to-run` };
}

async function main() {
  const opts = parseArgs(process.argv);
  const { baseUrl, apiKey } = loadSecrets();
  const message = process.env.PROBE_PROMPT || DEFAULT_PROMPT;

  console.log('=== /chat/completions determinism probe ===');
  console.log(`baseUrl:     ${baseUrl}`);
  console.log(`model:       ${opts.model}`);
  console.log(`temperature: ${opts.noTemperature ? '(omitted)' : opts.temperature}`);
  console.log(`seed:        ${opts.noSeed ? '(omitted)' : opts.seed}`);
  console.log(`runs:        ${opts.nRuns}`);
  console.log(`prompt:      ${message}`);
  console.log();

  const results = [];
  for (let i = 1; i <= opts.nRuns; i++) {
    const t0 = Date.now();
    try {
      const response = await callCompletions({ ...opts, message, baseUrl, apiKey });
      const ms = Date.now() - t0;
      const content = extractContent(response);
      if (content === null) {
        console.log(`  run ${i}/${opts.nRuns}: EXTRACT_FAILED ms=${ms}`);
        console.log(`    [debug] response shape: ${JSON.stringify(response).slice(0, 400)}`);
        results.push({ i, hash: 'EXTRACT_FAILED', ms });
        fs.writeFileSync(`/tmp/probe-completions-${i}.json`, JSON.stringify(response, null, 2));
        continue;
      }
      const hash = hashContent(content);
      fs.writeFileSync(`/tmp/probe-completions-${i}.json`, JSON.stringify(response, null, 2));
      console.log(`  run ${i}/${opts.nRuns}: hash=${hash} ms=${ms} chars=${content.length}`);
      results.push({ i, hash, ms, contentLength: content.length });
    } catch (err) {
      console.log(`  run ${i}/${opts.nRuns}: ERROR — ${err.message}`);
      results.push({ i, hash: 'ERROR', ms: Date.now() - t0, error: err.message });
    }
  }

  const stats = analyseRuns(results);
  console.log();
  console.log('=== STATS ===');
  if (stats) {
    console.log(`  valid runs:    ${stats.n}/${opts.nRuns}`);
    console.log(`  unique hashes: ${stats.uniqueHashes}`);
    console.log(`  char lengths:  ${stats.lengths.join(', ')}`);
    console.log(`  min/mean/max:  ${stats.min} / ${stats.mean} / ${stats.max}`);
    console.log(`  range:         ${stats.range} chars (${stats.spreadPct.toFixed(2)}% of mean)`);
  } else {
    console.log(`  no valid responses`);
  }

  const verdict = verdictFromStats(stats);
  console.log();
  console.log(`=== VERDICT: ${verdict.label} ===`);
  console.log(`  ${verdict.detail}`);
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
