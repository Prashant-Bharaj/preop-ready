/**
 * W3.RECOV — Section F item 1. Promotes a subset of `chat/tests/smoke/
 * smoke-asserts.js` from test-only into runtime checks the auto-recovery
 * loop calls as another failure-detection input.
 *
 * Promoted assertions (canonical-entry + dockerfile-sanity subset):
 *   - assertBackendNoApiPrefix    — backend routes don't use /api/ prefix
 *   - assertBackendHealth         — backend has /health route
 *   - assertBackendDockerfile     — backend Dockerfile FROM matches entry lang
 *   - assertDatabaseInit          — database/init/init.sql exists + idempotent
 *   - assertFrontendNginxBoth     — both nginx configs present + correct shape
 *   - assertFrontendDockerfileCurl — frontend Dockerfile installs curl
 *
 * NOT promoted (kept smoke-only):
 *   - assertVectordbIndependent / assertComposeShape — those are
 *     compose-level invariants; the existing reconciler + structural-checks
 *     handle the same surface today.
 *   - assertRouterExpect — router-output checks fire before workspace
 *     writes happen; auto-recovery runs over the workspace.
 *
 * IMPORTANT: this module IMPORTS the smoke asserts directly so we don't
 * fork the implementations. Smoke continues to call them through its
 * own dispatcher; auto-recovery wraps them in a runtime-friendly
 * `runRuntimeAsserts(workspaceDir, scopes)` that catches the per-helper
 * throws and converts them into a structured failure list.
 */

import {
  assertBackendNoApiPrefix,
  assertBackendHealth,
  assertBackendDockerfile,
  assertDatabaseInit,
  assertFrontendNginxBoth,
  assertFrontendDockerfileCurl,
} from '../../tests/smoke/smoke-asserts.js';

const SCOPE_CHECKS = {
  backend: [
    { name: 'assertBackendNoApiPrefix', fn: assertBackendNoApiPrefix },
    { name: 'assertBackendHealth', fn: assertBackendHealth },
    { name: 'assertBackendDockerfile', fn: assertBackendDockerfile },
  ],
  database: [
    { name: 'assertDatabaseInit', fn: assertDatabaseInit },
  ],
  frontend: [
    { name: 'assertFrontendNginxBoth', fn: assertFrontendNginxBoth },
    { name: 'assertFrontendDockerfileCurl', fn: assertFrontendDockerfileCurl },
  ],
};

/**
 * Run all runtime asserts for the provided scopes. Returns a structured
 * failure list (empty = all clean). Never throws.
 *
 * @param {string} workspaceDir
 * @param {string[]} scopes
 * @returns {{ ok: boolean, failures: Array<{ scope, check, error }> }}
 */
export function runRuntimeAsserts(workspaceDir, scopes = []) {
  const failures = [];
  for (const scope of scopes) {
    const checks = SCOPE_CHECKS[scope] || [];
    for (const { name, fn } of checks) {
      try {
        fn(workspaceDir);
      } catch (err) {
        failures.push({ scope, check: name, error: err.message });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
