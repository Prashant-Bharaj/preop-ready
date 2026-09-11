#!/usr/bin/env node
/**
 * Upload an MGA assistant's system prompt from its canonical source file.
 *
 * MAINTAINER-ONLY TOOL. End users of the template never run this — they
 * consume the harness with the prompts already pushed to MGA. To be
 * stripped from `master` before template distribution.
 *
 * Replaces the manual paste-into-admin-UI step. Reads the prompt source
 * file, strips the human-only preamble (everything before the first `---`
 * marker, or the closing `---` of YAML frontmatter), then PATCHes the
 * MGA assistant's `instructions` field via /api/v2/assistants/{id}.
 *
 * Usage:
 *   node chat/scripts/upload-assistant-prompt.js --assistant=coder
 *   node chat/scripts/upload-assistant-prompt.js --assistant=router --dry-run
 *   node chat/scripts/upload-assistant-prompt.js --all
 *
 * Credentials come from .chat/secrets.json (per-codespace). Assistant IDs:
 *   - harness agents (orchestrator, subagents, reconciler-judge, prompt-writer)
 *     resolve from chat/server/config/assistants.json (tracked, shared).
 *   - legacy entries (router/coder/summarizer/judge) still resolve from
 *     .chat/secrets.json.
 *   - env vars (e.g. ORCHESTRATOR_ASSISTANT_ID) override either source.
 *
 * Verifies the upload by checking that the returned `instructions` length
 * matches what we sent — if MGA silently drops the field or rejects the
 * format, the script fails loud rather than reporting fake success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANTS, DEFAULT_TEMPERATURE } from '../server/agent/prompts/manifest.js';
import { composeAssistantPrompt } from '../server/agent/prompts/disk-prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// chat/scripts/upload-assistant-prompt.js → spike root is 2 levels up
const SPIKE_ROOT = path.resolve(__dirname, '..', '..');

// The per-assistant manifest + composition recipe live in
// chat/server/agent/prompts/manifest.js + disk-prompt.js so the runtime
// (chat/server/agent/agent.js, etc.) composes the SAME bytes that this
// script PATCHes to MGA. Edit manifest.js to add or change an assistant
// entry; the previous in-file definitions were moved there verbatim.



function loadSecrets() {
  const secretsPath = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`secrets.json not found at ${secretsPath}; cannot upload`);
  }
  const data = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL || data.baseUrl;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || data.apiKey;
  if (!baseUrl || !apiKey) throw new Error('No baseUrl or apiKey resolved');
  return { ...data, baseUrl, apiKey };
}

function loadHarnessConfig() {
  const cfgPath = path.join(SPIKE_ROOT, 'chat', 'server', 'config', 'assistants.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`chat/server/config/assistants.json not found at ${cfgPath}`);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
}

function resolveAssistantId(cfg) {
  if (process.env[cfg.envKey]) return process.env[cfg.envKey];
  if (cfg.source === 'config') {
    const ids = loadHarnessConfig();
    return ids[cfg.configKey] || null;
  }
  // 'secrets' (legacy entries: router/coder/summarizer/judge)
  const secrets = loadSecrets();
  return secrets[cfg.secretsKey] || null;
}

async function uploadOne(name, opts) {
  const cfg = ASSISTANTS[name];
  if (!cfg) throw new Error(`Unknown assistant: ${name}. Valid: ${Object.keys(ASSISTANTS).join(', ')}`);

  const secrets = loadSecrets();
  const assistantId = resolveAssistantId(cfg);
  if (!assistantId) {
    const sourceHint = cfg.source === 'config'
      ? `chat/server/config/assistants.json:${cfg.configKey}`
      : `.chat/secrets.json:${cfg.secretsKey}`;
    throw new Error(`No assistant ID for "${name}" — set ${cfg.envKey} or ${sourceHint}`);
  }

  // Composition delegated to the shared composer so this script + the
  // /chat/completions runtime produce byte-identical instructions for
  // each assistant. The composer reads cfg.base / inlineRules /
  // inlineCanonicalSnippet / inlinePlatformConstraints from the manifest
  // entry and assembles the exact text MGA gets PATCHed with.
  const newInstructions = composeAssistantPrompt(name);
  const composeNote = cfg.base || cfg.inlineRules?.length
    || cfg.inlineCanonicalSnippet || cfg.inlinePlatformConstraints
    ? ' (composed)'
    : '';

  const url = `${secrets.baseUrl.replace(/\/$/, '')}/assistants/${assistantId}`;
  // Sampling config reasserted on every upload so values can't drift via
  // MGA UI edits or platform defaults. Temperature defaults to 0 — every
  // assistant here emits structured output (JSON / code / scores) where
  // deterministic sampling is correct. Override per-entry only when an
  // assistant genuinely needs sampling diversity.
  const extraFields = {
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : DEFAULT_TEMPERATURE,
  };
  const extraSummary = Object.keys(extraFields).length
    ? ` + ${Object.entries(extraFields).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : '';
  console.log(`[upload] ${name.padEnd(20)} ← ${cfg.src} (${newInstructions.length} chars${composeNote}${extraSummary}) → ${assistantId}`);

  if (opts.dryRun) {
    const preview = newInstructions.slice(0, 200).replace(/\n/g, ' ');
    console.log(`[upload]            DRY-RUN — would PATCH ${url}`);
    console.log(`[upload]            preview: "${preview}…"`);
    return { ok: true, dryRun: true };
  }

  // Per MGA's Swagger UI for PATCH /assistants/{id}: the request body is
  // multipart/form-data with FLAT field names (not JSON, not wrapped under
  // `assistant_patch`). Sending JSON returns 200 + bumps modification_date
  // but silently no-ops — the multipart parser finds no fields and skips
  // the update. (Observed 2026-05-02; the prior JSON+assistant_patch shape
  // worked on a more permissive parser earlier in 2026-04.)
  const fd = new FormData();
  fd.append('instructions', newInstructions);
  for (const [k, v] of Object.entries(extraFields)) {
    fd.append(k, String(v));
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${secrets.apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable>');
    throw new Error(`PATCH ${url} failed: HTTP ${res.status} ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  // Verify the patch actually landed. Length comparison alone isn't reliable
  // because MGA normalizes line endings (CRLF/LF) and may trim trailing
  // whitespace, producing benign drift. Better signal: take a unique
  // fingerprint from late in the sent content and confirm it's present in
  // the returned `instructions`. If MGA silently dropped the update, the
  // fingerprint will be absent and we fail loud.
  const returnedInstructions = (data.instructions || '');
  const sentLen = newInstructions.length;
  const returnedLen = returnedInstructions.length;
  const drift = returnedLen - sentLen;

  // Fingerprint: take the LAST 120 non-whitespace-collapsed chars of what
  // we sent (last is more discriminating than first since prompts usually
  // share boilerplate openings; collapsing whitespace makes the check
  // robust to line-ending normalization).
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  const sentCollapsed = collapse(newInstructions);
  const returnedCollapsed = collapse(returnedInstructions);
  const fingerprint = sentCollapsed.slice(-120);
  if (!returnedCollapsed.includes(fingerprint)) {
    throw new Error(
      `${name}: PATCH returned 200 but the saved instructions don't contain the new content's tail fingerprint. ` +
      `MGA likely silently dropped the field. ` +
      `Sent ${sentLen} chars, returned ${returnedLen} (drift ${drift}). ` +
      `Tail fingerprint not found: "${fingerprint.slice(0, 80)}…"`
    );
  }

  // Verify each extra field landed too. MGA silently no-ops on unknown
  // fields, so this catches future schema drift loudly.
  for (const [k, sent] of Object.entries(extraFields)) {
    const got = data[k];
    if (String(got) !== String(sent)) {
      throw new Error(
        `${name}: PATCH returned 200 but ${k} did NOT update. ` +
        `Sent: ${sent}, got back: ${got}. ` +
        `MGA may have silently dropped the field.`
      );
    }
  }
  const extraSummaryOk = Object.keys(extraFields).length
    ? `, ${Object.entries(extraFields).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : '';
  console.log(`[upload]            OK — modification_date=${data.modification_date}, returned ${returnedLen} chars (drift ${drift >= 0 ? '+' : ''}${drift}, fingerprint matched${extraSummaryOk})`);
  return { ok: true, assistantId, sentLen, returnedLen };
}

function parseArgs(argv) {
  const opts = { dryRun: false, all: false, only: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--all') opts.all = true;
    else if (arg.startsWith('--assistant=')) opts.only = arg.slice('--assistant='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node upload-assistant-prompt.js --assistant=<router|coder|summarizer> [--dry-run]');
      console.log('   or: node upload-assistant-prompt.js --all [--dry-run]');
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const targets = opts.all ? Object.keys(ASSISTANTS) : (opts.only ? [opts.only] : null);
  if (!targets) {
    console.error('Specify --assistant=<name> or --all. Use --help for usage.');
    process.exit(1);
  }

  let failures = 0;
  for (const t of targets) {
    try {
      await uploadOne(t, opts);
    } catch (err) {
      console.error(`[upload] FAIL ${t}: ${err.message}`);
      failures += 1;
    }
  }
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[upload] fatal:', err.stack || err.message);
  process.exit(2);
});
