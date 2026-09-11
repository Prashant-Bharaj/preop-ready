#!/usr/bin/env node
/**
 * Bootstrap / verify the harness MGA assistants (orchestrator + 5 subagents
 * + reconciler-judge + prompt-writer).
 *
 * MAINTAINER-ONLY TOOL. End users of the template never run this — they
 * consume the harness with IDs already present in chat/server/config/assistants.json.
 * To be stripped from `master` before template distribution.
 *
 * Sources:
 *   - credentials (apiKey, baseUrl)        — .chat/secrets.json (per-codespace)
 *   - assistant IDs (read + write target)  — chat/server/config/assistants.json (tracked)
 *
 * Modes:
 *   node chat/scripts/create-orchestrator-assistants.js
 *     → DEFAULT = --check. Reads chat/server/config/assistants.json, GETs each
 *       /assistants/<id> from MGA, reports healthy/missing per key. No writes.
 *
 *   node chat/scripts/create-orchestrator-assistants.js --admin
 *     → CREATE mode. For each entry missing in chat/server/config/assistants.json,
 *       POST /assistants on MGA, write the returned ID back to the tracked
 *       config. Then run `npm run prompt:upload -- --all` to PATCH prompt
 *       content. Requires deliberate intent (the --admin flag); guards
 *       against accidental creates from a non-maintainer codespace.
 *
 *   node chat/scripts/create-orchestrator-assistants.js --admin --dry-run
 *     → Same as --admin but no creates / no upload.
 *
 * Idempotent: --admin skips creation for any key already present in config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_PATH = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
const ASSISTANTS_CONFIG_PATH = path.join(SPIKE_ROOT, 'chat', 'server', 'config', 'assistants.json');

// 1x1 transparent PNG (67 bytes) - placeholder logo. MGA requires a logo on
// create; this is small + valid. Maintainer can replace via UI later.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64'
);

// Harness assistants — phase agents + specialists. The legacy LLM
// orchestrator was retired in favour of a deterministic build-dispatcher
// (chat/server/agent/coordinator/build-dispatcher.js), so this script
// no longer provisions a BD Orchestrator assistant.
//
// Models: prompt-writer + router on Opus (decision-making / creative
// writing). Phase agents + reconciler-judge + coder + summarizer on
// Sonnet (narrow tasks). The maintainer can adjust via MGA UI later —
// these are starting points.
const ASSISTANTS = [
  {
    key: 'subagent-database',
    configKey: 'subagentDatabaseAssistantId',
    name: 'BD Subagent - Database',
    description: 'Phase agent for the database scope. Writes init.sql + Dockerfile from per-scope rules. Narrow scope; no cross-scope orchestration.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'subagent-backend',
    configKey: 'subagentBackendAssistantId',
    name: 'BD Subagent - Backend',
    description: 'Phase agent for the backend scope (Express or FastAPI). Port 3000 + no /api/ prefix conventions baked into the prompt.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'subagent-frontend',
    configKey: 'subagentFrontendAssistantId',
    name: 'BD Subagent - Frontend',
    description: 'Phase agent for the frontend scope (React + Vite). nginx port 8080 + /api/X cross-scope contract baked in.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'subagent-vectordb',
    configKey: 'subagentVectordbAssistantId',
    name: 'BD Subagent - VectorDB',
    description: 'Phase agent for the vectordb scope (pgvector preferred, ChromaDB/Qdrant alternatives). Embedding column conventions baked in.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'subagent-integration',
    configKey: 'subagentIntegrationAssistantId',
    name: 'BD Subagent - Integration',
    description: 'Phase agent for the integration scope. Wires services in docker-compose.yml + nginx.local.conf with depends_on/healthcheck conventions.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'investigator',
    configKey: 'investigatorAssistantId',
    name: 'BD Investigator',
    description: 'Read-only diagnostic agent: triggered on action=diagnose, emits structured root-cause report; never mutates workspace.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'reconciler-judge',
    configKey: 'reconcilerJudgeAssistantId',
    name: 'BD Reconciler-Judge',
    description: 'Classifies ambiguous extras the deterministic cross-scope reconciler can\'t resolve (renames, conventional routes, fabricated paths). Single-shot LLM-judge; returns legitimate / noise / mismatch:<reason>.',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'prompt-writer',
    configKey: 'promptWriterAssistantId',
    name: 'BD Prompt-Writer',
    description: 'Writes system prompts for user-app MGA assistants based on intent + tool list + router contracts. Called during /confirm pre-stage to fill in the instructions field before POST /assistants.',
    model: 'claude-opus-4.7',
    reasoning_effort: 'medium',
  },
  // The legacy `router` (BD Task Router) entry was removed when
  // chat/prompts/router.md retired (Phase B sub-segment 3c). The MGA
  // assistant id still lives in assistants.json:routerAssistantId but
  // there's no prompt to provision, and the two-agent planner
  // (understanding-agent + contract-agent below) is the production path.
  {
    key: 'summarizer',
    configKey: 'summarizerAssistantId',
    name: 'BD Summarizer',
    description: 'Produces 9-section conversation-state summaries for compaction / rotation. Stateless one-shot calls, hidden from MGA UI. Two-block response: <analysis> (discarded) + <summary> (extracted).',
    model: 'claude-sonnet-4.5',
    reasoning_effort: 'low',
  },
  {
    key: 'understanding-agent',
    configKey: 'understandingAssistantId',
    name: 'BD Understanding Agent',
    description: 'Stage 1 of the two-agent planner. Multi-turn clarify loop with the user: disambiguates the core product type, surfaces relevant platform capabilities, and captures custom features. Emits a structured brief consumed by the contract-agent. Replaces the legacy BD Task Router for the discovery half of planning.',
    model: 'claude-opus-4.7',
    reasoning_effort: 'low',
  },
  {
    key: 'contract-agent',
    configKey: 'contractAssistantId',
    name: 'BD Contract Agent',
    description: 'Stage 2 of the two-agent planner. Receives a brief from the understanding-agent and emits the full technical contract (tasks, data_model, api_contract, ui_contract, business_logic_contract, mga_assistants). Three modes: FRESH, ITERATE, RETRY. Never asks questions. Replaces the legacy BD Task Router for the contract-emission half of planning.',
    model: 'claude-opus-4.7',
    reasoning_effort: 'low',
  },
];

function loadSecrets() {
  if (!fs.existsSync(SECRETS_PATH)) {
    throw new Error(`secrets.json not found at ${SECRETS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
}

function loadAssistantsConfig() {
  if (!fs.existsSync(ASSISTANTS_CONFIG_PATH)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(ASSISTANTS_CONFIG_PATH, 'utf-8'));
}

function saveAssistantsConfig(config) {
  fs.mkdirSync(path.dirname(ASSISTANTS_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(ASSISTANTS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

async function createAssistant(secrets, cfg) {
  const url = secrets.baseUrl.replace(/\/$/, '') + '/assistants';
  const fd = new FormData();
  fd.append('name', cfg.name);
  fd.append('description', cfg.description);
  fd.append('model', cfg.model);
  fd.append('access', 'private');
  fd.append('reasoning_effort', cfg.reasoning_effort || 'low');
  fd.append('instructions', `(placeholder - pending upload from chat/prompts/${cfg.key}.md)`);
  fd.append('assistant_logo', new Blob([PLACEHOLDER_PNG], { type: 'image/png' }), 'logo.png');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secrets.apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST /assistants failed: HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  return data.id;
}

async function checkAssistant(secrets, id) {
  const url = secrets.baseUrl.replace(/\/$/, '') + `/assistants/${id}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${secrets.apiKey}` },
  });
  return res.ok;
}

function runUploadAll() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['run', 'prompt:upload', '--', '--all'], {
      cwd: path.join(SPIKE_ROOT, 'chat'),
      stdio: 'inherit',
    });
    proc.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`prompt:upload exited ${code}`));
    });
  });
}

async function runCheck(secrets, config) {
  console.log('[check] verifying each harness assistant exists on MGA...');
  let healthy = 0;
  let missing = 0;
  let unreachable = 0;
  for (const cfg of ASSISTANTS) {
    const id = config[cfg.configKey];
    if (!id) {
      console.log(`[check] ${cfg.key.padEnd(22)} MISSING (no id in chat/server/config/assistants.json)`);
      missing++;
      continue;
    }
    try {
      const ok = await checkAssistant(secrets, id);
      if (ok) {
        console.log(`[check] ${cfg.key.padEnd(22)} OK     (${id})`);
        healthy++;
      } else {
        console.log(`[check] ${cfg.key.padEnd(22)} 404    (${id} not found on MGA)`);
        unreachable++;
      }
    } catch (err) {
      console.log(`[check] ${cfg.key.padEnd(22)} ERR    (${err.message})`);
      unreachable++;
    }
  }
  console.log(`[check] healthy=${healthy} missing=${missing} unreachable=${unreachable}`);
  if (missing > 0 || unreachable > 0) {
    console.log('[check] re-run with --admin to create missing assistants');
    process.exit(1);
  }
}

async function runAdmin(secrets, config, dryRun) {
  console.log(`[admin] mode=${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  let createdCount = 0;
  let skippedCount = 0;

  for (const cfg of ASSISTANTS) {
    const existing = config[cfg.configKey];
    if (existing) {
      console.log(`[admin] ${cfg.key.padEnd(22)} SKIP (already in config: ${existing})`);
      skippedCount++;
      continue;
    }

    if (dryRun) {
      console.log(`[admin] ${cfg.key.padEnd(22)} DRY-RUN would create (${cfg.model}, ${cfg.reasoning_effort})`);
      continue;
    }

    process.stdout.write(`[admin] ${cfg.key.padEnd(22)} creating (${cfg.model})... `);
    try {
      const id = await createAssistant(secrets, cfg);
      config[cfg.configKey] = id;
      saveAssistantsConfig(config);
      console.log(`id=${id}`);
      createdCount++;
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      throw err;
    }
  }

  console.log(`[admin] created ${createdCount} new assistants, skipped ${skippedCount} existing`);

  if (dryRun) {
    console.log('[admin] DRY-RUN complete; no assistants created, no upload run');
    return;
  }

  if (createdCount === 0) {
    console.log('[admin] no new assistants created - running prompt:upload --all anyway to refresh content');
  } else {
    console.log('[admin] don\'t forget to commit the updated chat/server/config/assistants.json');
  }

  console.log('[admin] running npm run prompt:upload -- --all to PATCH prompt content');
  await runUploadAll();
  console.log('[admin] DONE');
}

async function main() {
  const args = process.argv.slice(2);
  const isAdmin = args.includes('--admin');
  const isDryRun = args.includes('--dry-run');

  const secrets = loadSecrets();
  const config = loadAssistantsConfig();

  console.log(`[bootstrap] base=${secrets.baseUrl}`);
  console.log(`[bootstrap] config=${ASSISTANTS_CONFIG_PATH}`);

  if (isAdmin) {
    await runAdmin(secrets, config, isDryRun);
  } else {
    await runCheck(secrets, config);
  }
}

main().catch(err => {
  console.error('[bootstrap] FATAL:', err.message);
  process.exit(1);
});
