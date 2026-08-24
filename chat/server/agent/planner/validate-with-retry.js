/**
 * Retry-once wrapper around the contract-agent call.
 *
 * Calls contract-agent. If the response fails validation, builds a retry
 * payload containing the previous contract + structured violation list and
 * calls contract-agent again. The prompt's `## Retry handling` section
 * (chat/prompts/contract-agent.md) tells the model how to interpret this
 * input. After one retry, surface the failure to the caller.
 *
 * Why retry-once (not retry-forever):
 *   - Two attempts is enough to recover from non-deterministic prompt drift
 *     (the empirical "16/17 fixtures pass" baseline shows ~6% drift rate;
 *     a single retry should cover almost all of it).
 *   - More attempts mask deeper prompt bugs that should be fixed in
 *     contract-agent.md instead of papered over at runtime.
 *   - Cost: each retry is a full contract-agent invocation (~15-20s).
 */

import { parseAndValidateContract } from './two-agent-parser.js';

/**
 * @param {object}   brief                The Understanding Agent's brief (or
 *                                        iterate input: { prior_contract,
 *                                        failure_description }).
 * @param {function} callContractAgent    async function(input) -> {
 *                                          content: string,
 *                                          conversationId: string
 *                                        }
 *                                        Injected so this is testable with a
 *                                        mock; production wiring (Phase B) will
 *                                        pass a function that calls MGA's
 *                                        contract-agent assistant.
 * @param {object}   opts                 { mode?: 'execute' | 'iterate',
 *                                          hybridSignals?: object }
 *
 * @returns {Promise<
 *     { ok: true,  contract, attempt, softCorrects, mode }
 *   | { ok: false, error: 'contract_invalid_after_retry', violations,
 *       attempts: [{ violations }, { violations }], mode }
 * >}
 */
export async function runContractAgentWithRetry(brief, callContractAgent, opts = {}) {
  const mode = opts.mode || 'execute';

  // First attempt — pass the brief verbatim.
  const first = await callContractAgent(brief);
  const firstResult = parseAndValidateContract(first.content, first.conversationId, { mode, hybridSignals: opts.hybridSignals });
  if (firstResult.ok) {
    return {
      ok: true,
      mode,
      attempt: 1,
      contract: firstResult.contract,
      softCorrects: firstResult.softCorrects,
      messages: first.messages || null,
    };
  }

  // First attempt failed — build retry input and call again.
  const retryInput = {
    ...brief,
    retry_reason: 'validation_failed',
    previous_contract: firstResult.parsed,
    violations: firstResult.violations,
  };
  const second = await callContractAgent(retryInput);
  const secondResult = parseAndValidateContract(second.content, second.conversationId, { mode, hybridSignals: opts.hybridSignals });
  if (secondResult.ok) {
    return {
      ok: true,
      mode,
      attempt: 2,
      contract: secondResult.contract,
      softCorrects: secondResult.softCorrects,
      // Retry messages reflect THIS attempt only (fresh system + retry user
      // turn + assistant). The judge continuation should see the response
      // that actually became the contract, not the first invalid attempt.
      messages: second.messages || null,
    };
  }

  // Both attempts failed — caller decides UX (show user, log, etc).
  return {
    ok: false,
    mode,
    error: 'contract_invalid_after_retry',
    violations: secondResult.violations,
    attempts: [
      { violations: firstResult.violations },
      { violations: secondResult.violations },
    ],
  };
}
