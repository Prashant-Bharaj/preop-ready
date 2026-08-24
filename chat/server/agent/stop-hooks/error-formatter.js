/**
 * Tool-error reformatting (Track B item B4).
 *
 * Replaces the procedural "SUPPRESSED attempt_completion — N tool error(s) in
 * same batch; forcing another turn" prose that the model treats as noise. The
 * new style is directive: name what failed, why it likely failed, and what
 * to do next. Modeled on Claude Code's formatZodValidationError pattern
 * (utils/toolErrors.ts:66-132) — surface the actionable bit, not the raw
 * stack.
 *
 * Two exports:
 *   - formatToolError(toolName, rawError) → string directive for ONE tool
 *     error, used inside per-tool error blocks.
 *   - composeBlockingMessage(validatorResults) → user-message string for the
 *     stop-hook to inject when one or more validators block. Replaces the
 *     four ad-hoc errorNotice templates that used to live in agent.js.
 */

const HEAD_FRACTION = 0.7;
const TRUNCATION_THRESHOLD = 10_000;

/**
 * Head+tail truncation for oversize error payloads. Mirrors result-truncate's
 * 70/30 split — the head usually has the actual failure line; the tail often
 * has the trailing context the model needs to recover.
 */
function truncateError(snippet, maxChars = TRUNCATION_THRESHOLD) {
  if (!snippet || snippet.length <= maxChars) return snippet || '';
  const headLen = Math.floor(maxChars * HEAD_FRACTION);
  const tailLen = maxChars - headLen - 32; // 32 chars for the elision marker
  const head = snippet.slice(0, headLen);
  const tail = snippet.slice(-tailLen);
  return `${head}\n\n[... ${snippet.length - headLen - tailLen} chars elided ...]\n\n${tail}`;
}

/**
 * Per-tool directive hints. Each entry maps a tool name to a function that
 * receives the truncated error snippet and returns a one-line "try X" hint.
 * Default (any tool not listed): generic "review the error and retry with
 * different inputs".
 */
const TOOL_HINTS = {
  read_file: (s) => /not found|ENOENT|no such file/i.test(s)
    ? 'Confirm the path with list_files before retrying.'
    : 'Review the error and adjust the path.',
  write_to_file: (s) => /parse|invalid|malformed/i.test(s)
    ? 'Check the <content> block is closed and free of stray XML.'
    : 'Review the error; the directory may not exist or be writable.',
  replace_in_file: (s) => /search.*not.*match|no match|did not match/i.test(s)
    ? 'The SEARCH text did not match any region of the file. read_file the target first to copy the exact bytes.'
    : 'Review the diff; the SEARCH region needs to match byte-for-byte.',
  execute_command: (s) => /exit code: [1-9]/.test(s)
    ? 'The command returned non-zero. Read the stderr above and try a corrected command.'
    : 'The command failed before producing output; check the binary is on PATH.',
  use_mcp_tool: () => 'The MCP call failed; check the tool/server name and arguments.',
};

/**
 * Format a single tool failure into a directive line. The output is one
 * bullet per failure, suitable for inclusion inside a composed user message.
 *
 * @param {string} toolName
 * @param {string} pathOrCommand   Optional context (file path or command snippet)
 * @param {string} rawError        Raw error text from the tool dispatch
 */
export function formatToolError(toolName, pathOrCommand, rawError) {
  const snippet = truncateError(String(rawError || '').replace(/\n/g, ' ').trim());
  const where = pathOrCommand ? ` (${pathOrCommand})` : '';
  const hintFn = TOOL_HINTS[toolName] || (() => 'Review the error and retry with adjusted inputs.');
  const hint = hintFn(snippet);
  return `- ${toolName}${where}: ${snippet.slice(0, 240)}\n  ${hint}`;
}

/**
 * Compose the user-message text the stop-hook injects when one or more
 * validators block. Each validator result contributes its own directive
 * block; this function joins them with a single short header that names
 * what's wrong and what to do.
 *
 * @param {Array<{ name: string, blocking: boolean, directive: string, header?: string, footer?: string }>} results
 * @returns {string} the directive user message
 */
export function composeBlockingMessage(results) {
  const blocking = results.filter((r) => r && r.blocking);
  if (blocking.length === 0) return '';
  if (blocking.length === 1) {
    const r = blocking[0];
    const parts = [];
    if (r.header) parts.push(r.header);
    parts.push(r.directive);
    if (r.footer) parts.push(r.footer);
    return parts.filter(Boolean).join('\n\n') + '\n\n';
  }
  // Multiple validators blocked simultaneously — list each as its own
  // section. Order is the order the stop-hook ran them in.
  const sections = blocking.map((r) => {
    const parts = [];
    if (r.header) parts.push(r.header);
    parts.push(r.directive);
    if (r.footer) parts.push(r.footer);
    return parts.filter(Boolean).join('\n');
  });
  return [
    `Your attempt_completion didn't land. ${blocking.length} validators flagged issues that need a fix before you finalize:`,
    '',
    ...sections,
  ].join('\n') + '\n\n';
}
