/**
 * W3.RECOV — Section K Gap 2. Validates that the per-scope canonical
 * file structure declared in `.harness/contracts.json` is actually
 * realized on disk: every `required_files[]` entry exists AND is larger
 * than `STUB_SIZE_THRESHOLD` (i.e. the agent populated it past the
 * single-comment stub the harness pre-stages). Validates no
 * `forbidden_paths[]` entries exist.
 *
 * Backstops the harness's pre-stage approach in routes.js — pre-stage
 * gets the canonical path into the workspace before the subagent
 * spawns; this check catches the "stub never got filled in" case where
 * the agent wrote to a non-canonical path instead.
 *
 * Returns:
 *   { ok: bool, missingFiles: string[], stubFiles: {path, size}[], forbiddenPresent: string[] }
 *
 * Falls open when no contracts.json is present (early in the build,
 * router output hasn't been persisted yet) — returns `{ ok: true, ... }`.
 * The auto-recovery loop treats this as "nothing to check this round".
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readContracts } from '../session/harness-state.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { STUB_SIZE_THRESHOLD } from '../config/defaults.js';

/**
 * @param {string} workspaceDir
 * @param {string[]} [scopes] - optional filter; default: all scopes in file_structure.
 * @returns {{ ok: boolean, missingFiles: Array<{scope, path}>, stubFiles: Array<{scope, path, size}>, forbiddenPresent: Array<{scope, path}> }}
 */
export function runFileStructureCheck(workspaceDir, scopes = null) {
  const result = {
    ok: true,
    missingFiles: [],
    stubFiles: [],
    forbiddenPresent: [],
  };

  let envelope;
  try {
    envelope = readContracts(workspaceDir);
  } catch (err) {
    // Malformed contracts.json — log and fall open. The structural-checks
    // + reconciler will catch the underlying drift via their own paths.
    logAndSwallow(err, '[file-structure-check] failed to read contracts.json');
    return result;
  }

  const fs_ = envelope?.data?.file_structure || envelope?.data?.fileStructure;
  if (!fs_ || typeof fs_ !== 'object') return result; // pre-finalization

  const targetScopes = scopes && scopes.length
    ? scopes.filter((s) => fs_[s])
    : Object.keys(fs_);

  for (const scope of targetScopes) {
    const spec = fs_[scope] || {};
    const required = Array.isArray(spec.required_files) ? spec.required_files : [];
    const forbidden = Array.isArray(spec.forbidden_paths) ? spec.forbidden_paths : [];

    for (const rel of required) {
      const abs = path.join(workspaceDir, rel);
      if (!existsSync(abs)) {
        result.missingFiles.push({ scope, path: rel });
        continue;
      }
      // Stub-size check. We treat "missing" and "stub" as distinct because
      // they have distinct fix dispatches: missing → "create the file";
      // stub → "the file exists but you didn't write real content into it".
      try {
        const size = statSync(abs).size;
        if (size <= STUB_SIZE_THRESHOLD) {
          result.stubFiles.push({ scope, path: rel, size });
        }
      } catch (err) {
        // Race or permission error — log and skip. file-existence already
        // passed so this is rare.
        logAndSwallow(err, `[file-structure-check] stat failed for ${rel}`);
      }
    }

    for (const rel of forbidden) {
      const abs = path.join(workspaceDir, rel);
      if (existsSync(abs)) {
        result.forbiddenPresent.push({ scope, path: rel });
      }
    }
  }

  result.ok = result.missingFiles.length === 0
    && result.stubFiles.length === 0
    && result.forbiddenPresent.length === 0;
  return result;
}

/**
 * Format a file-structure-check report as a human-readable diagnostic
 * suitable for the auto-recovery loop's fix-directive context.
 */
export function formatFileStructureReport(report) {
  const lines = [];
  if (report.missingFiles.length) {
    lines.push('Missing canonical files (must be created at the listed paths):');
    for (const m of report.missingFiles) lines.push(`  - ${m.path} (scope: ${m.scope})`);
  }
  if (report.stubFiles.length) {
    lines.push('Pre-staged stubs never populated (write real content here):');
    for (const s of report.stubFiles) lines.push(`  - ${s.path} (${s.size} bytes, scope: ${s.scope})`);
  }
  if (report.forbiddenPresent.length) {
    lines.push('Forbidden paths present on disk (wrong language / wrong scope):');
    for (const f of report.forbiddenPresent) lines.push(`  - ${f.path} (scope: ${f.scope})`);
  }
  return lines.join('\n');
}
