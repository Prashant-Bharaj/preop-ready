/**
 * Handoff Engine — routes each module plan entry to the correct specialist.
 *
 * Enforces:
 *   - Max 3 hops total across all module invocations
 *   - No circular calls (each module runs at most once)
 *   - Per-module timeout (default 30s, configurable via HYBRID_MODULE_TIMEOUT_MS)
 *
 * On any individual module failure (timeout, error, unknown module), the
 * module output is recorded as null — the completion-policy decides whether
 * that is acceptable.
 *
 * Returns: { moduleOutputs: { [moduleName]: output|null }, hops: number }
 */

import { tlog } from '../../util/timestamped-log.js';

const MAX_HOPS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

const SPECIALIST_MAP = {
  retrieval: () => import('./specialists/retrieval.js'),
  synthesis: () => import('./specialists/synthesis.js'),
  'policy-checker': () => import('./specialists/policy-checker.js'),
};

/**
 * @param {object} opts
 * @param {Array}  opts.modulePlan   — validated module plan entries
 * @param {object} opts.contract     — current contract (passed read-only to each specialist)
 * @param {object} opts.session      — session record (passed read-only to each specialist)
 * @param {object} opts.envContext   — env context
 * @returns {Promise<{ moduleOutputs: object, hops: number }>}
 */
export async function runHandoffEngine({ modulePlan, contract, session, envContext }) {
  const timeoutMs = Number(process.env.HYBRID_MODULE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const moduleOutputs = {};
  const seen = new Set();
  let hops = 0;

  for (const entry of modulePlan) {
    if (hops >= MAX_HOPS) {
      tlog('[handoff-engine] max hops (%d) reached — skipping remaining modules', MAX_HOPS);
      break;
    }

    const { module: moduleName } = entry;

    // Guard: no circular calls
    if (seen.has(moduleName)) {
      tlog('[handoff-engine] module %s already ran — skipping duplicate', moduleName);
      continue;
    }

    if (!SPECIALIST_MAP[moduleName]) {
      tlog('[handoff-engine] unknown module "%s" — skipping', moduleName);
      moduleOutputs[moduleName] = null;
      continue;
    }

    seen.add(moduleName);
    hops++;

    const t0 = Date.now();
    try {
      const specialistModule = await SPECIALIST_MAP[moduleName]();
      const output = await Promise.race([
        specialistModule.run({ entry, contract, session, envContext }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      moduleOutputs[moduleName] = output;
      tlog('[handoff-engine] module %s completed in %dms', moduleName, Date.now() - t0);
    } catch (err) {
      tlog('[handoff-engine] module %s failed: %s', moduleName, err.message);
      moduleOutputs[moduleName] = null;
    }
  }

  return { moduleOutputs, hops };
}
