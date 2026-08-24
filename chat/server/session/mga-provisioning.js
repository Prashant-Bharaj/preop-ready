/**
 * mga-provisioning.js — create MGA assistants for an app and persist the
 * credentials into the workspace `.env`.
 *
 * Extracted from the /confirm handler so ITERATE dispatches can provision
 * too: adding an AI feature to an app born without one previously produced
 * backend code calling MGA with no assistant, no MGA_* env, and no compose
 * wiring (observed live — `MGA_BASE_URL and MGA_API_KEY must be set`
 * rejections at runtime).
 *
 * Behavior preserved from the confirm path: MGA_SKIP_PRESTAGE placeholder
 * mode for smoke runs, prompt-writer-authored instructions, tool attach,
 * rollback of partially-created assistants on failure. One improvement:
 * `.env` is MERGED (existing non-MGA lines preserved, stale MGA_* lines
 * replaced) — the confirm path used to overwrite the whole file, which an
 * iterate must never do to an app with populated app-secrets.
 *
 * @returns {Promise<{ok: boolean, created: Array<{key,assistantId}>, error: string|null, skipped: boolean}>}
 */

import fs from 'node:fs';
import path from 'node:path';
import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { WORKSPACE_DIR } from '../core/paths.js';

function mergeEnvFile(envPath, mgaLines) {
  let existing = [];
  try {
    existing = fs.readFileSync(envPath, 'utf-8').split('\n')
      .filter((l) => l.trim() !== '' && !/^MGA_/.test(l.trim()));
  } catch { /* no .env yet */ }
  fs.writeFileSync(envPath, [...existing, ...mgaLines].join('\n') + '\n');
}

export async function provisionMgaAssistants(session, specs, contracts, { getCredentials }) {
  const list = Array.isArray(specs) ? specs.filter((s) => s && s.name) : [];
  if (list.length === 0) return { ok: true, created: [], error: null, skipped: true };

  const envPath = path.join(WORKSPACE_DIR, '.env');

  if (process.env.MGA_SKIP_PRESTAGE === 'true') {
    mergeEnvFile(envPath, [
      'MGA_API_KEY=skip',
      'MGA_BASE_URL=https://chat.int.bayer.com/api/v2',
      'MGA_ASSISTANT_ID=00000000-skip-skip-skip-000000000000',
    ]);
    tlog('[mga-provision] SKIPPED (MGA_SKIP_PRESTAGE=true) — %d spec(s) not created; placeholder .env written', list.length);
    session.createdMgaAssistantIds = session.createdMgaAssistantIds || [];
    return { ok: true, created: [], error: null, skipped: true };
  }

  const { createAssistant, attachTools, deleteAssistant } = await import('../agent/llm/mga-assistant.js');
  const { writeAssistantInstructions } = await import('../agent/planner/prompt-writer.js');
  const mgaCreds = getCredentials();
  const created = [];
  let fatalErr = null;

  for (const spec of list) {
    try {
      const writtenInstructions = await writeAssistantInstructions({
        spec,
        userPrompt: session.lastUserMessage || '',
        contracts,
      });
      tlog('[mga-provision] Prompt-writer wrote instructions for key=%s (%d chars)', spec.key, writtenInstructions.length);

      const id = await createAssistant({ ...spec, instructions: writtenInstructions, sessionId: session.id }, mgaCreds);
      tlog('[mga-provision] Created MGA assistant %s (key=%s)', id, spec.key);

      if (Array.isArray(spec.tool_keys) && spec.tool_keys.length) {
        const r = await attachTools(id, spec.tool_keys, mgaCreds);
        tlog('[mga-provision] Attached %d tool(s), %d failed', r.attached.length, r.failed.length);
      }
      created.push({ key: spec.key || `assistant_${created.length}`, assistantId: id });
    } catch (err) {
      logAndSwallow(err, `[mga-provision] Assistant creation FAILED for key=${spec.key}`);
      fatalErr = err;
      break;
    }
  }

  if (fatalErr || created.length !== list.length) {
    if (created.length > 0) {
      try {
        for (const c of created) {
          try { await deleteAssistant(c.assistantId, mgaCreds); } catch { /* best-effort */ }
        }
        tlog('[mga-provision] Rolled back %d partially-created assistant(s)', created.length);
      } catch { /* best-effort */ }
    }
    const error = fatalErr
      ? `MGA assistant creation failed: ${fatalErr.message}`
      : `Only ${created.length}/${list.length} assistants created — aborting`;
    return { ok: false, created: [], error, skipped: false };
  }

  const envLines = [
    `MGA_API_KEY=${mgaCreds.apiKey}`,
    `MGA_BASE_URL=${mgaCreds.baseUrl}`,
    `MGA_ASSISTANT_ID=${created[0].assistantId}`,
  ];
  for (let i = 1; i < created.length; i++) {
    const upperKey = (created[i].key || `assistant_${i}`).toUpperCase();
    envLines.push(`MGA_ASSISTANT_ID_${upperKey}=${created[i].assistantId}`);
  }
  mergeEnvFile(envPath, envLines);
  tlog('[mga-provision] Wrote %s with MGA_* vars (%d assistant(s) created)', envPath, created.length);
  session.createdMgaAssistantIds = [...(session.createdMgaAssistantIds || []), ...created.map((c) => c.assistantId)];
  return { ok: true, created, error: null, skipped: false };
}