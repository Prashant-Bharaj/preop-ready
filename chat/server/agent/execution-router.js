/**
 * Execution Router — dispatches agentic modules and reconciles their
 * outputs back into the contract shape for build-dispatcher.js.
 *
 * Called only by hybrid-router.js when all three gates pass.
 * On any module failure, falls back to the original (un-enriched) contract
 * so build-dispatcher always receives a valid input.
 *
 * Reconciliation rules (modules enrich content fields only — tasks[] structure
 * is NEVER modified):
 *   - synthesis output  → merged into businessLogicContract
 *   - policy-checker    → appended as complianceNotes[] on contract root
 *   - retrieval output  → merged into businessLogicContract.contextData
 *
 * This file is P1-wired: the orchestrator/index.js replaces the P0 stub
 * loadSpecialist() dispatch. The orchestrator fans out to the real specialist
 * modules (retrieval, synthesis, policy-checker), records per-step traces,
 * and evaluates completion before returning the enriched contract.
 */

import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow } from '../util/log-helpers.js';

/**
 * @param {object} opts
 * @param {Array}   opts.modulePlan
 * @param {object}  opts.contract
 * @param {object}  opts.session
 * @param {object}  opts.envContext
 * @returns {Promise<{contract, modulesRan, modulePlan, reasonCodes}>}
 */
export async function runExecutionRouter({ modulePlan, contract, session, envContext }) {
  // P1: delegate to orchestrator which fans out to real specialists via handoff-engine
  const { runOrchestrator } = await import('./orchestrator/index.js');
  const { moduleOutputs, completion } = await runOrchestrator({
    modulePlan,
    contract,
    session,
    envContext,
  });

  // If any required module failed, fall back to the original contract so
  // build-dispatcher always receives valid input.
  if (!completion.complete) {
    tlog('[execution-router] incomplete modules: %j — falling back to original contract',
      completion.failed);
    return {
      contract,
      modulesRan: false,
      modulePlan,
      reasonCodes: [],
      skippedReason: 'module-incomplete',
    };
  }

  const enrichedContract = reconcile(contract, moduleOutputs);
  const reasonCodes = deriveReasonCodes(moduleOutputs);

  return {
    contract: enrichedContract,
    modulesRan: true,
    modulePlan,
    reasonCodes,
  };
}

/**
 * Merge module outputs into contract content fields.
 * tasks[] structure is NEVER modified.
 */
function reconcile(contract, moduleOutputs) {
  const enriched = { ...contract };

  // synthesis → merge into businessLogicContract
  const synthesis = moduleOutputs['synthesis'];
  if (synthesis && typeof synthesis === 'object') {
    enriched.businessLogicContract = {
      ...(contract.businessLogicContract || {}),
      llmIntegration: synthesis.promptTemplate || null,
      llmApiSpec: synthesis.apiSpec || null,
      contentSchema: synthesis.contentSchema || null,
    };
  }

  // retrieval → merge contextData into businessLogicContract
  const retrieval = moduleOutputs['retrieval'];
  if (retrieval && typeof retrieval === 'object') {
    enriched.businessLogicContract = {
      ...(enriched.businessLogicContract || contract.businessLogicContract || {}),
      contextData: retrieval.contextData || [],
    };
  }

  // policy-checker → append as complianceNotes on contract root
  const policyChecker = moduleOutputs['policy-checker'];
  if (policyChecker && Array.isArray(policyChecker.flags)) {
    enriched.complianceNotes = policyChecker.flags;
  }

  return enriched;
}

function deriveReasonCodes(moduleOutputs) {
  const codes = [];
  if (moduleOutputs['synthesis']) codes.push('adaptive-need');
  if (moduleOutputs['retrieval']) codes.push('research-need');
  if (moduleOutputs['policy-checker']) codes.push('policy-check');
  return codes;
}
