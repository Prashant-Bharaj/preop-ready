/**
 * ToolResultCompactor — Phase 2a: Microcompact layer.
 *
 * Purpose: prevent redundant `read_file` results from entering MGA's stored
 * history on re-reads of paths the model has already interacted with in
 * the current run (either by reading OR by writing). The model sees a
 * compact stub pointing at its prior access; MGA stores the stub, not a
 * verbose duplicate.
 *
 * This directly targets the verify-theater pattern observed across
 * Tests 1-3: model writes a file, then re-reads it next turn to "verify"
 * the edit. The re-read returns content the model already produced. The
 * stub short-circuits that at dispatch time.
 *
 * One cache, two populating events: `recordRead` (after a successful
 * read_file) and `recordWrite` (after a successful write_to_file /
 * replace_in_file). Both mark the path as "model already knows this
 * content" — so a subsequent `read_file` on that path returns the stub.
 *
 * Mtime-aware invalidation (Track C item C3): each cache entry stores
 * the file's mtimeMs at record time. On re-read, we statSync(path) and
 * compare against the stored mtime. If unchanged → stub. If advanced
 * (an `execute_command` rewrote the file, a continuation-mode session
 * inherited stale state, etc.) → drop the cache entry and let a fresh
 * dispatch happen. If the file is gone → drop the entry and let
 * dispatch surface the real ENOENT.
 *
 * Safety:
 *   - The stub replaces dispatch entirely; we don't touch disk.
 *   - `invalidatePath` is preserved for future cases where we do need
 *     to evict a cache entry (not currently used).
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../../core/paths.js';

const STUB_PREFIX = '[Old tool result content cleared';

// Fetch mtimeMs for a workspace-relative path. Returns null on missing
// file, sandbox escape, or any stat error — callers treat null as "drop
// the cache entry and let real dispatch happen".
function safeMtimeMs(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  try {
    const abs = path.resolve(WORKSPACE_DIR, relPath);
    const rel = path.relative(WORKSPACE_DIR, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return statSync(abs).mtimeMs;
  } catch {
    return null;
  }
}

// MCP tools whose results are immutable within a single agent run. Repeat
// calls to these with identical args return the same payload, so a second
// call is pure waste — the model already has the result in its history.
// Populated empirically from Test 1's regression: the model re-called
// get_rules and list_snippets on turn 5 after writing files on turn 3,
// despite the result being identical to its turn-2 call. Rules and snippets
// are platform-owned, user can't mutate them mid-run, so dedup is safe.
// Intentionally excluded: read_project_status (model could write to the
// status file mid-run), get_environment (scope folders could be created),
// search_snippets / resolve_context (deterministic but caching a
// non-exploratory call adds little value and complicates logic).
const CACHEABLE_MCP_TOOLS = new Set(['get_rules', 'get_snippet', 'list_snippets']);

export class MicrocompactCache {
  constructor() {
    this.pathToLastTouch = new Map();
    this.mcpCallCache = new Map(); // signature → { turnIndex, mcpToolName }
    this.stubCount = 0;
  }

  /**
   * Decide whether to substitute a stub for this tool call. Returns
   * { replaced: false } to proceed with normal dispatch, or
   * { replaced: true, result } to short-circuit with the stub as the
   * tool result.
   */
  maybeStub(toolName, params, _currentTurn) {
    // read_file dedup intentionally disabled (2026-05-21).
    //
    // The stub assumed the model could rely on prior-turn memory of file
    // content. Empirically it cannot: after a turn-1 write, the LLM
    // hallucinates SEARCH blocks for `replace_in_file` from training-data
    // muscle memory ("router.post(...)") rather than from what it actually
    // wrote ("app.post(...)") — the stub reinforces that false confidence
    // by telling the LLM "you have this content already". Cost of re-reads
    // is bounded (~5KB per re-read, well within MGA's 200K window); benefit
    // is eliminating SEARCH-mismatch retry storms.
    //
    // recordRead/recordWrite still fire (callers in agent.js); the cache
    // entries remain for stats/telemetry + future re-enable if needed.
    // MCP dedup below stays — get_rules/get_snippet/list_snippets are
    // genuinely immutable within a run.
    if (toolName === 'read_file') return { replaced: false };

    // MCP re-call dedup for immutable tools.
    if (toolName === 'use_mcp_tool') {
      const mcpName = params?.tool_name;
      if (!CACHEABLE_MCP_TOOLS.has(mcpName)) return { replaced: false };
      const args = String(params?.arguments ?? '');
      const sig = `${mcpName}::${args}`;
      const prev = this.mcpCallCache.get(sig);
      if (!prev) return { replaced: false };
      this.stubCount += 1;
      return {
        replaced: true,
        result:
          `${STUB_PREFIX} — you already called ${mcpName}(${args}) at turn ${prev.turnIndex + 1}. ` +
          `Platform rules and snippets are immutable within a run — the result hasn't changed. ` +
          `Refer to the earlier turn's output. If your task's writes are done, emit attempt_completion. ` +
          `Do not re-fetch rules/snippets you've already loaded.]`,
      };
    }

    return { replaced: false };
  }

  recordRead(toolName, params, resultLength, turnIndex) {
    if (toolName !== 'read_file') return;
    const p = params?.path;
    if (!p) return;
    this.pathToLastTouch.set(p, {
      kind: 'read',
      turnIndex,
      resultLength,
      mtimeMs: safeMtimeMs(p),
    });
  }

  recordWrite(filePath, turnIndex) {
    if (!filePath) return;
    this.pathToLastTouch.set(filePath, {
      kind: 'write',
      turnIndex,
      resultLength: 0,
      mtimeMs: safeMtimeMs(filePath),
    });
  }

  /**
   * Record a successful use_mcp_tool call for one of the cacheable MCP tools.
   * Subsequent identical calls (same mcp tool name + same args string) will
   * be stubbed at dispatch. Non-cacheable MCP tools are silently ignored.
   */
  recordMcpCall(params, turnIndex) {
    const mcpName = params?.tool_name;
    if (!CACHEABLE_MCP_TOOLS.has(mcpName)) return;
    const args = String(params?.arguments ?? '');
    const sig = `${mcpName}::${args}`;
    this.mcpCallCache.set(sig, { turnIndex, mcpToolName: mcpName });
  }

  invalidatePath(path) {
    if (!path) return;
    this.pathToLastTouch.delete(path);
  }

  getStats() {
    return {
      stubCount: this.stubCount,
      cachedPaths: [...this.pathToLastTouch.keys()],
      cachedMcpCalls: [...this.mcpCallCache.keys()],
    };
  }
}
