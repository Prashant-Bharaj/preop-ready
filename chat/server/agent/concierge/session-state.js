/**
 * Build the `session_state` payload that the concierge LLM expects.
 *
 * The concierge prompt (chat/prompts/concierge.md, ported from experiment)
 * defines the input shape:
 *
 *   {
 *     session_state: {
 *       session_id, build_phase, in_flight_scopes, completed_scopes,
 *       failed_scopes, prior_contract_summary, todo_list
 *     },
 *     user_message
 *   }
 *
 * This builder reads from:
 *   - session record (id, status, todoList)
 *   - orchestration stash (completionReports, inFlightSpawns) — live during build
 *   - .harness/contracts.json on disk — last finalized contract for prior_contract_summary
 *
 * Build phase derivation:
 *   - 'fresh'        — no prior contract on disk + no in-flight build
 *   - 'in_progress'  — orchestration stash active (build is running)
 *   - 'done'         — prior contract exists + no in-flight + no failed scopes recorded
 *   - 'failed'       — prior contract exists + last build had failed scopes
 *
 * Pure data assembly; no LLM, no IO failure handling needed beyond
 * readContracts which already swallows errors.
 */

import { getOrchestrationContext } from '../orchestration-stash.js';
import { readContracts, readStateMd } from '../../session/harness-state.js';
import { WORKSPACE_DIR } from '../../core/paths.js';

const CANONICAL_SCOPE_ORDER = ['database', 'vectordb', 'backend', 'frontend', 'integration'];

/**
 * @param {object} session  the session record (has .id, .status, .todoList, .lastBuildResult)
 * @returns {object} session_state payload for the concierge
 */
export function buildSessionState(session) {
  const stash = getOrchestrationContext(session.id);
  const contractsEnvelope = safeReadContracts();
  const priorContract = contractsEnvelope?.data || null;

  // Build phase derivation
  const isInProgress = !!stash; // stash is set while a dispatch is running
  const hasPriorContract = !!priorContract && Object.keys(priorContract).length > 0;
  const lastFailedScopes = Array.isArray(session.lastBuildResult?.failedScopes)
    ? session.lastBuildResult.failedScopes
    : [];

  let buildPhase;
  if (isInProgress) {
    buildPhase = 'in_progress';
  } else if (!hasPriorContract) {
    buildPhase = 'fresh';
  } else if (lastFailedScopes.length > 0) {
    buildPhase = 'failed';
  } else {
    buildPhase = 'done';
  }

  // Live in-flight + completed scopes from stash (only meaningful during in_progress)
  const inFlightScopes = stash?.inFlightSpawns
    ? CANONICAL_SCOPE_ORDER.filter(s => stash.inFlightSpawns.has(s))
    : [];
  const completedScopes = stash?.completionReports
    ? CANONICAL_SCOPE_ORDER.filter(s => stash.completionReports[s])
    : [];

  // Prior contract summary — condensed view (not the full contract)
  const priorContractSummary = priorContract
    ? summarizeContract(priorContract)
    : null;

  // Post-build ground truth: state.md is the per-scope "what was built" summary
  // written by build-summary.js after each successful build (and after each
  // iterate). Reading it lets the concierge answer post-build questions like
  // "how does auth work?" or "what tables do we have?" with real context
  // instead of the sparse `prior_contract_summary` alone. Null pre-build.
  const builtStateMarkdown = safeReadStateMd();

  return {
    session_id: session.id,
    build_phase: buildPhase,
    in_flight_scopes: inFlightScopes,
    completed_scopes: completedScopes,
    failed_scopes: lastFailedScopes,
    prior_contract_summary: priorContractSummary,
    built_state_markdown: builtStateMarkdown,
    todo_list: Array.isArray(session.todoList) ? session.todoList : [],
    // Hybrid module fields — set by routes.js after hybrid-router runs.
    // Null/empty when no hybrid modules were invoked (deterministic build).
    module_plan: session.lastModulePlan || null,
    reason_codes: Array.isArray(session.lastReasonCodes) ? session.lastReasonCodes : [],
  };
}

function safeReadContracts() {
  try {
    return readContracts(WORKSPACE_DIR);
  } catch {
    return null;
  }
}

function safeReadStateMd() {
  try {
    return readStateMd(WORKSPACE_DIR);
  } catch {
    return null;
  }
}

/**
 * Produce the condensed prior_contract_summary the concierge sees. We don't
 * forward the full data_model/api_contract/ui_contract — the concierge doesn't
 * need to reason about column types, just know what was built and how to talk
 * about it.
 */
function summarizeContract(contract) {
  const scopes = contract.tasksByScope ? Object.keys(contract.tasksByScope) : [];
  const orderedScopes = CANONICAL_SCOPE_ORDER.filter(s => scopes.includes(s));

  // Key features = explicit_features from the brief, IF persisted, else
  // derive from flags + scope presence.
  // For now: just list canonical-flag-mapped features as a placeholder.
  // The brief isn't persisted to contracts.json today; this is a gap to fix
  // in a follow-up segment (W1.STATE enhancement).
  const keyFeatures = [];
  // TODO: pull explicit_features when the brief is persisted to disk

  return {
    archetype: contract.archetype || null, // archetype isn't persisted today; null for now
    intent: contract.intent || null,
    scopes: orderedScopes,
    key_features: keyFeatures,
  };
}
