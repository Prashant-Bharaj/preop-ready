/**
 * Per-scenario / per-phase persistent run logs.
 *
 * Step 7c — replaces the global `/tmp/llm-calls.log` (which gets wiped on
 * reboot and mixes all scenarios + phases into a single file) with a
 * structured tree.
 *
 * **Layout (W1.TEL / Section M item 5 — unified sessionId path):**
 *
 *   chat/server/agent/run-logs/
 *     <sessionId>/                  e.g. "ab12-cd34-…"  (preferred — set by runCustomAgent)
 *       meta.json                   { scenarioId?, runTimestamp?, workspaceDir?, firstWriteAt }
 *       <phase>/                    e.g. SUBAGENT, ORCHESTRATING, JUDGE, PROMPT_WRITER
 *         llm-calls.jsonl           one line per request + one per response
 *         tool-calls.jsonl          one line per tool dispatch
 *
 * **Legacy layout (still written when sessionId is unknown):**
 *
 *   chat/server/agent/run-logs/
 *     <scenarioId>/<runTimestamp>/<phase>/llm-calls.jsonl
 *
 * Pre-W1.TEL run-logs dirs continue to live under their legacy paths and
 * remain readable (we don't migrate or rewrite history).
 *
 * **Scenario derivation:** the smoke harness sets `WORKSPACE_DIR` to a
 * path like `/var/folders/.../custom-agent-smoke-mscope-<scenarioId>-<timestamp>`.
 * We extract `<scenarioId>` and `<timestamp>` from the basename and stash
 * them in `meta.json` (now optional metadata, not the path key).
 *
 * **No-op safety:** if the runContext is missing or file write fails,
 * every public function returns silently. Logging must never break a run.
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Module-relative location for the run-logs directory. This file lives at
// chat/server/agent/compaction/run-logger.js, so logs go to chat/server/agent/run-logs/
// (one level up). The run-logs/ dir is intentionally kept at agent/ root —
// see R.1 LANDED entry in docs/cleanup/CLEANUP_PLAN.md.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_LOGS_BASE = path.join(__dirname, '..', 'run-logs');

/**
 * Parse the workspace path into a stable {scenarioId, runTimestamp} pair
 * the logger uses to organize per-scenario folders (legacy fallback) and
 * to populate the per-session `meta.json` sidecar.
 *
 * Smoke workspace shape:
 *   .../custom-agent-smoke-mscope-<scenarioId>-<unixMs>
 *
 * Real-user / single-scope smoke workspace:
 *   .../custom-agent-smoke-<unixMs>             (no scenario)
 *   any other path                               (manual sessions)
 *
 * Returns null when no useful organization key can be derived. Callers
 * (notably runCustomAgent) typically enrich the returned object with
 * `sessionId` before passing it on — see attachSessionId() below.
 */
export function deriveRunContext(workspaceDir) {
  if (!workspaceDir) return null;
  const base = path.basename(workspaceDir);
  // Multi-scope smoke: custom-agent-smoke-mscope-<scenarioId>-<timestamp>
  const mscope = base.match(/^custom-agent-smoke-mscope-(.+)-(\d{10,})$/);
  if (mscope) {
    return { scenarioId: mscope[1], runTimestamp: mscope[2], workspaceDir };
  }
  // Single-scope smoke or smoke parent dir
  const singleScope = base.match(/^custom-agent-smoke-(\d{10,})$/);
  if (singleScope) {
    return { scenarioId: 'single-scope', runTimestamp: singleScope[1], workspaceDir };
  }
  // Fallback: use the basename itself, mark as "manual" run.
  return { scenarioId: base, runTimestamp: 'manual', workspaceDir };
}

/**
 * Return a new runContext with `sessionId` attached. Pure helper so
 * callers (runCustomAgent) can do
 *   const runContext = attachSessionId(deriveRunContext(WORKSPACE_DIR), sessionId);
 * without mutating shared state. Null-safe.
 */
export function attachSessionId(runContext, sessionId) {
  if (!runContext) return sessionId ? { sessionId } : null;
  if (!sessionId) return runContext;
  return { ...runContext, sessionId };
}

/**
 * Resolve the directory for a single phase's logs. When the runContext
 * carries a sessionId we use the new unified layout
 *   run-logs/<sessionId>/<phase>/
 * Otherwise we fall back to the legacy
 *   run-logs/<scenarioId>/<runTimestamp>/<phase>/
 * so calls from outside runCustomAgent (judge, prompt-writer) still log
 * under the per-scenario folder until those paths thread sessionId.
 */
function logDir(runContext, phase) {
  if (!runContext) return null;
  if (runContext.sessionId) {
    return path.join(RUN_LOGS_BASE, runContext.sessionId, phase || 'unknown');
  }
  if (!runContext.scenarioId) return null;
  return path.join(
    RUN_LOGS_BASE,
    runContext.scenarioId,
    runContext.runTimestamp || 'unknown',
    phase || 'unknown',
  );
}

/**
 * Write the per-session meta.json sidecar once (idempotent — only writes
 * if the file doesn't already exist). Records scenarioId / runTimestamp /
 * workspaceDir so the per-session folder retains its scenario tag for
 * aggregation (the path no longer encodes it directly).
 */
function ensureSessionMeta(runContext) {
  if (!runContext || !runContext.sessionId) return;
  try {
    const sessionDir = path.join(RUN_LOGS_BASE, runContext.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const metaPath = path.join(sessionDir, 'meta.json');
    const meta = {
      sessionId: runContext.sessionId,
      scenarioId: runContext.scenarioId || null,
      runTimestamp: runContext.runTimestamp || null,
      workspaceDir: runContext.workspaceDir || null,
      firstWriteAt: new Date().toISOString(),
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), { flag: 'wx' });
  } catch {
    // Best-effort sidecar — failure must not crash logging.
  }
}

/**
 * Append a structured entry for a single LLM request or response.
 *
 * @param {object} args
 * @param {object} args.runContext       - { scenarioId, runTimestamp } from deriveRunContext()
 * @param {string} args.phase            - PhaseStateMachine phase (EXECUTING / SUBAGENT / ORCHESTRATING)
 * @param {string} [args.scope]          - Optional sub-scope (e.g., a per-scope phase agent)
 * @param {'request'|'response'} args.kind
 * @param {string} args.assistant        - MGA assistant ID
 * @param {string|null} args.conversationId
 * @param {object} [args.body]           - For kind='request': the full body sent to MGA
 * @param {string} [args.content]        - For kind='response': the full assistant response
 * @param {object} [args.usage]          - For kind='response': MGA usage block
 * @param {string} [args.ts]             - ISO timestamp; defaults to now
 */
export function recordLlmCall(args) {
  const { runContext, phase, kind } = args;
  // Need either a sessionId (new layout) or a scenarioId (legacy layout).
  if (!runContext || (!runContext.sessionId && !runContext.scenarioId)) return;
  if (!kind || (kind !== 'request' && kind !== 'response')) return;
  const dir = logDir(runContext, phase);
  if (!dir) return;
  const entry = {
    ts: args.ts || new Date().toISOString(),
    kind,
    assistant: args.assistant || null,
    scope: args.scope || null,
    conversationId: args.conversationId || null,
  };
  if (kind === 'request' && args.body) {
    const bodyJson = JSON.stringify(args.body);
    entry.bodyLen = bodyJson.length;
    entry.body = args.body;
  }
  if (kind === 'response') {
    entry.contentLen = (args.content || '').length;
    entry.content = args.content || '';
    entry.usage = args.usage || null;
    // W1.TEL Section M items 1 + 2: per-call latency + cost. Set by llm.js
    // when the call completes; absent on errored calls.
    if (typeof args.latencyMs === 'number') entry.latencyMs = args.latencyMs;
    if (args.costUsd !== undefined) entry.costUsd = args.costUsd; // may be null for unknown models
    if (args.model) entry.model = args.model;
  }
  try {
    ensureSessionMeta(runContext);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'llm-calls.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break a run.
  }
}

/**
 * Append a structured entry for a single tool dispatch.
 *
 * @param {object} args
 * @param {object} args.runContext
 * @param {string} args.phase
 * @param {string} [args.scope]
 * @param {string} args.toolName       - 'write_to_file', 'execute_command', 'use_mcp_tool', etc.
 * @param {object} args.params         - Raw tool params
 * @param {string|object} [args.result] - Tool result (truncated at 5000 chars for storage)
 * @param {boolean} [args.errored]      - Whether the tool call returned an error
 * @param {string} [args.ts]
 */
export function recordToolCall(args) {
  const { runContext, phase, toolName } = args;
  if (!runContext || (!runContext.sessionId && !runContext.scenarioId)) return;
  if (!toolName) return;
  const dir = logDir(runContext, phase);
  if (!dir) return;
  let resultStr;
  if (typeof args.result === 'string') {
    resultStr = args.result.slice(0, 5000);
  } else if (args.result != null) {
    try { resultStr = JSON.stringify(args.result).slice(0, 5000); } catch { resultStr = '<unstringifiable>'; }
  } else {
    resultStr = null;
  }
  const entry = {
    ts: args.ts || new Date().toISOString(),
    toolName,
    scope: args.scope || null,
    params: args.params || null,
    result: resultStr,
    errored: !!args.errored,
  };
  try {
    ensureSessionMeta(runContext);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'tool-calls.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break a run.
  }
}

/**
 * Return the absolute base directory for a session's run-logs, or null if
 * we can't resolve one. Used by run-summary aggregation to sweep through
 * llm-calls.jsonl files for total cost / token rollups.
 */
export function getSessionRunLogsDir(sessionId) {
  if (!sessionId) return null;
  return path.join(RUN_LOGS_BASE, sessionId);
}

export const __test = { RUN_LOGS_BASE };
