#!/usr/bin/env node
/**
 * Probe: does MGA /chat/agent honor body-side `temperature` and `seed`
 * when `assistant_id` is set?
 *
 * Sends N_RUNS identical requests in two phases:
 *   - baseline: no temperature, no seed (matches today's router.js)
 *   - deterministic: temperature=0, seed=42 in the body
 *
 * Hashes the LLM content per run; compares unique-hash counts to print
 * a verdict (HONORED | IGNORED | INCONCLUSIVE). Every response body is
 * also saved to /tmp/probe-router-{phase}-{i}.json for spot-checking.
 *
 * Usage (run from spike root):
 *   node chat/scripts/probe-router-determinism.js
 *   PROBE_PROMPT="..." node chat/scripts/probe-router-determinism.js
 *   node chat/scripts/probe-router-determinism.js --assistant-id=<uuid>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_ASSISTANT_ID = '99e40517-7506-4e07-ae45-3a3356076ea1'; // BD Task Router
const N_RUNS = 5;
const TEMPERATURE = 0;
const SEED = 42;

const DEFAULT_PROMPT = [
  '[Project Context]',
  'Environment: Local',
  'Phase: empty',
  'Structure: none (fresh project)',
  '',
  '[User Message]',
  'Build a customer feedback collection app where employees can submit feedback about products, and product managers can review the feedback and reply to it. Show feedback in a list view with filters by product and status.',
].join('\n');

function parseArgs(argv) {
  const opts = { assistantId: DEFAULT_ASSISTANT_ID };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--assistant-id=')) {
      opts.assistantId = arg.slice('--assistant-id='.length);
    }
  }
  return opts;
}

function loadSecrets() {
  const secretsPath = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`secrets.json not found at ${secretsPath}`);
  }
  const data = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL || data.baseUrl;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || data.apiKey;
  if (!baseUrl || !apiKey) throw new Error('No baseUrl or apiKey resolved from secrets.json or env');
  return { baseUrl, apiKey };
}

function extractContent(response) {
  if (typeof response?.choices?.[0]?.message?.content === 'string') {
    return response.choices[0].message.content;
  }
  if (typeof response?.content === 'string') return response.content;
  if (typeof response?.message?.content === 'string') return response.message.content;
  return null;
}

function hashContent(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

async function callRouter({ assistantId, message, baseUrl, apiKey, useDeterminism }) {
  const body = {
    messages: [{ role: 'user', content: message }],
    assistant_id: assistantId,
    stream: false,
    hidden: true,
    tool_keys: [],
  };
  if (useDeterminism) {
    body.temperature = TEMPERATURE;
    body.seed = SEED;
  }
  const url = `${baseUrl.replace(/\/$/, '')}/chat/agent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
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

async function runPhase(label, n, args) {
  console.log(`\n=== Phase: ${label} (${n} runs, ${args.useDeterminism ? `temperature=${TEMPERATURE} seed=${SEED}` : 'no sampling overrides'}) ===`);
  const results = [];
  let shapeLogged = false;
  for (let i = 1; i <= n; i++) {
    const t0 = Date.now();
    try {
      const response = await callRouter(args);
      const ms = Date.now() - t0;
      const content = extractContent(response);
      const outPath = `/tmp/probe-router-${label}-${i}.json`;
      fs.writeFileSync(outPath, JSON.stringify(response, null, 2));
      if (content === null) {
        if (!shapeLogged) {
          console.log(`  [debug] response shape (no content found via known paths):`);
          console.log(`          ${JSON.stringify(response).slice(0, 600)}`);
          shapeLogged = true;
        }
        results.push({ i, hash: 'EXTRACT_FAILED', ms });
        console.log(`  run ${i}/${n}: EXTRACT_FAILED ms=${ms} → ${outPath}`);
        continue;
      }
      const hash = hashContent(content);
      console.log(`  run ${i}/${n}: hash=${hash} ms=${ms} chars=${content.length} → ${outPath}`);
      results.push({ i, hash, ms, contentLength: content.length });
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(`  run ${i}/${n}: ERROR ms=${ms} — ${err.message}`);
      results.push({ i, hash: 'ERROR', ms, error: err.message });
    }
  }
  const stats = analyseRuns(results);
  if (stats) {
    console.log(`  → ${stats.uniqueHashes} unique / ${stats.n} valid; chars min=${stats.min} max=${stats.max} range=${stats.range} (${stats.spreadPct.toFixed(2)}% spread)`);
  } else {
    console.log(`  → no valid responses`);
  }
  return { results, stats };
}

async function main() {
  const opts = parseArgs(process.argv);
  const { baseUrl, apiKey } = loadSecrets();
  const message = process.env.PROBE_PROMPT || DEFAULT_PROMPT;

  console.log('=== Router determinism probe ===');
  console.log(`Assistant: ${opts.assistantId}`);
  console.log(`baseUrl:   ${baseUrl}`);
  console.log(`Prompt (${message.length} chars):`);
  console.log(message.split('\n').map(l => `  | ${l}`).join('\n'));

  const baseArgs = { assistantId: opts.assistantId, message, baseUrl, apiKey };

  const baseline = await runPhase('baseline', N_RUNS, { ...baseArgs, useDeterminism: false });
  const deterministic = await runPhase('deterministic', N_RUNS, { ...baseArgs, useDeterminism: true });

  console.log('\n=== VERDICT ===');
  if (!baseline.stats || !deterministic.stats) {
    console.log(`INVALID — one or both phases had zero valid responses.`);
    return;
  }

  const bSpread = baseline.stats.spreadPct;
  const dSpread = deterministic.stats.spreadPct;
  console.log(`  baseline:      ${baseline.stats.uniqueHashes} unique, range ${baseline.stats.range} chars (${bSpread.toFixed(2)}% spread)`);
  console.log(`  deterministic: ${deterministic.stats.uniqueHashes} unique, range ${deterministic.stats.range} chars (${dSpread.toFixed(2)}% spread)`);

  // Both phases share the same assistant.temperature, so when MGA ignores
  // body params they'll show the same magnitude. When body params are
  // honored, the deterministic phase collapses to near-zero spread.
  if (dSpread < 1) {
    if (bSpread > 5) {
      console.log(`  → BODY PARAMS HONORED. Deterministic phase is effectively deterministic (<1% spread), baseline isn't.`);
    } else {
      console.log(`  → Both phases low-variance. Insufficient signal to distinguish — try a higher-variance prompt or test at higher temperature.`);
    }
  } else if (Math.abs(bSpread - dSpread) < 2) {
    console.log(`  → BODY PARAMS IGNORED (or insignificant). Both phases have similar variance magnitude — MGA isn't honoring body sampling overrides when assistant_id is set.`);
    console.log(`     Floor variance comes from the stored assistant config or from the underlying inference layer.`);
  } else {
    console.log(`  → MIXED. Phases differ but neither is deterministic. baseline ${bSpread.toFixed(1)}% vs deterministic ${dSpread.toFixed(1)}% — investigate.`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
