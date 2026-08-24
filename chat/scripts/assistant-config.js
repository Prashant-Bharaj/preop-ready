#!/usr/bin/env node
/**
 * GET or PATCH non-instructions config on an MGA assistant.
 *
 * Companion to upload-assistant-prompt.js. That script owns the `instructions`
 * field; this one is for other top-level fields stored on the assistant
 * (currently: temperature). Same auth + multipart pattern.
 *
 * Usage:
 *   # GET — show current config for one assistant
 *   node chat/scripts/assistant-config.js <assistantId>
 *
 *   # PATCH temperature
 *   node chat/scripts/assistant-config.js <assistantId> --temperature=<value>
 *
 *   # Convenience: by name (resolved against chat/server/config/assistants.json)
 *   node chat/scripts/assistant-config.js --name=router
 *   node chat/scripts/assistant-config.js --name=router --temperature=0
 *
 * Names map to keys in assistants.json (strip the trailing "AssistantId"):
 *   router, orchestrator, subagentDatabase, subagentBackend, subagentFrontend,
 *   subagentVectordb, subagentIntegration, investigator, reconcilerJudge,
 *   promptWriter, coder, summarizer.
 */
import fs from 'node:fs';
import path from 'node:path';

const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');

function parseArgs(argv) {
  const opts = { assistantId: null, name: null, temperature: null, model: null, reasoningEffort: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--temperature=')) {
      const v = arg.slice('--temperature='.length);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        throw new Error(`--temperature must be a number in [0, 2]; got ${v}`);
      }
      opts.temperature = n;
    } else if (arg.startsWith('--model=')) {
      opts.model = arg.slice('--model='.length);
    } else if (arg.startsWith('--reasoning-effort=')) {
      opts.reasoningEffort = arg.slice('--reasoning-effort='.length);
    } else if (arg.startsWith('--name=')) {
      opts.name = arg.slice('--name='.length);
    } else if (!arg.startsWith('--')) {
      opts.assistantId = arg;
    }
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

function loadAssistantsConfig() {
  const p = path.join(SPIKE_ROOT, 'chat', 'server', 'config', 'assistants.json');
  if (!fs.existsSync(p)) throw new Error(`assistants.json not found at ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function resolveByName(name, cfg) {
  const key = `${name}AssistantId`;
  if (!cfg[key]) {
    const known = Object.keys(cfg).map(k => k.replace(/AssistantId$/, '')).join(', ');
    throw new Error(`No assistant named "${name}" in assistants.json. Known: ${known}`);
  }
  return cfg[key];
}

async function getAssistant({ assistantId, baseUrl, apiKey }) {
  const url = `${baseUrl.replace(/\/$/, '')}/assistants/${assistantId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function patchFields({ assistantId, fields, baseUrl, apiKey }) {
  const url = `${baseUrl.replace(/\/$/, '')}/assistants/${assistantId}`;
  // Multipart/form-data with flat field names — same pattern as
  // upload-assistant-prompt.js (JSON silently no-ops per that file's comment).
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    fd.append(k, String(v));
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PATCH ${url} failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function summarize(label, asst) {
  const fields = ['name', 'temperature', 'model', 'reasoning_effort', 'modification_date', 'access'];
  console.log(`[${label}] id=${asst.id || asst.assistant_id || '?'}`);
  for (const f of fields) {
    if (asst[f] !== undefined) console.log(`  ${f}: ${typeof asst[f] === 'object' ? JSON.stringify(asst[f]) : asst[f]}`);
  }
  // model is sometimes nested
  if (asst.model && typeof asst.model === 'object' && asst.model.id) {
    console.log(`  model.id: ${asst.model.id}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  let assistantId = opts.assistantId;
  if (!assistantId && opts.name) {
    assistantId = resolveByName(opts.name, loadAssistantsConfig());
  }
  if (!assistantId) {
    throw new Error('Need <assistantId> positional arg or --name=<name>. See -h.');
  }

  const { baseUrl, apiKey } = loadSecrets();

  // Always GET first to show current state.
  console.log(`baseUrl: ${baseUrl}`);
  console.log(`assistant: ${assistantId}${opts.name ? ` (${opts.name})` : ''}`);
  console.log('');

  const before = await getAssistant({ assistantId, baseUrl, apiKey });
  summarize('BEFORE', before);

  const fields = {};
  if (opts.temperature !== null) fields.temperature = opts.temperature;
  if (opts.model !== null) fields.model = opts.model;
  if (opts.reasoningEffort !== null) fields.reasoning_effort = opts.reasoningEffort;
  if (Object.keys(fields).length === 0) {
    // GET-only mode.
    return;
  }

  console.log('');
  console.log(`Patching: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  await patchFields({ assistantId, fields, baseUrl, apiKey });

  // Re-GET to verify the patch landed.
  const after = await getAssistant({ assistantId, baseUrl, apiKey });
  console.log('');
  summarize('AFTER', after);

  // Verify each field
  let allOk = true;
  for (const [k, sent] of Object.entries(fields)) {
    let got;
    if (k === 'model') {
      got = after.model?.id || after.model;
    } else {
      got = after[k];
    }
    const match = String(got) === String(sent);
    if (!match) {
      allOk = false;
      console.log(`WARN — ${k} did NOT update. Sent: ${sent}, got back: ${got}`);
    }
  }
  console.log('');
  if (allOk) {
    console.log(`OK — all fields updated`);
  } else {
    console.log(`Some fields silently dropped — MGA may not accept those via multipart PATCH`);
    process.exit(2);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
