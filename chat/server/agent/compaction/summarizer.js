/**
 * SummarizerClient — calls the MGA "Summarizer" assistant (Sonnet/Haiku-backed)
 * to produce 9-section conversation-state summaries. Used by Phase 2b for
 * manual compaction testing and by Phase 3 for auto-rotation.
 *
 * Stateless: every call uses a fresh MGA conversation_id (no history
 * accumulation on the summarizer side). `hidden: true` so summarizer runs
 * never appear in the myGenAssist UI.
 *
 * The summarizer's system prompt (see chat/prompts/summarizer.md) enforces
 * a two-block response: `<analysis>` (discarded) + `<summary>` (extracted
 * and used as compressed context). We parse both, the caller picks what
 * it needs.
 *
 * Uses callMgaCompletions like the rest of the harness — system prompt
 * sent every call with cache_control so the prefix hits Anthropic's prompt
 * cache from the second summarization onward.
 */

import { getCredentials } from '../../core/auth.js';
import { callMgaCompletions } from '../llm/llm.js';
import { pickModel } from '../llm/model-picker.js';
import { loadPrompt } from '../prompts/disk-prompt.js';

export class SummarizerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SummarizerUnavailableError';
  }
}

function resolveAssistantId() {
  return getCredentials()?.summarizerAssistantId || null;
}

function extractBlock(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Decide whether a rotation can use the lite (5-section) summary template
 * or needs the full 9-section one. Heuristic: short sessions (<= threshold
 * turns) are well-summarized by the load-bearing five (1 task, 3 files, 7
 * pending, 8 current work, 9 next step). Longer/more-complex sessions keep
 * sections 2/4/5/6 too. Threshold tunable via env. Returns 'lite' or 'full'.
 */
function autoSelectMode(virtualHistory) {
  const threshold = parseInt(process.env.LITE_SUMMARIZER_TURN_THRESHOLD, 10);
  const cutoff = Number.isFinite(threshold) && threshold > 0 ? threshold : 5;
  const turns = virtualHistory?.turnCount ?? virtualHistory?.turns?.length ?? 0;
  return turns <= cutoff ? 'lite' : 'full';
}

/**
 * Reconstruct a plain-text transcript from a session's on-disk event log
 * (transcripts/<sessionId>.jsonl). Used as fallback when the in-memory
 * VirtualHistoryManager isn't available (backend restart, summarizing a
 * session that's no longer active).
 *
 * The transcript file stores different event shapes than virtual history:
 *   - type:'user'      → original user message
 *   - type:'plan_preview' → router-produced task decomposition
 *   - type:'cline' say:'text' → assistant narrative text
 *   - type:'cline' say:'tool' → tool invocation (args inline)
 *   - type:'cline' say:'command' → shell command execution
 *   - type:'cline' say:'completion_result' → final implementation report
 * Tool RESULTS aren't emitted as events in the current spike, so the
 * transcript is less detailed than the live virtual history — but it's
 * enough for the summarizer to extract the 9-section summary because the
 * assistant's own text typically describes the outcomes.
 */
export function buildTranscriptFromEvents(events) {
  if (!events?.length) return '(empty transcript)';
  const lines = [];
  let seq = 0;
  for (const ev of events) {
    if (!ev || !ev.type) continue;
    const p = ev.payload || {};

    if (ev.type === 'user') {
      seq += 1;
      lines.push(`=== USER MESSAGE (event ${seq}) ===`);
      lines.push(p.message || '');
      lines.push('');
    } else if (ev.type === 'plan_preview') {
      seq += 1;
      lines.push(`=== PLAN (event ${seq}) ===`);
      lines.push(`Summary: ${p.message || ''}`);
      if (p.tasks?.length) {
        lines.push('Tasks:');
        for (const t of p.tasks) {
          const spec = t.task || t.summary || '';
          lines.push(`  - [${t.scope || 'unknown'}] ${spec.slice(0, 400)}`);
        }
      }
      lines.push('');
    } else if (ev.type === 'cline') {
      if (p.say === 'text') {
        seq += 1;
        lines.push(`=== ASSISTANT TEXT (event ${seq}, scope=${p.scope || '?'}) ===`);
        lines.push(p.text || '');
        lines.push('');
      } else if (p.say === 'tool') {
        seq += 1;
        const toolName = p.tool || 'unknown';
        lines.push(`=== TOOL USE: ${toolName} (event ${seq}, scope=${p.scope || '?'}) ===`);
        const argsPreview = Object.entries(p)
          .filter(([k]) => !['say', 'scope', 'tool'].includes(k))
          .map(([k, v]) => `${k}=${String(v).slice(0, 400)}`)
          .join('\n');
        lines.push(argsPreview);
        lines.push('');
      } else if (p.say === 'command') {
        seq += 1;
        lines.push(`=== COMMAND (event ${seq}, scope=${p.scope || '?'}) ===`);
        lines.push(p.text || JSON.stringify(p));
        lines.push('');
      } else if (p.say === 'completion_result') {
        seq += 1;
        lines.push(`=== COMPLETION RESULT (event ${seq}, scope=${p.scope || '?'}) ===`);
        lines.push(p.text || '');
        lines.push('');
      }
    } else if (ev.type === 'completion') {
      seq += 1;
      lines.push(`=== COMPLETION EVENT (event ${seq}) ===`);
      lines.push(JSON.stringify(p).slice(0, 500));
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Build a plain-text transcript from a VirtualHistoryManager. Each turn is
 * delimited with clear role markers and tool-call previews, matching the
 * shape the summarizer prompt expects.
 */
export function buildTranscriptFromHistory(history) {
  if (!history?.turns?.length) return '(empty transcript)';
  const lines = [];
  let turnIdx = 0;
  for (const turn of history.turns) {
    turnIdx += 1;
    if (turn.role === 'user') {
      lines.push(`=== USER MESSAGE (turn ${turnIdx}) ===`);
      lines.push(turn.content || '');
      lines.push('');
    } else if (turn.role === 'assistant') {
      lines.push(`=== ASSISTANT RESPONSE (turn ${turnIdx}) ===`);
      lines.push(turn.content || '');
      if (turn.toolCalls?.length) {
        lines.push('');
        lines.push(`--- Tool results for turn ${turnIdx} ---`);
        for (const tc of turn.toolCalls) {
          const preview = tc.resultPreview || '';
          lines.push(`[TOOL RESULT — ${tc.name}] (${tc.resultLength} chars total)`);
          if (tc.params && Object.keys(tc.params).length) {
            const argsPreview = Object.entries(tc.params)
              .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
              .join(' ')
              .slice(0, 200);
            lines.push(`call args: ${argsPreview}`);
          }
          lines.push(preview);
          lines.push('[/TOOL RESULT]');
          lines.push('');
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export class SummarizerClient {
  constructor() {
    this.assistantId = resolveAssistantId();
    this.available = Boolean(this.assistantId);
    if (!this.available) {
      console.log('[summarizer] summarizerAssistantId not set in chat/server/config/assistants.json — summarizer is a no-op until configured');
    }
  }

  /**
   * One-shot stateless call to the Summarizer assistant. Sends a single user
   * message containing the transcript text, receives the full response, and
   * extracts the `<analysis>` + `<summary>` blocks.
   *
   * @param {string} transcriptText
   * @param {object} [opts]
   * @param {string} [opts.customInstructions] - appended after the transcript
   * @param {'full'|'lite'} [opts.mode='full'] - 'lite' prepends `LITE_MODE: yes`
   *        to the user message; the system prompt detects this and emits only
   *        sections 1, 3, 7, 8, 9 instead of the full 9. Saves ~half the
   *        completion tokens on short sessions.
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ rawResponse: string, summary: string|null, analysis: string|null, usage: object|null, elapsedMs: number, mode: 'full'|'lite' }>}
   */
  async summarizeTranscript(transcriptText, { customInstructions = '', mode = 'full', signal = null } = {}) {
    if (!this.available) {
      throw new SummarizerUnavailableError('summarizerAssistantId not configured in chat/server/config/assistants.json');
    }
    const creds = getCredentials();
    if (!creds) {
      throw new SummarizerUnavailableError('No credentials configured for summarizer');
    }

    const liteMarker = mode === 'lite' ? 'LITE_MODE: yes\n\n' : '';
    const userMessage = customInstructions
      ? `${liteMarker}${transcriptText}\n\n---\n\n${customInstructions}`
      : `${liteMarker}${transcriptText}`;

    const t0 = Date.now();

    // /chat/completions with cache_control on the system prompt. The
    // summarizer system prompt is large + identical across every call
    // within a build, so the prefix hits Anthropic's prompt cache from
    // the second summarization onward.
    // Instructions from disk (chat/prompts/summarizer.md); model from config
    // via pickModel — no getAssistantConfig / assistant lookup.
    const instructions = loadPrompt('summarizer.md');
    const messages = [
      { role: 'system', content: [{
          type: 'text',
          text: instructions,
          cache_control: { type: 'ephemeral' },
      }]},
      { role: 'user', content: userMessage },
    ];
    const picked = pickModel({ phase: 'SUMMARIZER', scope: 'compaction' });
    const result = await callMgaCompletions({
      messages,
      model: picked.model,
      assistantLabel: 'Summarizer',
      phase: 'SUMMARIZE',
      scope: 'compaction',
      signal,
    });
    return {
      rawResponse: result.content,
      summary: extractBlock(result.content, 'summary'),
      analysis: extractBlock(result.content, 'analysis'),
      usage: result.usage || null,
      elapsedMs: Date.now() - t0,
      mode,
    };
  }

  /**
   * 9-section conversation-state summary used by Phase 3 rotation. Wraps
   * summarizeTranscript with transcript reconstruction from virtual history.
   * Auto-selects lite vs full mode by turn count: short sessions (<= N
   * turns) use lite to cut summarizer latency by roughly half; longer
   * sessions stay on full so multi-decision context survives. Threshold
   * tunable via `LITE_SUMMARIZER_TURN_THRESHOLD` (default 5). Pass
   * `mode: 'full'` explicitly to override the auto-selection.
   */
  async summarizeConversationState(virtualHistory, customInstructions = '', { mode } = {}) {
    const transcript = buildTranscriptFromHistory(virtualHistory);
    const resolvedMode = mode || autoSelectMode(virtualHistory);
    return this.summarizeTranscript(transcript, { customInstructions, mode: resolvedMode });
  }

  async summarizeVerificationState(_scope, _phaseResults) {
    if (!this.available) return null;
    throw new SummarizerUnavailableError('summarizeVerificationState not implemented until Phase 3');
  }

  async summarizeToolResult(_toolName, _params, _output) {
    if (!this.available) return null;
    throw new SummarizerUnavailableError('summarizeToolResult not implemented yet — Phase 2a microcompact handles most cases');
  }
}
