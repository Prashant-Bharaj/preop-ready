/**
 * Track A (A3): disk-persisted history of the last successful api_contract
 * emission per workspace.
 *
 * Lives at `<workspaceDir>/docs/.api-contract-history.json`. Format:
 *
 *   { "version": 2,
 *     "savedAt": "2026-05-07T20:31:42.123Z",
 *     "apiContract": { "endpoints": [ ... ], "version": 2, "frozen_endpoints": [...] } }
 *
 * Why disk and not the in-memory stash: the stash is per-run (cleared at the
 * end of `runLlmOrchestrator`); frozen-endpoint diffing needs the prior turn's
 * contract across server restarts and across multi-turn sessions. PROJECT_STATUS.md
 * lives next to this file; same persistence model.
 *
 * Failure mode: any I/O error returns null on load (treated as "no history,
 * skip diff") and silently swallows on save (next turn re-saves fresh). The
 * frozen-endpoints check is a safety net, not load-bearing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logAndSwallow } from '../../util/log-helpers.js';

const HISTORY_FILE = path.join('docs', '.api-contract-history.json');

/**
 * Read the persisted prior contract for diffing. Returns null when no
 * history exists yet, when the file is malformed, or when an I/O error
 * occurs — any of which is "diff is a no-op for this turn."
 */
export function loadApiContractHistory(workspaceDir) {
  if (!workspaceDir) return null;
  const filePath = path.join(workspaceDir, HISTORY_FILE);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.apiContract || typeof parsed.apiContract !== 'object') return null;
    return parsed.apiContract;
  } catch (err) {
    return logAndSwallow(err, '[api-contract-history] load failed', null);
  }
}

/**
 * Persist the current emission's api_contract so the next turn can diff
 * against it. Called only after a successful router execute (post-diff
 * pass). Best-effort: errors are logged but not surfaced to the caller.
 */
export function saveApiContractHistory(workspaceDir, version, apiContract) {
  if (!workspaceDir || !apiContract) return;
  const dirPath = path.join(workspaceDir, 'docs');
  const filePath = path.join(workspaceDir, HISTORY_FILE);
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const payload = {
      version: typeof version === 'number' ? version : 1,
      savedAt: new Date().toISOString(),
      apiContract,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  } catch (err) {
    logAndSwallow(err, '[api-contract-history] save failed');
  }
}
