/**
 * VirtualHistoryManager — mirrors what we've sent to MGA under a given
 * conversation_id. MGA owns the real history opaquely; this is our
 * client-side shadow so we can measure token load, detect repetition,
 * and decide when to rotate conversations.
 *
 * Phase 1: measurement only. Records user messages, assistant responses,
 * and tool calls. Exposes metrics. No behavior change.
 *
 * Phases 2a/2b/3 will read from this to drive microcompact, full compact,
 * and rotation triggers. Keep the surface narrow — only add accessors as
 * downstream modules actually need them.
 */

const CHARS_PER_TOKEN = 4;

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class VirtualHistoryManager {
  constructor({ conversationId = null, scope = null } = {}) {
    this.conversationId = conversationId;
    this.scope = scope;
    this.turns = [];
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.turnCount = 0;
  }

  /** Call just before sending a user message to MGA. */
  recordUserMessage(content) {
    this.turns.push({
      role: 'user',
      content,
      estimatedTokens: estimateTokensFromText(content),
      timestamp: Date.now(),
      toolCalls: [],
    });
  }

  /** Call when MGA's streamed response has fully arrived. */
  recordAssistantResponse(content, usage = null) {
    const turn = {
      role: 'assistant',
      content,
      estimatedTokens: estimateTokensFromText(content),
      timestamp: Date.now(),
      usage: usage || null,
    };
    this.turns.push(turn);
    this.turnCount += 1;
    if (usage) {
      const pt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
      const ct = usage.completion_tokens ?? usage.output_tokens ?? 0;
      this.totalPromptTokens += pt;
      this.totalCompletionTokens += ct;
    }
  }

  /** Call per tool dispatched in the current assistant turn. `result` may be truncated. */
  recordToolCall(name, params, result) {
    const lastAssistant = [...this.turns].reverse().find(t => t.role === 'assistant');
    const entry = {
      name,
      params: params || {},
      resultPreview: typeof result === 'string' ? result.slice(0, 2000) : '',
      resultLength: typeof result === 'string' ? result.length : 0,
      timestamp: Date.now(),
    };
    if (lastAssistant) {
      lastAssistant.toolCalls ||= [];
      lastAssistant.toolCalls.push(entry);
    } else {
      this.turns.push({ role: 'tool', name, entry });
    }
  }

  setConversationId(id) {
    this.conversationId = id;
  }

  /**
   * Cumulative tokens billed across all turns currently tracked in this
   * MGA conversation. Used by the rotation trigger to decide whether the
   * conversation has grown past the compaction threshold.
   *
   * This is a CONVERSATION-scoped cumulative, not a run-scoped one — the
   * `turns` array is reset on rotation, so this resets too. That's what
   * the trigger wants: "how much has the current MGA conversation cost?"
   * (not "how much has the whole user prompt cost?" — that lives in
   * sessionTotals on the agent.js side).
   *
   * Note: MGA's `buffer_length` means per-turn prompt_tokens stays roughly
   * flat regardless of conversation length, so a "max of last turn"
   * heuristic doesn't signal conversation growth. Summing usage across
   * turns gives the actual monotonic growth we need for the trigger.
   */
  estimateVirtualTokens() {
    let total = 0;
    for (const turn of this.turns) {
      if (turn.role === 'assistant' && turn.usage) {
        total += turn.usage.prompt_tokens ?? turn.usage.input_tokens ?? 0;
        total += turn.usage.completion_tokens ?? turn.usage.output_tokens ?? 0;
      } else if (!turn.usage) {
        // No usage yet (e.g. pending user message before first response) —
        // fall back to our char-based estimate for this turn only.
        total += turn.estimatedTokens || 0;
      }
    }
    return total;
  }

  /** Snapshot of counters for logging / event emission. */
  getMetrics() {
    return {
      conversationId: this.conversationId,
      scope: this.scope,
      turnCount: this.turnCount,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      estimatedVirtualTokens: this.estimateVirtualTokens(),
      recordedTurns: this.turns.length,
    };
  }
}
