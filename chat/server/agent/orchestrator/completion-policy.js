/**
 * Completion Policy — evaluates whether all required modules in modulePlan
 * completed successfully.
 *
 * Called by execution-router.js after all module runs finish to decide
 * whether to use the enriched contract or fall back to the original.
 *
 * On failure: execution-router falls back to the original (un-enriched) contract.
 */

/**
 * Evaluate whether every required entry in modulePlan produced a non-null output.
 *
 * @param {Array} modulePlan   — the plan array passed to the orchestrator
 * @param {object} moduleOutputs — keyed by module name, value is output or null
 * @returns {{ complete: boolean, failed: string[] }}
 */
export function evaluateCompletion(modulePlan, moduleOutputs) {
  if (!Array.isArray(modulePlan) || modulePlan.length === 0) {
    return { complete: true, failed: [] };
  }

  const failed = modulePlan
    .map(entry => entry.module)
    .filter(name => moduleOutputs[name] == null);

  return {
    complete: failed.length === 0,
    failed,
  };
}
