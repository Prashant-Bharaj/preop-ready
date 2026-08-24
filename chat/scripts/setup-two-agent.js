#!/usr/bin/env node
/**
 * Configure both test MGA assistants for the two-agent experiment:
 *   - Understanding Agent (PlannerAssistant)
 *   - Contract Agent
 *
 * For each:
 *   1. PATCH model=claude-opus-4.7, reasoning_effort=low, temperature=0
 *   2. PATCH `instructions` to the matching prompt file (frontmatter stripped)
 *   3. GET to verify
 *
 * Standalone — reads MGA secrets from the spike's .chat/secrets.json by absolute path.
 *
 * Usage:
 *   node /Users/alen/www/bayer/deployment/planner-experiment/two-agent/setup-two-agent.js
 */
import fs from 'node:fs';
import path from 'node:path';

// Now living in chat/scripts/ of the spike repo. Resolve SPIKE_ROOT two
// levels up so the script is portable across checkouts/branches.
const SPIKE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROMPTS_DIR = path.join(SPIKE_ROOT, 'chat', 'prompts');

// Test assistants (user-created via MGA UI for the planner-foundation
// experiment). These are test/sandbox IDs — Phase A provisioning will
// create production-side equivalents.
const ASSISTANTS = [
  {
    label: 'understanding-agent',
    id: '7c374394-b242-4c52-8e6a-7693f5328ac2',
    promptFile: 'understanding-agent.md',
  },
  {
    label: 'contract-agent',
    id: '232a5fbd-510b-4ca2-97ed-0bf6da2bfcb6',
    promptFile: 'contract-agent.md',
  },
];

const TARGET_MODEL = 'claude-opus-4.7';
const TARGET_REASONING = 'low';
const TARGET_TEMPERATURE = 0;

function loadSecrets() {
  const secretsPath = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  if (!fs.existsSync(secretsPath)) throw new Error(`secrets.json not found at ${secretsPath}`);
  const data = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL || data.baseUrl;
  const apiKey = process.env.OPENAI_COMPAT_API_KEY || data.apiKey;
  if (!baseUrl || !apiKey) throw new Error('No baseUrl or apiKey resolved');
  return { baseUrl, apiKey };
}

function stripPreamble(text) {
  const lines = text.split('\n');
  if (lines.length === 0) return text;
  let firstContentLine = 0;
  while (firstContentLine < lines.length && lines[firstContentLine].trim() === '') firstContentLine++;
  if (firstContentLine < lines.length && lines[firstContentLine].trim() === '---') {
    for (let i = firstContentLine + 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return lines.slice(i + 1).join('\n').replace(/^\n+/, '').trimEnd() + '\n';
      }
    }
    return text;
  }
  return text;
}

async function getAssistant({ assistantId, baseUrl, apiKey }) {
  const url = `${baseUrl.replace(/\/$/, '')}/assistants/${assistantId}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function patchAssistant({ assistantId, fields, baseUrl, apiKey }) {
  const url = `${baseUrl.replace(/\/$/, '')}/assistants/${assistantId}`;
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

function logAssistant(label, asst) {
  console.log(`[${label}] id=${asst.id}`);
  console.log(`  name:             ${asst.name}`);
  console.log(`  temperature:      ${asst.temperature}`);
  console.log(`  model.id:         ${asst.model?.id || asst.model}`);
  console.log(`  reasoning_effort: ${asst.reasoning_effort}`);
  console.log(`  instructions:     ${(asst.instructions || '').length} chars`);
  console.log(`  modification_date: ${asst.modification_date}`);
}

async function setupOne({ label, id, promptFile, baseUrl, apiKey }) {
  const promptPath = path.join(PROMPTS_DIR, promptFile);
  if (!fs.existsSync(promptPath)) throw new Error(`Prompt file not found: ${promptPath}`);
  const promptContent = stripPreamble(fs.readFileSync(promptPath, 'utf-8'));

  console.log(`\n=== Setting up ${label} (${id}) ===`);
  console.log(`Source: ${promptPath} (${promptContent.length} chars after stripping frontmatter)`);

  const before = await getAssistant({ assistantId: id, baseUrl, apiKey });
  logAssistant('BEFORE', before);

  const fields = {
    model: TARGET_MODEL,
    reasoning_effort: TARGET_REASONING,
    temperature: TARGET_TEMPERATURE,
    instructions: promptContent,
  };
  console.log(`\nPatching: model=${TARGET_MODEL}, reasoning_effort=${TARGET_REASONING}, temperature=${TARGET_TEMPERATURE}, instructions=${promptContent.length} chars`);
  await patchAssistant({ assistantId: id, fields, baseUrl, apiKey });

  const after = await getAssistant({ assistantId: id, baseUrl, apiKey });
  console.log('');
  logAssistant('AFTER', after);

  // Verify each field
  let allOk = true;
  const checks = [
    ['model', TARGET_MODEL, after.model?.id || after.model],
    ['reasoning_effort', TARGET_REASONING, after.reasoning_effort],
    ['temperature', String(TARGET_TEMPERATURE), String(after.temperature)],
  ];
  for (const [field, sent, got] of checks) {
    if (String(sent) !== String(got)) {
      allOk = false;
      console.log(`  WARN — ${field}: sent ${sent}, got ${got}`);
    }
  }
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  const sentTail = collapse(promptContent).slice(-120);
  const returnedTail = collapse(after.instructions || '');
  if (!returnedTail.includes(sentTail)) {
    allOk = false;
    console.log(`  WARN — instructions fingerprint not found in returned content`);
    console.log(`         tail: "${sentTail.slice(0, 80)}..."`);
  }
  if (!allOk) throw new Error(`${label} setup failed verification`);
  console.log(`  OK — ${label} ready`);
  return after;
}

async function main() {
  const { baseUrl, apiKey } = loadSecrets();
  console.log('=== Two-agent setup ===');
  console.log(`baseUrl: ${baseUrl}`);
  console.log(`Prompts dir:     ${PROMPTS_DIR}`);

  for (const asst of ASSISTANTS) {
    await setupOne({ ...asst, baseUrl, apiKey });
  }

  console.log('\n\n=== ALL DONE ===');
  console.log('Test assistants configured:');
  for (const a of ASSISTANTS) {
    console.log(`  ${a.label.padEnd(22)} → ${a.id}`);
  }
  console.log('\nNext: run probe-two-agent.js to exercise the flow end-to-end.');
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});