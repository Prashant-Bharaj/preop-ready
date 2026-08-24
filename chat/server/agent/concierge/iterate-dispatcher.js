/**
 * Concierge → iterate dispatcher.
 *
 * When the concierge LLM decides the user's post-build message is a code
 * change request (action: 'dispatch_iterate'), it emits an `iterate_summary`
 * plus the verbatim user text. This module turns that intent into a real
 * iterate dispatch by:
 *
 *   1. Reading the last finalized contract from .harness/contracts.json
 *      (the planner's pre-subagent snapshot — same source used by the
 *      project memory block).
 *   2. Calling the contract-agent in ITERATE mode with
 *      { prior_contract, failure_description: iterate_summary, ... }.
 *      This is the contract-agent's documented iterate input shape
 *      (see chat/prompts/contract-agent.md §9). The agent emits
 *      contract_diffs scoped to affected_scopes.
 *   3. Returning a routerResult-shaped envelope that the existing
 *      dispatchIterate (chat/server/session/routes.js) consumes
 *      verbatim — single-scope direct or multi-scope orchestrator path
 *      is picked by dispatchIterate based on affectedScopes.length.
 *
 * Why this lives separately from two-agent.js routeMessage:
 *   - routeMessage drives the FRESH planner pass (Understanding → Contract
 *     in execute mode). It's optimized for the no-prior-contract case.
 *   - The post-build iterate path skips Understanding entirely — the
 *     concierge already classified intent + summarized the change. So
 *     we only need the Contract Agent in iterate mode, with a brief
 *     synthesized from the concierge's emission. Routing through
 *     routeMessage would re-run Understanding pointlessly and add
 *     ~10-15s of latency for no gain.
 *   - Keeping the iterate path concierge-owned also means the
 *     `failure_description` + `iterate_user_message` flow exactly mirror
 *     the concierge prompt's output contract (concierge.md §3), which
 *     reduces the chance of shape drift between the two.
 *
 * Output: {ok: true, routerResult} on success, {ok: false, error, ...}
 * on failure. Caller (handle-action.js) is responsible for emitting
 * the user-facing error message and falling back to a graceful response.
 */

import { readContracts } from '../../session/harness-state.js';
import { runContractAgentWithRetry } from '../planner/validate-with-retry.js';
import { makeContractAgentCaller } from '../planner/two-agent.js';
import { getCredentials } from '../../core/auth.js';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { tlog } from '../../util/timestamped-log.js';

/**
 * @param {object} args
 * @param {string} args.iterateSummary - the concierge's one-sentence change description
 * @param {string} args.iterateUserMessage - the user's verbatim text (for context)
 * @param {string} [args.workspaceDir] - defaults to WORKSPACE_DIR
 * @returns {Promise<
 *   { ok: true, routerResult: object, contractAgentMessages: Array }
 * | { ok: false, error: string, violations?: Array }
 * >}
 */
export async function runConciergeIterate({ iterateSummary, iterateUserMessage, workspaceDir = WORKSPACE_DIR }) {
  if (typeof iterateSummary !== 'string' || !iterateSummary.trim()) {
    return { ok: false, error: 'iterate-dispatcher: iterate_summary missing or empty' };
  }

  // ── 1. Load prior contract from disk ──────────────────────────────────
  let envelope;
  try {
    envelope = readContracts(workspaceDir);
  } catch (err) {
    return { ok: false, error: `iterate-dispatcher: readContracts threw: ${err.message}` };
  }
  if (!envelope || !envelope.data || Object.keys(envelope.data).length === 0) {
    return { ok: false, error: 'iterate-dispatcher: .harness/contracts.json missing or empty (no prior build to iterate on)' };
  }
  const priorContract = envelope.data;

  // ── 2. Set up contract-agent caller ────────────────────────────────────
  const creds = getCredentials();
  if (!creds) {
    return { ok: false, error: 'iterate-dispatcher: no MGA credentials configured' };
  }
  const contractAssistantId = creds.contractAssistantId;
  if (!contractAssistantId) {
    return { ok: false, error: 'iterate-dispatcher: contractAssistantId not configured (set in .chat/secrets.json or env)' };
  }
  const callContractAgent = makeContractAgentCaller({ assistantId: contractAssistantId });

  // ── 3. Build iterate brief ─────────────────────────────────────────────
  // Shape matches contract-agent.md §9 ITERATE mode: prior_contract +
  // failure_description (the change ask, treated semantically as "what
  // about the prior build is failing/missing/needs revision"). We also
  // include iterate_user_message as extra context — harmless if the
  // prompt ignores it, useful for the model when iterate_summary is
  // terse and the verbatim text disambiguates.
  const brief = {
    prior_contract: priorContract,
    failure_description: iterateSummary,
    iterate_user_message: iterateUserMessage || iterateSummary,
  };

  // ── 4. Call contract-agent in iterate mode (with retry) ────────────────
  const t0 = Date.now();
  tlog('[iterate-dispatcher] calling contract-agent ITERATE mode: summary=%s',
    iterateSummary.length > 100 ? iterateSummary.slice(0, 100) + '...' : iterateSummary);
  const contractResult = await runContractAgentWithRetry(brief, callContractAgent, { mode: 'iterate' });
  const latencyMs = Date.now() - t0;

  if (!contractResult.ok) {
    tlog('[iterate-dispatcher] contract-agent ITERATE failed (%dms): %s',
      latencyMs, (contractResult.violations || []).join('; '));
    return {
      ok: false,
      error: 'iterate-dispatcher: contract-agent iterate mode failed validation after retry',
      violations: contractResult.violations,
    };
  }

  const contract = contractResult.contract;
  tlog('[iterate-dispatcher] contract-agent ITERATE ok (%dms attempt=%d): scopes=[%s] diffs=[%s]',
    latencyMs, contractResult.attempt,
    (contract.affectedScopes || []).join(','),
    Object.keys(contract.contractDiffs || {}).join(','));

  // ── 5. Build the routerResult shape dispatchIterate expects ────────────
  // Mirrors two-agent.js executeResult / clarifyResult — same envelope,
  // just with action='iterate' + iterate-specific fields populated.
  const routerResult = {
    action: 'iterate',
    message: contract.message || iterateSummary,
    tasks: Array.isArray(contract.tasks) ? contract.tasks : [],
    flags: Array.isArray(contract.flags) ? contract.flags : [],
    contractDiffs: contract.contractDiffs || {},
    affectedScopes: contract.affectedScopes || [],
    // Full-contract fields are null on iterate — diffs carry the change.
    dataModel: null,
    apiContract: null,
    uiContract: null,
    businessLogicContract: null,
    vectorEngine: null,
    // ITERATE may INTRODUCE AI capability: the contract agent emits
    // mga_assistants (same schema as fresh mode) when the iteration's
    // feature needs an assistant that doesn't exist yet. dispatchIterate
    // provisions them before dispatch — without this, "add AI to my app"
    // produced code calling MGA with no assistant and no credentials.
    mgaAssistants: Array.isArray(contract.mga_assistants) ? contract.mga_assistants
      : (Array.isArray(contract.mgaAssistants) ? contract.mgaAssistants : []),
    symptom: null,
    suspectedScope: null,
    conversationId: null,
    softCorrects: contractResult.softCorrects || [],
    sentUserMessage: JSON.stringify(brief, null, 2),
    rawAssistantResponse: contract.message || '',
    contractAgentMessages: contractResult.messages || null,
  };

  return {
    ok: true,
    routerResult,
    contractAgentMessages: contractResult.messages || null,
  };
}
