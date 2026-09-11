/**
 * XML tool-call parser — ported from Cline's parseAssistantMessageV2.
 *
 * Source: https://github.com/cline/cline/blob/main/src/core/assistant-message/parse-assistant-message.ts
 * License: Apache 2.0 (see cline-derived/README.md)
 *
 * Parses a streamed assistant message into a sequence of text blocks and
 * tool-use blocks. Handles partial / still-streaming input — any block that
 * wasn't terminated by the end of the input is returned with `partial: true`.
 *
 * Adapted for our spike:
 *   - Plain ESM JavaScript (upstream is TypeScript)
 *   - Trimmed tool and param lists to the 6 tools we kept
 *   - call_id uses `crypto.randomUUID().slice(0,8)` instead of nanoid
 */

import { randomUUID } from 'node:crypto';

/** Names of the tool-use tags we recognise. */
export const TOOL_NAMES = [
  'read_file',
  'write_to_file',
  'replace_in_file',
  'list_files',
  'execute_command',
  'use_mcp_tool',
  'attempt_completion',
  'task_progress',
  // Harness-state + investigator read-only tools (handlers in
  // chat/server/agent/tools/{read,write}-harness-state.js + read-container-logs.js,
  // registered in core.js TOOL_MAP). Same parser-gap class as the spawn tools
  // below: missing here, the investigator's <read_harness_state> /
  // <read_container_logs> calls were classified as plain text, the runtime
  // emitted "no tool calls in response — nudging", and the agent stalled and
  // returned no_completion ("Investigation did not complete").
  'read_harness_state',
  'write_harness_state',
  'read_container_logs',
  // Part B — orchestrator-only spawn/coordinate tools (handlers in
  // chat/server/agent/tools/phase-tools.js, gated by PHASES.ORCHESTRATING in phase.js).
  // Missing here, the streamed orchestrator output containing
  // <spawn_phase_agent>...</spawn_phase_agent> was classified as plain text,
  // the runtime emitted "no tool calls in response — nudging", and the
  // orchestrator bailed on turn 2 with "infeasible / no task spec was
  // provided" — consistent with the parked-failure description from the
  // previous session's handoff.
  'spawn_phase_agent',
  'spawn_phase_agent_background',
  'check_phase_agent',
  'cancel_phase_agent',
  'inject_phase_message',
];

/** Names of the parameter tags we recognise (superset of what each tool uses). */
export const TOOL_PARAM_NAMES = [
  'path',
  'start_line',
  'end_line',
  'content',
  'diff',
  'recursive',
  'command',
  'requires_approval',
  'timeout',
  'server_name',
  'tool_name',
  'arguments',
  'result',
  'task_progress',
  // read_container_logs params (`scope` is already listed below).
  'service',
  'tail',
  'since',
  'until',
  // write_harness_state params.
  'state',
  'decision',
  'file_structure',
  // Part B spawn/coordinate tool params.
  'description',
  'scope',
  'task',
  'context',
  'task_id',
  'message',
  'budget_tokens',
];

/**
 * Decode XML/HTML entities in a param value. The model sometimes escapes
 * ampersands ("&" → "&amp;") to satisfy XML correctness, which then breaks
 * downstream consumers — e.g. shell commands with "&" backgrounding become
 * "&amp;" and the shell tries to run "amp" as a command.
 *
 * Skipped entirely for `content` (write_to_file body) and `diff`
 * (replace_in_file SEARCH/REPLACE block). Those carry verbatim file source
 * that must reach disk byte-for-byte — e.g. an HTML-escape map literally
 * containing `'&': '&amp;'`. Over-decoding there corrupts the file and
 * sends replace_in_file into an unfixable retry loop because the REPLACE
 * block also loses its entities.
 *
 * Kept minimal — the five named entities defined in the XML 1.0 spec plus
 * numeric character references. Nothing HTML-specific.
 */
function decodeEntities(s, paramName) {
  if (!s || typeof s !== 'string') return s;
  if (paramName === 'content' || paramName === 'diff') return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    // &amp; must be last, otherwise a literal "&amp;amp;" would over-decode.
    .replace(/&amp;/g, '&');
}

/**
 * Parse an assistant message string into a list of blocks.
 *
 * @param {string} assistantMessage - Full or partial assistant output.
 * @returns {Array<{type:'text',content:string,partial:boolean} |
 *                 {type:'tool_use',name:string,params:object,partial:boolean,call_id:string}>}
 */
export function parseAssistantMessage(assistantMessage) {
  const contentBlocks = [];

  let currentTextContentStart = 0;
  let currentTextContent;
  let currentToolUseStart = 0;
  let currentToolUse;
  let currentParamValueStart = 0;
  let currentParamName;

  const toolUseOpenTags = new Map();
  const toolParamOpenTags = new Map();
  for (const name of TOOL_NAMES) toolUseOpenTags.set(`<${name}>`, name);
  for (const name of TOOL_PARAM_NAMES) toolParamOpenTags.set(`<${name}>`, name);

  const len = assistantMessage.length;
  for (let i = 0; i < len; i++) {
    const currentCharIndex = i;

    // --- State: parsing a tool parameter value ---
    if (currentToolUse && currentParamName) {
      const closeTag = `</${currentParamName}>`;
      if (
        currentCharIndex >= closeTag.length - 1 &&
        assistantMessage.startsWith(closeTag, currentCharIndex - closeTag.length + 1)
      ) {
        const value = assistantMessage
          .slice(currentParamValueStart, currentCharIndex - closeTag.length + 1)
          .trim();
        currentToolUse.params[currentParamName] = decodeEntities(value, currentParamName);
        currentParamName = undefined;
      } else {
        continue;
      }
    }

    // --- State: inside a tool use, looking for a param or the closing tag ---
    if (currentToolUse && !currentParamName) {
      let startedNewParam = false;
      for (const [tag, paramName] of toolParamOpenTags.entries()) {
        if (
          currentCharIndex >= tag.length - 1 &&
          assistantMessage.startsWith(tag, currentCharIndex - tag.length + 1)
        ) {
          currentParamName = paramName;
          currentParamValueStart = currentCharIndex + 1;
          startedNewParam = true;
          break;
        }
      }
      if (startedNewParam) continue;

      const toolCloseTag = `</${currentToolUse.name}>`;
      if (
        currentCharIndex >= toolCloseTag.length - 1 &&
        assistantMessage.startsWith(toolCloseTag, currentCharIndex - toolCloseTag.length + 1)
      ) {
        const toolContentSlice = assistantMessage.slice(
          currentToolUseStart,
          currentCharIndex - toolCloseTag.length + 1,
        );

        // Special handling for write_to_file content (may contain nested XML-like
        // tags that the param parser would otherwise misinterpret).
        if (
          currentToolUse.name === 'write_to_file' &&
          toolContentSlice.includes('<content>')
        ) {
          const contentStart = toolContentSlice.indexOf('<content>');
          const contentEnd = toolContentSlice.lastIndexOf('</content>');
          if (contentStart !== -1 && contentEnd !== -1 && contentEnd > contentStart) {
            currentToolUse.params.content = decodeEntities(toolContentSlice
              .slice(contentStart + '<content>'.length, contentEnd)
              .trim(), 'content');
          }
        }

        currentToolUse.partial = false;
        contentBlocks.push(currentToolUse);
        currentToolUse = undefined;
        currentTextContentStart = currentCharIndex + 1;
        continue;
      }
      continue;
    }

    // --- State: parsing text / looking for a tool-use start tag ---
    if (!currentToolUse) {
      let startedNewTool = false;
      for (const [tag, toolName] of toolUseOpenTags.entries()) {
        if (
          currentCharIndex >= tag.length - 1 &&
          assistantMessage.startsWith(tag, currentCharIndex - tag.length + 1)
        ) {
          // Close out any in-progress text block first
          if (currentTextContent) {
            currentTextContent.content = assistantMessage
              .slice(currentTextContentStart, currentCharIndex - tag.length + 1)
              .trim();
            currentTextContent.partial = false;
            if (currentTextContent.content.length > 0) contentBlocks.push(currentTextContent);
            currentTextContent = undefined;
          } else {
            const potentialText = assistantMessage
              .slice(currentTextContentStart, currentCharIndex - tag.length + 1)
              .trim();
            if (potentialText.length > 0) {
              contentBlocks.push({ type: 'text', content: potentialText, partial: false });
            }
          }

          currentToolUse = {
            type: 'tool_use',
            name: toolName,
            params: {},
            partial: true,
            call_id: randomUUID().slice(0, 8),
          };
          currentToolUseStart = currentCharIndex + 1;
          startedNewTool = true;
          break;
        }
      }
      if (startedNewTool) continue;

      if (!currentTextContent) {
        currentTextContentStart = currentCharIndex;
        currentTextContent = { type: 'text', content: '', partial: true };
      }
    }
  }

  // --- Finalisation ---

  if (currentToolUse && currentParamName) {
    currentToolUse.params[currentParamName] = decodeEntities(assistantMessage
      .slice(currentParamValueStart)
      .trim(), currentParamName);
  }

  if (currentToolUse) {
    contentBlocks.push(currentToolUse);
  } else if (currentTextContent) {
    currentTextContent.content = assistantMessage.slice(currentTextContentStart).trim();
    if (currentTextContent.content.length > 0) contentBlocks.push(currentTextContent);
  }

  return contentBlocks;
}
