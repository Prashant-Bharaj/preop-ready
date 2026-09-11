/**
 * Hybrid Router — pure code gate between the planner and build-dispatcher.
 *
 * Reads modulePlan + confidence from the Contract Agent's output and decides
 * whether to invoke the agentic module layer (execution-router.js) or pass
 * the contract through unchanged.
 *
 * Three conditions must ALL be true to run modules:
 *   1. HYBRID_MODULES_ENABLED env flag is 'true'
 *   2. modulePlan is a non-empty array
 *   3. confidence >= CONFIDENCE_THRESHOLD (0.75)
 *
 * On any failure inside the module layer, the original contract is returned
 * unchanged — deterministic behavior is always the safe fallback.
 *
 * No LLM calls in this file. This is a routing decision only.
 *
 * @param {object} opts
 * @param {Array|null}  opts.modulePlan   - module plan from Contract Agent
 * @param {number}      opts.confidence   - confidence score (0.0–1.0)
 * @param {object}      opts.contract     - { tasks, dataModel, apiContract, vectorEngine, uiContract, businessLogicContract }
 * @param {object}      opts.session      - session record
 * @param {object}      opts.envContext   - current env context
 * @returns {Promise<{contract, modulesRan, modulePlan, reasonCodes, skippedReason?}>}
 */

import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow } from '../util/log-helpers.js';

const CONFIDENCE_THRESHOLD = 0.75;

export async function runHybridRouter({ modulePlan, confidence, contract, session, envContext }) {
  const FLAG = process.env.HYBRID_MODULES_ENABLED === 'true';
  const conf = typeof confidence === 'number' ? confidence : 1.0;
  const planLen = Array.isArray(modulePlan) ? modulePlan.length : 0;

  // Gate 1: feature flag
  if (!FLAG) {
    tlog(
      `[hybrid-router] skipped: feature flag off (confidence=${conf.toFixed(2)}, threshold=${CONFIDENCE_THRESHOLD.toFixed(2)}, modulePlanLen=${planLen})`,
    );
    return { contract, modulesRan: false, modulePlan: null, reasonCodes: [], skippedReason: 'flag-off' };
  }

  // Gate 2: module plan present
  if (!Array.isArray(modulePlan) || modulePlan.length === 0) {
    tlog(
      `[hybrid-router] skipped: no module plan (confidence=${conf.toFixed(2)}, threshold=${CONFIDENCE_THRESHOLD.toFixed(2)}, modulePlanLen=${planLen})`,
    );
    return { contract, modulesRan: false, modulePlan: null, reasonCodes: [], skippedReason: 'no-module-plan' };
  }

  // Gate 3: confidence threshold
  if (conf < CONFIDENCE_THRESHOLD) {
    tlog(
      `[hybrid-router] skipped: confidence ${conf.toFixed(2)} below threshold ${CONFIDENCE_THRESHOLD.toFixed(2)} (modulePlanLen=${planLen})`,
    );
    return { contract, modulesRan: false, modulePlan, reasonCodes: [], skippedReason: 'low-confidence' };
  }

  tlog(`[hybrid-router] running modules: ${modulePlan.length} entries, confidence=${conf.toFixed(2)}`);

  // Validate modulePlan shape before dispatching
  const { validateModulePlan } = await import('./hybrid-module-validator.js');
  const validationResult = validateModulePlan(modulePlan);
  if (!validationResult.ok) {
    tlog('[hybrid-router] modulePlan validation failed: %s — falling back to deterministic',
      validationResult.reason);
    return { contract, modulesRan: false, modulePlan, reasonCodes: [], skippedReason: 'invalid-module-plan' };
  }

  try {
    const { runExecutionRouter } = await import('./execution-router.js');
    const result = await runExecutionRouter({ modulePlan, contract, session, envContext });
    tlog('[hybrid-router] modules completed: modulesRan=%s', result.modulesRan);
    return result;
  } catch (err) {
    logAndSwallow(err, '[hybrid-router] execution-router threw — falling back to deterministic');
    return { contract, modulesRan: false, modulePlan, reasonCodes: [], skippedReason: 'module-error' };
  }
}
