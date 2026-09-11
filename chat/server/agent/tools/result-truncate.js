// Pre-send tool-result truncation. The third compaction layer alongside
// microcompact (deterministic dedup of duplicate reads) and rotation
// (full-conversation summary at threshold). Targets the cost dynamic where
// a single oversize tool result — a 5K-line file read, a verbose `npm
// install` log, a recursive `list_files` against a deep directory — gets
// wrapped into the next user message and sits in MGA conversation history
// for the rest of the run.
//
// Under MGA we can't mutate prior messages mid-conversation; we either
// rotate (start fresh with a summary) or prevent bloat from entering in
// the first place. This module does the latter: caps each tool result at
// `maxChars` BEFORE the wrap into the next user message, replacing the
// truncated middle with a marker that tells the model what was cut and
// how to re-fetch it if needed (line range, tighter filter, etc.).
//
// Errors are not truncated — they're small and the full text is what the
// model needs to recover. Same for sub-cap results; passthrough.

const DEFAULT_MAX_CHARS = 32_000; // ~8K tokens at 4 chars/token. Per Anthropic's
                                  // tokenizer for English+code this is conservative.
const HEAD_FRACTION = 0.7;        // 70% head, 30% tail for tools where both ends matter.

// Resolve the cap for this call. Priority: explicit `maxChars` arg →
// TOOL_RESULT_MAX_CHARS env var → DEFAULT_MAX_CHARS. Read from env at call
// time (not module load) so smoke scenarios can override per-test via
// applyEnvOverrides.
function resolveMaxChars(override) {
  if (typeof override === 'number' && override > 0) return override;
  const envVal = parseInt(process.env.TOOL_RESULT_MAX_CHARS, 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_MAX_CHARS;
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function buildTruncationMarker(toolName, params, originalChars, headLen, tailLen) {
  const omittedChars = originalChars - headLen - tailLen;
  const omittedTokens = estimateTokens(omittedChars);
  const totalTokens = estimateTokens(originalChars);

  let hint;
  if (toolName === 'read_file') {
    const target = params?.path || 'file';
    hint = ` Path: ${target}. For more, request a specific line range or grep for the exact pattern you need.`;
  } else if (toolName === 'execute_command') {
    hint = ' Re-run the command with a tighter filter (head/tail, grep, --quiet) if the truncated portion mattered.';
  } else if (toolName === 'list_files') {
    hint = ' Re-list with a more specific path or recursive=false to narrow the result.';
  } else if (toolName === 'use_mcp_tool') {
    hint = ' Re-call with narrower arguments if the truncated portion was relevant.';
  } else {
    hint = '';
  }

  const middle = tailLen > 0 ? 'middle' : 'tail';
  return `\n\n[…truncated ${middle}: ${omittedChars.toLocaleString()} chars / ~${omittedTokens.toLocaleString()} tokens omitted (full result was ${originalChars.toLocaleString()} chars / ~${totalTokens.toLocaleString()} tokens). Showing first ${headLen.toLocaleString()}${tailLen > 0 ? ` + last ${tailLen.toLocaleString()}` : ''} chars.${hint}]\n\n`;
}

// Tools where the END of the output also matters (compile error at the bottom,
// last line of a file, the actual command exit code message). For these, head
// + tail truncation. For tools where output is mostly enumerative (list_files,
// MCP enumerations), head-only is fine.
const HEAD_AND_TAIL_TOOLS = new Set(['read_file', 'execute_command']);

/**
 * Truncate a tool result to fit a chars budget, preserving information.
 *
 * @param {object} args
 * @param {string} args.toolName - tool that produced the result
 * @param {object} args.params - tool params (used for hint personalization)
 * @param {string} args.resultText - raw result text
 * @param {number} [args.maxChars] - cap (default 32K chars / ~8K tokens)
 * @returns {{ text: string, truncated: boolean, originalChars: number, originalTokens: number }}
 */
export function truncateToolResult({ toolName, params, resultText, maxChars }) {
  const cap = resolveMaxChars(maxChars);
  const text = String(resultText ?? '');
  const length = text.length;
  const originalTokens = estimateTokens(length);

  // Passthrough: under cap.
  if (length <= cap) {
    return { text, truncated: false, originalChars: length, originalTokens };
  }

  // Errors are small + critical. Even if a synthetic ERROR: result somehow
  // exceeded the cap, brutal truncation preserves the head which is what
  // the model needs to diagnose. Don't waste budget on a marker.
  if (text.startsWith('ERROR:')) {
    return { text: text.slice(0, cap), truncated: true, originalChars: length, originalTokens };
  }

  // Reserve space for the marker. ~250 chars is enough for the longest
  // marker variant (read_file with a long path).
  const markerReserve = 250;
  const budget = Math.max(cap - markerReserve, Math.floor(cap * 0.9));

  if (HEAD_AND_TAIL_TOOLS.has(toolName)) {
    const headLen = Math.floor(budget * HEAD_FRACTION);
    const tailLen = budget - headLen;
    const head = text.slice(0, headLen);
    const tail = text.slice(-tailLen);
    const marker = buildTruncationMarker(toolName, params, length, head.length, tail.length);
    return { text: head + marker + tail, truncated: true, originalChars: length, originalTokens };
  }

  // Head-only for everything else.
  const head = text.slice(0, budget);
  const marker = buildTruncationMarker(toolName, params, length, head.length, 0);
  return { text: head + marker, truncated: true, originalChars: length, originalTokens };
}
