/**
 * Microcompact between iterations (W4.BUDGET — HARNESS_EVOLUTION.md §J).
 *
 * Distinct from MicrocompactCache in compact.js (Phase 2a, dispatch-time
 * dedup of identical read_file / use_mcp_tool results). This module is the
 * Section J "summarise oldest tool-result blocks when accumulated history
 * exceeds 50% of the model context window" trigger — fires between agent
 * loop iterations and uses the existing SummarizerClient to produce a
 * compressed restatement of the oldest N tool-result blocks.
 *
 * v1 scope (per the W4.BUDGET brief):
 *   - Fires when `history.estimateVirtualTokens() > modelWindow * ratio`
 *   - Picks the oldest N assistant turns that carry toolCalls
 *   - Builds a mini-transcript of those tool-results, asks the summarizer
 *     to compress them, and emits a typed `microcompact_fired` event with
 *     before/after token counts so we can track adoption + effectiveness
 *   - Summarizer failures are logAndSwallow-ed; the trigger returns
 *     { fired: false, ... } and the loop continues with unaltered state
 *
 * What this DOESN'T do (intentional, v1 deferral):
 *   - It does not mutate MGA's stored history. MGA owns history opaquely;
 *     the only ways we influence it are conversation rotation (already
 *     implemented in agent.js → performRotation) and via the next user
 *     message. Microcompact's v1 effect is observability — the summarizer
 *     call confirms the rollup is feasible, the event gives Phase-4
 *     telemetry the signal to tune thresholds.
 *   - It does not borrow Claude Code's token-budget heuristics. Section J
 *     explicitly calls those overkill for v1. Threshold + N are constants
 *     in chat/server/config/defaults.js, tunable via telemetry once data
 *     accumulates.
 *
 * TODO(W4.PROMPTS-followup) — splice summary into next user message.
 *   The summary text already comes back to the caller via the
 *   { fired, summaryText, coveredTurns } shape (see return below); the
 *   v1 implementation just doesn't propagate it past the telemetry event.
 *   To ship splicing later:
 *     1. Stash summary on session: e.g. `session.pendingMicrocompactSummary
 *        = { text, coveredTurns, firedAt: iter }` from the caller in
 *        agent.js around line 790 when `mc.fired === true`.
 *     2. In the agent.js message composer (search for where the next
 *        user-message body is assembled before the MGA API call),
 *        prepend a context block like:
 *          <!-- microcompact-summary (turns ${range}) -->
 *          ${summary.text}
 *          <!-- /microcompact-summary -->
 *
 *          ${actualUserOrToolMessage}
 *        then clear `session.pendingMicrocompactSummary`.
 *     3. Test: stub the summarizer in chat/tests/agents/test-microcompact.js
 *        to return a known summary; fire maybeMicrocompact; assert the
 *        next composeUserMessage() output prepends the summary block.
 *
 *   Deferred to post-merge polish because: (a) MGA's conversation-id
 *   semantics + opaque history storage makes inline splicing
 *   error-class-risky — a wrong-format splice could corrupt the
 *   conversation MGA-side; (b) v1 observability data (the
 *   `microcompact_fired` typed event aggregated by `runs-report.js`) needs
 *   to confirm the 50%-of-window threshold is well-tuned before paying
 *   the integration-risk cost. Once telemetry shows a stable fire-rate
 *   and confirmed wins on subsequent-iteration token totals, splicing
 *   becomes the obvious next-step PR.
 */

import {
  MICROCOMPACT_HISTORY_THRESHOLD_RATIO,
  MICROCOMPACT_MODEL_WINDOW_TOKENS,
  MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE,
} from '../../config/defaults.js';
import { logAndSwallow } from '../../util/log-helpers.js';

/**
 * Build a mini-transcript containing only the oldest N assistant turns
 * that carry tool calls, formatted for the summarizer. Returns the text
 * + the index range of turns covered so callers can report what was
 * compacted.
 */
function buildOldestToolResultsTranscript(history, n) {
  const turns = history?.turns || [];
  const candidates = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== 'assistant') continue;
    if (!Array.isArray(t.toolCalls) || t.toolCalls.length === 0) continue;
    candidates.push({ idx: i, turn: t });
    if (candidates.length >= n) break;
  }
  if (candidates.length === 0) return { text: '', covered: [] };

  const lines = [];
  for (const { idx, turn } of candidates) {
    lines.push(`=== ASSISTANT TURN ${idx + 1} ===`);
    if (turn.content) {
      lines.push(turn.content.slice(0, 1500));
      lines.push('');
    }
    for (const tc of turn.toolCalls) {
      lines.push(`[TOOL RESULT — ${tc.name}] (${tc.resultLength} chars total)`);
      if (tc.params && Object.keys(tc.params).length) {
        const argsPreview = Object.entries(tc.params)
          .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
          .join(' ')
          .slice(0, 200);
        lines.push(`call args: ${argsPreview}`);
      }
      if (tc.resultPreview) lines.push(tc.resultPreview);
      lines.push('[/TOOL RESULT]');
      lines.push('');
    }
  }
  return { text: lines.join('\n'), covered: candidates.map((c) => c.idx) };
}

/**
 * Estimate the token cost of a slice of turns. Mirrors the cumulative-usage
 * math in VirtualHistoryManager.estimateVirtualTokens but scoped to specific
 * turn indexes. Used for the before/after delta in the microcompact event.
 */
function estimateTurnsTokens(history, turnIndexes) {
  const turns = history?.turns || [];
  let total = 0;
  for (const i of turnIndexes) {
    const turn = turns[i];
    if (!turn) continue;
    if (turn.usage) {
      total += turn.usage.prompt_tokens ?? turn.usage.input_tokens ?? 0;
      total += turn.usage.completion_tokens ?? turn.usage.output_tokens ?? 0;
    } else {
      total += turn.estimatedTokens || 0;
    }
    // Tool results contribute to the conversation prompt budget. The
    // virtual-history accountant rolls them into the assistant turn's
    // usage; we estimate from resultPreview length as a floor.
    if (Array.isArray(turn.toolCalls)) {
      for (const tc of turn.toolCalls) {
        const previewChars = (tc.resultPreview || '').length;
        if (previewChars > 0) total += Math.ceil(previewChars / 4);
      }
    }
  }
  return total;
}

/**
 * Run a single microcompact check between agent loop iterations.
 *
 * @param {object} args
 * @param {object} args.history          - VirtualHistoryManager
 * @param {object} args.summarizerClient - SummarizerClient (may be null/unavailable)
 * @param {number} args.iter             - current iteration index (0-based)
 * @param {function} args.emitEvent      - emit({ ...payload, say|ask|...}) callback
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ fired: boolean, reason?: string, blocksSummarised?: number,
 *                     beforeTokens?: number, afterTokens?: number, ratio?: number,
 *                     summaryText?: string }>}
 */
export async function maybeMicrocompact({ history, summarizerClient, iter, emitEvent, signal = null } = {}) {
  if (!history) return { fired: false, reason: 'no-history' };
  const threshold = Math.floor(MICROCOMPACT_MODEL_WINDOW_TOKENS * MICROCOMPACT_HISTORY_THRESHOLD_RATIO);
  const beforeTokens = history.estimateVirtualTokens?.() ?? 0;
  if (beforeTokens <= threshold) {
    return { fired: false, reason: 'under-threshold', beforeTokens, threshold };
  }
  if (!summarizerClient || !summarizerClient.available) {
    // Summarizer not configured — record the missed opportunity and bail.
    // logAndSwallow keeps this non-fatal: microcompact is a best-effort
    // observability mechanism, not a hard requirement for the loop.
    logAndSwallow(
      new Error('microcompact wanted to fire but summarizer is unavailable'),
      '[microcompact-iteration] summarizer unavailable — skipping',
    );
    return { fired: false, reason: 'summarizer-unavailable', beforeTokens, threshold };
  }

  const { text: transcript, covered } = buildOldestToolResultsTranscript(
    history,
    MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE,
  );
  if (!transcript || covered.length === 0) {
    return { fired: false, reason: 'no-tool-results-to-summarise', beforeTokens, threshold };
  }

  const oldTokens = estimateTurnsTokens(history, covered);
  let summaryText = null;
  let summarizerError = null;
  try {
    const result = await summarizerClient.summarizeTranscript(transcript, {
      mode: 'lite',
      signal,
      customInstructions:
        'You are compacting OLD TOOL-RESULT BLOCKS that are no longer load-bearing for the agent\'s current decision. ' +
        'Output a single concise paragraph (max 8 lines) covering ONLY: (a) which files were read/written and the key facts the model extracted, (b) which commands ran and their outcome, (c) any errors that surfaced and how they were addressed. ' +
        'Do NOT restate the task. Do NOT speculate about next steps. Wrap output in <summary>...</summary> like the standard summarizer template.',
    });
    summaryText = result?.summary || null;
  } catch (err) {
    summarizerError = err;
    logAndSwallow(err, '[microcompact-iteration] summarizer call failed — skipping');
  }

  if (!summaryText) {
    return {
      fired: false,
      reason: summarizerError ? 'summarizer-error' : 'summarizer-no-summary',
      beforeTokens,
      threshold,
    };
  }

  const summaryTokens = Math.ceil(summaryText.length / 4);
  const afterTokens = Math.max(beforeTokens - oldTokens + summaryTokens, summaryTokens);
  const ratio = afterTokens / Math.max(beforeTokens, 1);

  // Typed transcript event so Phase-4 telemetry can roll up frequency,
  // effectiveness, and per-scope distribution. logAndSwallow because a
  // failed emit must not crash the agent loop.
  if (typeof emitEvent === 'function') {
    try {
      emitEvent({
        say: 'microcompact_fired',
        blocksSummarised: covered.length,
        beforeTokens,
        afterTokens,
        ratio,
        threshold,
        iter,
        coveredTurns: covered.map((i) => i + 1), // 1-based for human reading
        summaryChars: summaryText.length,
      });
    } catch (err) {
      logAndSwallow(err, '[microcompact-iteration] emit microcompact_fired failed');
    }
  }

  return {
    fired: true,
    blocksSummarised: covered.length,
    beforeTokens,
    afterTokens,
    ratio,
    summaryText,
    coveredTurns: covered,
  };
}
