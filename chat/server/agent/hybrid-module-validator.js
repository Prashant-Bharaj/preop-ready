/**
 * Hybrid Module Validator — validates modulePlan array shape before
 * hybrid-router dispatches to the execution layer.
 *
 * Called by hybrid-router.js. If validation fails, hybrid-router falls
 * back to deterministic silently.
 *
 * Valid module names match the specialists defined in orchestrator/specialists/.
 * Valid trigger values: 'build-time' only (runtime triggers are P2+).
 */

const VALID_MODULES = new Set(['synthesis', 'retrieval', 'policy-checker']);
const VALID_TRIGGERS = new Set(['build-time']);

/**
 * @param {Array} modulePlan
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateModulePlan(modulePlan) {
  if (!Array.isArray(modulePlan)) {
    return { ok: false, reason: 'modulePlan is not an array' };
  }
  for (let i = 0; i < modulePlan.length; i++) {
    const entry = modulePlan[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, reason: `entry[${i}] is not an object` };
    }
    if (!VALID_MODULES.has(entry.module)) {
      return { ok: false, reason: `entry[${i}].module "${entry.module}" is not a valid module` };
    }
    if (!VALID_TRIGGERS.has(entry.trigger)) {
      return { ok: false, reason: `entry[${i}].trigger "${entry.trigger}" is not valid` };
    }
    if (typeof entry.input !== 'string' || !entry.input.trim()) {
      return { ok: false, reason: `entry[${i}].input must be a non-empty string` };
    }
    if (typeof entry.output !== 'string' || !entry.output.trim()) {
      return { ok: false, reason: `entry[${i}].output must be a non-empty string` };
    }
  }
  return { ok: true };
}
