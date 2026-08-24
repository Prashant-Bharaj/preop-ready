/**
 * Test-tier helpers for synthesising a `.harness/contracts.json` envelope on
 * disk.
 *
 * Production reads contracts.json via `readContracts` (server/session/harness-
 * state.js), and check-permissions caches the parsed envelope via its own
 * `invalidateContractsCache`. Tests that exercise either path need a small
 * helper that writes the envelope shape `{version, data}` and invalidates the
 * check-permissions cache. Three Dispatch 2 unit tests inlined near-identical
 * copies; Dispatch 3's new integration tests need the same shape — hitting
 * the wait-for-4th-use consolidation threshold.
 *
 * Conventions:
 *   - The envelope shape is verbatim what `writeContracts` produces in
 *     production: `{ version: 1, data: <object> }`.
 *   - `data` keys are camelCase by convention (`fileStructure`, `apiContract`,
 *     `dataModel`, `uiContract`). The reconciler + file-structure-check tolerate
 *     snake_case fallback; check-permissions does NOT (camelCase only — see
 *     check-permissions.js line ~148). Tests targeting check-permissions
 *     MUST write camelCase; tests targeting the reconciler may pass either.
 *   - `invalidateContractsCache` is called when available (best-effort import)
 *     so a workspace that's been read once will pick up the new envelope.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Async — write `{version:1, data}` to `<wsDir>/.harness/contracts.json` and
 * invalidate check-permissions' in-memory cache for this workspaceDir.
 *
 * @param {string} wsDir absolute path to the test workspace
 * @param {object} dataObj the `data` payload (camelCase keys)
 */
export async function writeContractsEnvelope(wsDir, dataObj) {
  const harnessDir = path.join(wsDir, '.harness');
  await mkdir(harnessDir, { recursive: true });
  const envelope = { version: 1, data: dataObj };
  await writeFile(
    path.join(harnessDir, 'contracts.json'),
    JSON.stringify(envelope, null, 2),
    'utf-8',
  );
  // Best-effort: invalidate the check-permissions cache so a workspace whose
  // contracts have been read once picks up the freshly written envelope. The
  // import is lazy to keep this helper usable in test files that don't import
  // check-permissions at all.
  try {
    const mod = await import('../../server/agent/tools/util/check-permissions.js');
    if (typeof mod.invalidateContractsCache === 'function') {
      mod.invalidateContractsCache(wsDir);
    }
  } catch {
    // The module isn't always available (e.g. light tests that don't pull in
    // the full toolchain). Skipping the invalidation is fine — only matters
    // if the same workspace had contracts read previously.
  }
}

/**
 * Sync convenience for tests that don't already have an async context.
 * Does NOT invalidate the cache (sync ESM dynamic-import is awkward); use
 * the async form when the cache matters.
 */
export function writeContractsEnvelopeSync(wsDir, dataObj) {
  const harnessDir = path.join(wsDir, '.harness');
  mkdirSync(harnessDir, { recursive: true });
  const envelope = { version: 1, data: dataObj };
  writeFileSync(
    path.join(harnessDir, 'contracts.json'),
    JSON.stringify(envelope, null, 2),
    'utf-8',
  );
}

/**
 * Build a contracts envelope object (not written to disk). Useful when a
 * test calls the production writer directly with a known data shape.
 *
 * @param {object} data
 * @returns {{ version: number, data: object }}
 */
export function makeContractsEnvelope(data) {
  return { version: 1, data };
}
