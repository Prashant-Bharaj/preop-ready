/**
 * Tool dispatcher + shared utilities for the custom agent.
 *
 * - Owns the TOOL_MAP registry that wires tool names to handler implementations
 *   (handlers live in file-tools.js / exec-tools.js / phase-tools.js /
 *   workflow-tools.js).
 * - Exposes dispatchTool (called from agent.js loop), KNOWN_TOOL_NAMES, and
 *   isToolConcurrencySafe (controls per-turn parallel-batching).
 * - Hosts sandbox helpers consumed across the domain files: sandboxPath
 *   (path-traversal guard for WORKSPACE_DIR), relFromWorkspace, and
 *   makeToolEventPayload (Cline-shaped `say: 'tool'` events for the frontend).
 */

import path from 'node:path';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { resolveWorkspacePath, PathEscapeError } from './util/resolve-path.js';
import {
  toolReadFile,
  toolWriteToFile,
  toolCopyTemplate,
  toolReplaceInFile,
  toolListFiles,
} from './file-tools.js';
import { toolExecuteCommand, toolUseMcpTool } from './exec-tools.js';
import {
  toolSpawnPhaseAgent,
  toolSpawnPhaseAgentBackground,
  toolCheckPhaseAgent,
  toolCancelPhaseAgent,
  toolInjectPhaseMessage,
} from './phase-tools.js';
import { toolTaskProgress, toolAttemptCompletion } from './workflow-tools.js';
import { toolWriteHarnessState } from './write-harness-state.js';
import { toolReadHarnessState } from './read-harness-state.js';
import { toolReadContainerLogs } from './read-container-logs.js';

/**
 * Ensure a path stays inside the workspace sandbox. Back-compat alias —
 * delegates to W1.PATH's `resolveWorkspacePath` so there's exactly one
 * resolution rule. Callers that have access to ctx should call
 * `resolveWorkspacePath` directly via `ctx.workspaceDir` (so the
 * dispatcher can override workspace root per session in future); the
 * module-level WORKSPACE_DIR fallback keeps existing helpers + tests
 * working without a signature change.
 *
 * Returns the absolute resolved path or throws.
 */
export function sandboxPath(relOrAbs) {
  try {
    return resolveWorkspacePath(relOrAbs, { workspaceDir: WORKSPACE_DIR });
  } catch (err) {
    if (err instanceof PathEscapeError) {
      // Preserve the legacy error shape exactly so any test/caller that
      // matches the previous string still works.
      throw new Error(`Path escapes workspace: ${relOrAbs}`);
    }
    throw err;
  }
}

export function relFromWorkspace(abs) {
  return path.relative(WORKSPACE_DIR, abs) || '.';
}

/**
 * Format a file-op event for the frontend — matches Cline's `say: 'tool'`
 * shape so [MessageBubble.jsx] can render it without changes.
 */
export function makeToolEventPayload(tool, extras = {}) {
  return {
    say: 'tool',
    text: JSON.stringify({ tool, ...extras }),
  };
}

// ── Dispatcher ──

const TOOL_MAP = {
  read_file:                    toolReadFile,
  write_to_file:                toolWriteToFile,
  copy_template:                toolCopyTemplate,
  replace_in_file:              toolReplaceInFile,
  list_files:                   toolListFiles,
  execute_command:              toolExecuteCommand,
  use_mcp_tool:                 toolUseMcpTool,
  task_progress:                toolTaskProgress,
  attempt_completion:           toolAttemptCompletion,
  // W1.STATE — .harness/ project memory (Section A + D of HARNESS_EVOLUTION.md).
  // Orchestrator calls write_harness_state before attempt_completion; the
  // router (Phase 2) + subagents (Phase 4 H) call read_harness_state on
  // iteration spawns. Phase whitelisting will pin these to the appropriate
  // PHASES in chat/server/agent/loop/phase.js as Phase 1 lands; for now they
  // are available to whichever agent loop runs.
  write_harness_state:          toolWriteHarnessState,
  read_harness_state:           toolReadHarnessState,
  // W3.LOGS — read-only docker-compose log fetch for the investigator agent
  // (HARNESS_EVOLUTION.md §B). PHASES whitelist gating happens in
  // chat/server/agent/loop/phase.js (W3.INVEST's wiring); checkPermissions
  // here always allows (read-only).
  read_container_logs:          toolReadContainerLogs,
  // Part B — orchestrator-only (PHASES.ORCHESTRATING whitelist gates these):
  spawn_phase_agent:            toolSpawnPhaseAgent,
  spawn_phase_agent_background: toolSpawnPhaseAgentBackground,
  check_phase_agent:            toolCheckPhaseAgent,
  cancel_phase_agent:           toolCancelPhaseAgent,
  inject_phase_message:         toolInjectPhaseMessage,
};

/**
 * Execute a tool call from the XML parser.
 *
 * @param {string} name - Tool name (e.g. "write_to_file").
 * @param {object} params - Parsed params from the parser.
 * @param {object} ctx - { emit(event), signal }
 * @returns {Promise<string|null>} - Result string for the model, or null if terminal (attempt_completion).
 */
export async function dispatchTool(name, params, ctx) {
  const handler = TOOL_MAP[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(params, ctx);
}

/**
 * Look up the `checkPermissions(params, ctx) → { verdict, reason }`
 * callback for a tool, if it exposes one. Returns null when the tool has
 * no permission gate (read-only tools, harness-internal writers).
 *
 * The dispatcher in agent.js calls this BEFORE running `dispatchTool` —
 * a `deny` verdict short-circuits dispatch and emits the deny message
 * as the tool result.
 */
export function getToolPermissionChecker(name) {
  const handler = TOOL_MAP[name];
  if (!handler || typeof handler.checkPermissions !== 'function') return null;
  return handler.checkPermissions;
}

export const KNOWN_TOOL_NAMES = Object.keys(TOOL_MAP);

// ── Concurrency-safety classification ──
// Mirrors Claude Code's `tool.isConcurrencySafe(input)` predicate
// (see ../../../../claude-code-main/src/services/tools/toolOrchestration.ts).
// Read-only tools may run in parallel within a single turn; mutating tools
// always run serially. Conservative default: anything not listed is unsafe.
//
// `use_mcp_tool` is safe because the only registered MCP server
// ("platform-tools") exposes only read-only handlers (get_rules, get_snippet,
// list_snippets, search_snippets, resolve_context, read_project_status,
// get_environment — see ../mcp/handlers.js). If a mutating MCP tool is ever
// added, gate by tool_name here.
const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'list_files',
  'use_mcp_tool',
  'read_harness_state',
  'read_container_logs',
]);

export function isToolConcurrencySafe(name) {
  return CONCURRENCY_SAFE_TOOLS.has(name);
}
