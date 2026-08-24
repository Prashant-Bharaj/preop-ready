#!/usr/bin/env node
/**
 * Probe: structural variance in the router's JSON output across repeated
 * identical inputs.
 *
 * Counterpoint to probe-router-determinism.js: instead of measuring
 * character-spread of the raw response (mostly prose drift), this probe
 * extracts the *structural* decisions (action, scopes, stack/dockerfile
 * choices, contract presence, table names, endpoint paths, component
 * names) and reports stability per axis.
 *
 * The hypothesis: even when char-spread is ~20%, the actual build-shaping
 * decisions may be stable. If true → 20% surface variance is acceptable;
 * the product-relevant determinism is already higher than the raw probe
 * suggests.
 *
 * Usage:
 *   node chat/scripts/probe-router-structural-variance.js
 *   PROBE_PROMPT="..." node chat/scripts/probe-router-structural-variance.js
 *   node chat/scripts/probe-router-structural-variance.js --runs=10
 *   node chat/scripts/probe-router-structural-variance.js --assistant-id=<uuid>
 */
import fs from 'node:fs';
import path from 'node:path';

const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_ASSISTANT_ID = '99e40517-7506-4e07-ae45-3a3356076ea1'; // BD Task Router
const DEFAULT_N_RUNS = 5;

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
  const opts = { assistantId: DEFAULT_ASSISTANT_ID, nRuns: DEFAULT_N_RUNS };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--assistant-id=')) opts.assistantId = arg.slice('--assistant-id='.length);
    else if (arg.startsWith('--runs=')) opts.nRuns = Number(arg.slice('--runs='.length));
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

// Robust JSON extraction — handles ```json fences and prose-wrapped JSON.
function tryParseJSON(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // Brace-balance extraction
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

async function callRouter({ assistantId, message, baseUrl, apiKey }) {
  const body = {
    messages: [{ role: 'user', content: message }],
    assistant_id: assistantId,
    stream: false,
    hidden: true,
    tool_keys: [],
  };
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Outer response not JSON: ${text.slice(0, 500)}`); }
}

/**
 * Extract a multi-level fingerprint from a parsed router JSON output.
 * Each level summarises decisions that, if they vary, change the build:
 *
 *  - CRITICAL: changes the build's identity (different scopes / stacks)
 *  - CONTRACTS: changes structured contract presence
 *  - DETAIL: changes specific names / paths inside contracts
 */
function extractFingerprint(parsed) {
  if (!parsed) return null;
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const scopes = [...new Set(tasks.map(t => t?.scope).filter(Boolean))].sort();
  const dockerfiles = tasks
    .filter(t => t?.scope)
    .map(t => `${t.scope}:${t.dockerfile || 'none'}`)
    .sort();
  const primarySnippets = tasks
    .filter(t => t?.scope && t?.primarySnippet)
    .map(t => `${t.scope}:${t.primarySnippet}`)
    .sort();
  const flags = Array.isArray(parsed.flags) ? [...parsed.flags].sort() : [];

  const dm = parsed.data_model;
  const ac = parsed.api_contract;
  const uc = parsed.ui_contract;
  const bl = parsed.business_logic_contract;

  const tableNames = Array.isArray(dm?.tables) ? dm.tables.map(t => t.name).sort() : [];
  const endpointKeys = Array.isArray(ac?.endpoints)
    ? ac.endpoints.map(e => `${e.method} ${e.path}`).sort()
    : [];
  const componentNames = Array.isArray(uc?.components)
    ? uc.components.map(c => c.name).sort()
    : [];
  const triggerEvents = Array.isArray(bl?.triggers)
    ? bl.triggers.map(t => t.event).sort()
    : [];

  return {
    // CRITICAL — if any of these vary, the build is fundamentally different
    action: parsed.action,
    scopes,
    dockerfiles,
    primarySnippets,
    flags,

    // CONTRACTS — presence/absence of structured contracts
    hasDataModel: !!dm,
    hasApiContract: !!ac,
    hasUiContract: !!uc,
    hasBusinessLogic: !!bl,
    vectorEngine: parsed.vector_engine ?? null,

    // DETAIL — names/paths inside contracts
    tableNames,
    endpointKeys,
    componentNames,
    primaryView: uc?.primary_view ?? null,
    primaryAction: uc?.primary_action ?? null,
    triggerEvents,

    // Counts for sanity
    tableCount: tableNames.length,
    endpointCount: endpointKeys.length,
    componentCount: componentNames.length,
    triggerCount: triggerEvents.length,
  };
}

function uniqueValues(values) {
  // Each value may be a primitive or an array — normalize to JSON strings
  const set = new Set();
  for (const v of values) {
    set.add(JSON.stringify(v));
  }
  return [...set];
}

function stable(values, label) {
  const u = uniqueValues(values);
  const ok = u.length === 1;
  return { label, stable: ok, uniqueCount: u.length, uniqueValues: u };
}

function reportAxis(label, fingerprints, key) {
  const values = fingerprints.map(fp => fp?.[key]);
  const result = stable(values, label);
  const marker = result.stable ? '✓' : '✗';
  const display = result.stable
    ? formatValue(JSON.parse(result.uniqueValues[0]))
    : `${result.uniqueCount} variants`;
  console.log(`  ${marker} ${label.padEnd(20)} ${display}`);
  return result;
}

function formatValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length}] ${v.join(', ').slice(0, 80)}`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

function reportVariants(label, fingerprints, key) {
  const values = fingerprints.map(fp => fp?.[key]);
  const u = uniqueValues(values);
  if (u.length === 1) return;
  console.log(`\n  ${label} (${u.length} variants observed across ${fingerprints.length} runs):`);
  for (const [i, val] of u.entries()) {
    const parsed = JSON.parse(val);
    const count = values.filter(v => JSON.stringify(v) === val).length;
    console.log(`    [${i + 1}] (×${count}) ${formatValue(parsed)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const { baseUrl, apiKey } = loadSecrets();
  const message = process.env.PROBE_PROMPT || DEFAULT_PROMPT;

  console.log('=== Router structural variance probe ===');
  console.log(`assistant:   ${opts.assistantId}`);
  console.log(`baseUrl:     ${baseUrl}`);
  console.log(`runs:        ${opts.nRuns}`);
  console.log(`prompt (${message.length} chars):`);
  console.log(message.split('\n').map(l => `  | ${l}`).join('\n'));
  console.log();

  const fingerprints = [];
  for (let i = 1; i <= opts.nRuns; i++) {
    const t0 = Date.now();
    try {
      const response = await callRouter({ ...opts, message, baseUrl, apiKey });
      const ms = Date.now() - t0;
      const content = extractContent(response);
      const parsed = tryParseJSON(content);
      fs.writeFileSync(`/tmp/probe-structural-${i}.json`, JSON.stringify({ response, parsed }, null, 2));
      if (!parsed) {
        console.log(`  run ${i}/${opts.nRuns}: JSON_PARSE_FAILED ms=${ms} chars=${content?.length ?? 0}`);
        fingerprints.push(null);
        continue;
      }
      const fp = extractFingerprint(parsed);
      console.log(`  run ${i}/${opts.nRuns}: action=${fp.action} scopes=[${fp.scopes.join(',')}] flags=[${fp.flags.join(',')}] ms=${ms}`);
      fingerprints.push(fp);
    } catch (err) {
      console.log(`  run ${i}/${opts.nRuns}: ERROR — ${err.message}`);
      fingerprints.push(null);
    }
  }

  const valid = fingerprints.filter(fp => fp !== null);
  if (valid.length === 0) {
    console.log('\n=== INVALID — no successful runs ===');
    return;
  }

  console.log(`\n=== STRUCTURAL FINGERPRINT (${valid.length}/${opts.nRuns} valid runs) ===\n`);

  console.log('CRITICAL — changes the build identity');
  reportAxis('action', valid, 'action');
  reportAxis('scopes', valid, 'scopes');
  reportAxis('dockerfiles', valid, 'dockerfiles');
  reportAxis('primarySnippets', valid, 'primarySnippets');
  reportAxis('flags', valid, 'flags');

  console.log('\nCONTRACTS — presence of structured contracts');
  reportAxis('hasDataModel', valid, 'hasDataModel');
  reportAxis('hasApiContract', valid, 'hasApiContract');
  reportAxis('hasUiContract', valid, 'hasUiContract');
  reportAxis('hasBusinessLogic', valid, 'hasBusinessLogic');
  reportAxis('vectorEngine', valid, 'vectorEngine');

  console.log('\nDETAIL — names/paths inside contracts');
  reportAxis('tableCount', valid, 'tableCount');
  reportAxis('tableNames', valid, 'tableNames');
  reportAxis('endpointCount', valid, 'endpointCount');
  reportAxis('endpointKeys', valid, 'endpointKeys');
  reportAxis('componentCount', valid, 'componentCount');
  reportAxis('componentNames', valid, 'componentNames');
  reportAxis('primaryView', valid, 'primaryView');
  reportAxis('primaryAction', valid, 'primaryAction');
  reportAxis('triggerCount', valid, 'triggerCount');
  reportAxis('triggerEvents', valid, 'triggerEvents');

  // Variant detail — for any axis that varies, show what the variants are.
  console.log('\n--- VARIANT DETAILS ---');
  const allAxes = ['action', 'scopes', 'dockerfiles', 'primarySnippets', 'flags',
    'hasDataModel', 'hasApiContract', 'hasUiContract', 'hasBusinessLogic', 'vectorEngine',
    'tableNames', 'endpointKeys', 'componentNames',
    'primaryView', 'primaryAction', 'triggerEvents'];
  let anyUnstable = false;
  for (const ax of allAxes) {
    const u = uniqueValues(valid.map(fp => fp?.[ax]));
    if (u.length > 1) {
      anyUnstable = true;
      reportVariants(ax, valid, ax);
    }
  }
  if (!anyUnstable) {
    console.log('  (all axes stable across runs)');
  }

  // Summary
  const criticalAxes = ['action', 'scopes', 'dockerfiles', 'primarySnippets', 'flags'];
  const criticalUnstable = criticalAxes.filter(ax =>
    uniqueValues(valid.map(fp => fp?.[ax])).length > 1
  );
  const contractAxes = ['hasDataModel', 'hasApiContract', 'hasUiContract', 'hasBusinessLogic', 'vectorEngine'];
  const contractUnstable = contractAxes.filter(ax =>
    uniqueValues(valid.map(fp => fp?.[ax])).length > 1
  );
  console.log('\n=== SUMMARY ===');
  console.log(`  Critical axes unstable: ${criticalUnstable.length}/${criticalAxes.length}${criticalUnstable.length > 0 ? ` — ${criticalUnstable.join(', ')}` : ''}`);
  console.log(`  Contract presence unstable: ${contractUnstable.length}/${contractAxes.length}${contractUnstable.length > 0 ? ` — ${contractUnstable.join(', ')}` : ''}`);
  if (criticalUnstable.length === 0 && contractUnstable.length === 0) {
    console.log('  VERDICT: Build-shaping decisions are STABLE. Surface prose varies but the same project gets built every run.');
  } else if (criticalUnstable.length === 0) {
    console.log('  VERDICT: Critical decisions stable; contract structure varies. Same scopes + stack, but different schemas per run.');
  } else {
    console.log('  VERDICT: Critical build decisions vary run-to-run. This is the actual product variance problem.');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
