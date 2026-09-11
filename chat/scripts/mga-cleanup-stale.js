#!/usr/bin/env node
/**
 * Manual orphan sweep for harness-created MGA assistants.
 *
 * Lists assistants whose name contains the `[harness:<sessionId>]` tag the
 * /confirm flow stamps on every per-app assistant it creates. Cross-references
 * with the local session index to determine which sessions still exist;
 * anything tagged with a session ID NOT in the index is an orphan and a
 * candidate for deletion.
 *
 * Usage:
 *   node chat/scripts/mga-cleanup-stale.js          # dry-run (default)
 *   node chat/scripts/mga-cleanup-stale.js --apply  # actually delete
 *
 * Why exists: the in-memory cleanup hooks in session/lifecycle.js fire only when the
 * active session is being killed/deleted. Sessions deleted while inactive,
 * server crashes, or rare race conditions can leave assistants behind. Run
 * this script periodically (or after a smoke-gate cycle) to keep the MGA
 * UI tidy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listHarnessAssistants, deleteAssistant } from '../server/agent/llm/mga-assistant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPIKE_ROOT = path.resolve(__dirname, '..', '..');
const SECRETS_PATH = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
const SESSION_INDEX_PATH = path.join(SPIKE_ROOT, 'chat', 'chat-data', 'sessions.json');

function loadSecrets() {
  return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
}

function loadActiveSessionIds() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_INDEX_PATH, 'utf-8'));
    const items = Array.isArray(raw) ? raw : (raw.sessions || []);
    return new Set(items.map(s => s.id).filter(Boolean));
  } catch (err) {
    console.warn('[mga-cleanup] could not read session index (%s) — treating ALL harness assistants as orphans', err.message);
    return new Set();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const secrets = loadSecrets();
  const liveSessions = loadActiveSessionIds();

  console.log(`[mga-cleanup] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[mga-cleanup] base=${secrets.baseUrl}`);
  console.log(`[mga-cleanup] live sessions in index: ${liveSessions.size}`);

  const orphans = await listHarnessAssistants(secrets);
  console.log(`[mga-cleanup] harness-tagged assistants: ${orphans.length}`);

  const toDelete = orphans.filter(o => !liveSessions.has(o.sessionId));
  console.log(`[mga-cleanup] orphan candidates (session not in index): ${toDelete.length}`);

  for (const o of toDelete) {
    console.log(`  - ${o.id}  ${o.name}`);
    if (apply) {
      try {
        await deleteAssistant(o.id, secrets);
        console.log(`    deleted`);
      } catch (err) {
        console.log(`    FAILED: ${err.message}`);
      }
    }
  }

  if (!apply && toDelete.length > 0) {
    console.log('\n[mga-cleanup] dry-run only. Re-run with --apply to delete.');
  }
}

main().catch(err => {
  console.error('[mga-cleanup] fatal:', err);
  process.exit(1);
});
