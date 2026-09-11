/**
 * Custom Agent — in-process replacement for Cline CLI.
 *
 * Loop:
 *   1. Build the turn's user message (task prompt on first call, or wrapped
 *      tool result on subsequent calls).
 *   2. Call the resolved MGA assistant via `callMgaCompletions`, streaming
 *      text deltas out to the UI as `say: 'text'` events.
 *   3. Parse the completed assistant output for XML tool calls.
 *   4. Execute each tool in order, emit matching UI events, collect results.
 *   5. If the model called `attempt_completion`, we're done — resolve.
 *      Otherwise, wrap the tool result(s) as the next user message and loop.
 *
 * State:
 *   - `conversationId` is owned by MGA. We pass it in, get it back, persist
 *     on the session so follow-up turns continue the same conversation.
 *   - No local message history — MGA stores it.
 *
 * Events emitted match the Cline event shapes consumed by the frontend (see
 * plan's "Event shapes" section). They go through `appendEvent` +
 * `sessionEvents.emit` exactly like Cline events, so the UI can't tell the
 * difference.
 */

import { existsSync, copyFileSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from '../session/transcript.js';
import { sessionEvents } from '../session/events.js';
import { redact } from '../util/redact.js';
import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow, logSafe } from '../util/log-helpers.js';
import { WORKSPACE_DIR } from '../core/paths.js';
import { callMgaCompletions, MgaLlmError } from './llm/llm.js';
import { composeAssistantPrompt } from './prompts/disk-prompt.js';
import { ASSISTANTS } from './prompts/manifest.js';
import { deriveRunContext, attachSessionId } from './compaction/run-logger.js';
import { parseAssistantMessage } from './cline-derived/xml-parser.js';
import { dispatchTool, isToolConcurrencySafe, getToolPermissionChecker } from './tools/core.js';
import { VirtualHistoryManager } from './compaction/history.js';
import { MicrocompactCache } from './compaction/compact.js';
import { SummarizerClient } from './compaction/summarizer.js';
import { CompactionTrigger, buildRotationUserMessage } from './compaction/triggers.js';
// maybeMicrocompact intentionally NOT imported — see comment at the
// removed call site (was around line 875). The module still exists in
// chat/server/agent/compaction/microcompact-iteration.js as dormant code
// for possible re-enable after a redesign that actually mutates history.
import { PhaseStateMachine, PHASES, resolvePhaseAssistant } from './loop/phase.js';
import { decideTool, toolSignature, GATHER_TOOLS } from './loop/permission-pipeline.js';
import { runStopHooks } from './stop-hooks/stop-hooks.js';
import { truncateToolResult } from './tools/result-truncate.js';
import { getCredentials } from '../core/auth.js';
import { MAX_FIX_ATTEMPTS_PER_SCOPE } from '../config/defaults.js';

const MAX_ITERATIONS = 30; // safety cap on the tool-call loop per turn (was 15; raised after t11/t39 backend agents legitimately needed >15 turns post-rotation)
const DEBUG = process.env.DEBUG_AGENT === '1';
const USE_COMPACTION = process.env.USE_COMPACTION === '1';

/** Debug logger — only logs when DEBUG_AGENT=1 is set. Use for content
 *  (LLM text, tool args, tool results) that we otherwise suppress. */
function dlog(...args) {
  if (!DEBUG) return;
  const ts = new Date().toTimeString().slice(0, 8);
  if (typeof args[0] === 'string') args[0] = `[${ts}][DEBUG] ${args[0]}`;
  console.log(...args);
}

/**
 * Detect MGA's "prompt is too long" error shape. MGA returns generic HTTP
 * (no typed error code), so we match status + message phrasing. Conservative
 * by design: better to miss a recoverable error and fall through to the
 * existing exit-1 path than to trigger a (relatively expensive) summarize
 * + retry on an unrelated 4xx (auth, missing assistant, malformed body).
 *
 * Phrases observed across LLM platforms:
 *   - OpenAI:    "This model's maximum context length is X tokens. However…"
 *   - Anthropic: "prompt is too long: X tokens > Y maximum"
 *   - Generic:   "input exceeds context window", "too many tokens"
 */
/**
 * Trim `cache_control` markers from older assistant messages so we stay under
 * Anthropic's 4-breakpoints-per-request cap. The system message at index 0
 * always keeps its cache_control (most stable prefix); the most-recent N
 * assistants keep theirs; older ones get demoted to plain string content
 * (cache_control stripped).
 *
 * Mutates `messages` in place. Idempotent.
 *
 * The "demoted" entries don't lose their text — we just unwrap the
 * content-block array back to a string. That keeps the wire shape simple
 * and matches how we push regular user/assistant turns.
 */
function _trimCompletionsBreakpoints(messages, keepLastNAssistants) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  // Collect indices of assistant messages that currently have a cache_control
  // marker (content is an array with at least one block carrying cache_control).
  const cachedAssistantIndices = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (!Array.isArray(m.content)) continue;
    const hasCc = m.content.some(b => b && b.cache_control);
    if (hasCc) cachedAssistantIndices.push(i);
  }
  // Keep the last N; demote any older ones.
  const toDemote = cachedAssistantIndices.slice(0, Math.max(0, cachedAssistantIndices.length - keepLastNAssistants));
  for (const i of toDemote) {
    const m = messages[i];
    // Collapse content-block array back to a plain string. Safe because we
    // only added a single text block with cache_control when we wrapped it.
    const textBlock = m.content.find(b => b && b.type === 'text');
    messages[i] = { role: 'assistant', content: textBlock?.text || '' };
  }
}

function isPromptTooLongError(err) {
  if (!err || err.name !== 'MgaLlmError') return false;
  const status = err.status;
  // Common "request too large" status codes. Skip 401 (auth), 429 (rate
  // limit), 5xx (server) — those won't be helped by rotation.
  if (status !== 400 && status !== 413 && status !== 422) return false;
  const msg = String(err.message || '').toLowerCase();
  return /(prompt|input|message|messages)\s+(is|are)\s+too\s+long|context\s+(length|window)|token\s+limit|exceeds?\s+(max|maximum)|too\s+many\s+tokens|maximum\s+context|reduce\s+the\s+(prompt|input|message)/.test(msg);
}

/**
 * Safety net for missed Dockerfile writes. The scope rules instruct the
 * Coder to use `copy_template(template="Dockerfile.<lang>", dest="<scope>/Dockerfile")`,
 * which resolves from `snippets/<scope>/`, but the model often batches
 * multiple write_to_file calls and skips the copy step — producing a
 * project that can't docker-compose build. Rather than rely purely on
 * prompt discipline we fill the gap deterministically here, sourcing the
 * canonical template from `snippets/<scope>/Dockerfile.<lang>` and copying
 * it to `<scope>/Dockerfile`. Logged so the action is visible.
 * tryAutoStartApp's deterministic file-existence validators do the same at
 * session boundary; this extends the safety net to single-scope paths.
 *
 * Template choice is evidence-driven from what the Coder actually wrote:
 *   backend + *.ts/*.js files → Dockerfile.node (.ts canonical post-
 *     W1.PATHS.CANONICAL; .js kept as a tolerant fallback for old workspaces)
 *   backend + *.py files → Dockerfile.python
 *   backend + *.rs files → Dockerfile.rust
 *   frontend + jsx/tsx/vite.config → Dockerfile.react
 *   database (always) → Dockerfile.postgres (stack narrowed to Postgres-only
 *     in W2.NARROW; MySQL branch retired)
 *   vectordb (always) → Dockerfile.pgvector (stack narrowed to pgvector-only
 *     in W2.NARROW; Chroma + Qdrant branches retired)
 *
 * Why extend to db + vectordb (2026-05-09 t32 observation): vectordb agent
 * skipped the copy step entirely, jumped straight to replace_in_file on a
 * file that didn't exist, then hallucinated "complete" status. database
 * agent in t32 v2/v3 had similar issues. The prompt update telling agents
 * to use copy_template helps, but LLM priors override one-line nudges
 * inconsistently. Auto-fill is the deterministic safety net.
 *
 * No-op when scope=null, when the Dockerfile already exists, or when the
 * template file is missing on disk. The `prompt` arg is preserved in the
 * signature for backward compatibility with call sites (formerly used to
 * read VECTOR ENGINE for vectordb engine choice — now unused since the
 * vectordb template is hardcoded to pgvector).
 */
function ensureScopeDockerfile(scope, writtenPaths, emit, logScope, _prompt = null) {
  if (!scope || !['backend', 'frontend', 'database', 'vectordb'].includes(scope)) return null;
  const dockerfileRel = `${scope}/Dockerfile`;
  const dockerfileAbs = path.join(WORKSPACE_DIR, dockerfileRel);
  if (existsSync(dockerfileAbs)) return null;

  const written = [...writtenPaths];
  let template = null;
  if (scope === 'backend') {
    // Recognize both .ts (canonical post-W1.PATHS.CANONICAL) and .js (legacy
    // workspaces / agents that drift back to JS) as Node signals — the
    // tolerant pre-Phase-1 stance. .py and .rs remain language signals.
    if (written.some((p) => p.endsWith('.ts') || p.endsWith('.js'))) template = 'Dockerfile.node';
    else if (written.some((p) => p.endsWith('.py'))) template = 'Dockerfile.python';
    else if (written.some((p) => p.endsWith('.rs'))) template = 'Dockerfile.rust';
  } else if (scope === 'frontend') {
    if (written.some((p) => /\.(jsx|tsx)$|vite\.config/.test(p))) template = 'Dockerfile.react';
  } else if (scope === 'database') {
    // Stack narrowed to Postgres-only (W2.NARROW). Dormant MySQL branch
    // dropped — no more my.cnf / .mysql.sql sniff. Database scope always
    // gets Dockerfile.postgres.
    template = 'Dockerfile.postgres';
  } else if (scope === 'vectordb') {
    // Stack narrowed to pgvector-only (W2.NARROW). Dormant Chroma + Qdrant
    // branches dropped — no more VECTOR ENGINE parse, no engine allowlist.
    // Vectordb scope always gets Dockerfile.pgvector.
    template = 'Dockerfile.pgvector';
  }
  if (!template) return null;

  const templateAbs = path.join(WORKSPACE_DIR, scope, template);
  if (!existsSync(templateAbs)) return null;

  try {
    copyFileSync(templateAbs, dockerfileAbs);
    const templateRel = `${scope}/${template}`;
    console.log(`[${new Date().toTimeString().slice(0, 8)}] ${logScope} auto-filled missing ${dockerfileRel} from ${templateRel}`);
    emit({ say: 'text', text: `[agent] auto-filled missing ${dockerfileRel} from ${templateRel}` });
    return { dockerfile: dockerfileRel, template: templateRel };
  } catch (err) {
    return logAndSwallow(err, `${logScope} auto-fill FAILED for ${dockerfileRel}`, null);
  }
}

// Minimal stack-specific scaffolding templates. Used by ensureScopeScaffolding
// only when (a) the model wrote evidence of the matching stack and (b) the
// mandatory file is missing on disk. Kept inline because they're tiny and
// stack-specific — the snippet system handles the bulk of templating.
const REACT_VITE_PACKAGE_JSON = `{
  "name": "frontend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^5.4.10"
  }
}
`;

const REACT_VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
});
`;

const REACT_VITE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;

/**
 * Stack-aware scaffolding safety net. Mirrors ensureScopeDockerfile but for
 * the mandatory framework files the Coder sometimes skips when it batches
 * writes (e.g. forgets package.json after writing component .jsx files).
 *
 * Evidence-driven detection — only fires when the model wrote files matching
 * a known stack pattern AND has missing scaffolding for that same stack:
 *   frontend + *.jsx/*.tsx/vite.config evidence → React+Vite
 *     ensures package.json, vite.config.js, index.html
 *   anything else → no-op (don't fight unknown stacks)
 *
 * Backend stacks (Node/Python/Rust) intentionally NOT covered here yet —
 * empirically the backend scope writes its own package.json/requirements.txt
 * reliably (the rule inlines the exact content). Add similar coverage if
 * future runs show drift.
 */
function ensureScopeScaffolding(scope, writtenPaths, emit, logScope) {
  if (scope !== 'frontend') return [];
  const written = [...writtenPaths];
  const isReactVite = written.some((p) => /\.(jsx|tsx)$|vite\.config/.test(p));
  if (!isReactVite) return [];

  const filled = [];
  const ensure = (rel, content) => {
    const abs = path.join(WORKSPACE_DIR, rel);
    try {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, { flag: 'wx' });
      console.log(`[${new Date().toTimeString().slice(0, 8)}] ${logScope} auto-filled missing ${rel} (React+Vite scaffold)`);
      emit({ say: 'text', text: `[agent] auto-filled missing ${rel} (React+Vite scaffold)` });
      filled.push(rel);
    } catch (err) {
      if (err.code === 'EEXIST') return;
      logAndSwallow(err, `${logScope} scaffold auto-fill FAILED for ${rel}`);
    }
  };

  ensure('frontend/package.json', REACT_VITE_PACKAGE_JSON);
  // Only scaffold a vite config if the agent wrote NO config variant at all.
  // Vite resolves `vite.config.js` BEFORE `.ts` (search order js→mjs→ts→…), so a
  // scaffolded `.js` silently shadows an agent-authored `vite.config.ts` —
  // dropping its plugins (e.g. @tailwindcss/vite) and dev proxy. Treat the whole
  // family as "present" and never fight a config the agent already authored.
  const VITE_CONFIG_VARIANTS = ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts'];
  const hasViteConfig = VITE_CONFIG_VARIANTS.some((ext) =>
    existsSync(path.join(WORKSPACE_DIR, `frontend/vite.config.${ext}`)));
  if (!hasViteConfig) ensure('frontend/vite.config.js', REACT_VITE_CONFIG);
  ensure('frontend/index.html', REACT_VITE_INDEX_HTML);
  return filled;
}

/**
 * Pull the task spec out of the initial enriched prompt. prompt-builder labels
 * it `=== USER REQUEST ===` for single-scope runs and `=== YOUR TASK (<SCOPE>
 * scope) ===` for multi-scope. We try both. Fallback: last 500 chars of the
 * prompt (the task is always at the end).
 */
function extractTaskSpec(prompt) {
  // Header regexes are fixed-width; the body is sliced by index so a long
  // user prompt can never make this polynomial.
  const headers = [/=== USER REQUEST ===\n/, /=== YOUR TASK \([A-Z]+ scope\) ===\n/];
  for (const re of headers) {
    const h = re.exec(prompt);
    if (!h) continue;
    const from = h.index + h[0].length;
    const end = prompt.indexOf('\n===', from);
    const body = prompt.slice(from, end === -1 ? undefined : end).trim();
    if (body) return body.slice(0, 2000);
  }
  return prompt.slice(-500).trim();
}

/**
 * Extract the router-emitted contract blocks (DATA MODEL, API CONTRACT,
 * UI CONTRACT, BUSINESS LOGIC CONTRACT, VECTOR ENGINE, REQUIRED SERVICES)
 * from the turn-1 spawn prompt. Re-injected verbatim in every subsequent
 * turn's user message so the agent can't lose them via attention drift.
 *
 * Observed t38 (2026-05-09): frontend agent on turn 2 emitted Status:
 * infeasible claiming "no === UI CONTRACT === / === API CONTRACT === blocks"
 * — but the run-log proves both blocks WERE in turn 1's spawn message. The
 * agent looked at turn 2's `[TASK]` reminder + tool results and ignored
 * turn 1 in conversation history. Re-injecting the contracts in every
 * task reminder closes that hallucination path.
 */
function extractContractBlocks(prompt) {
  // Headers we care about. Each section runs from its `=== HEADER ===` line
  // to the next `===` line or end-of-string. Match non-greedy so adjacent
  // sections don't get folded together.
  const headers = [
    'DATA MODEL',
    'API CONTRACT',
    'UI CONTRACT',
    'BUSINESS LOGIC CONTRACT',
    'VECTOR ENGINE',
    'REQUIRED SERVICES',
  ];
  const blocks = [];
  for (const h of headers) {
    const re = new RegExp(`(=== ${h} ===\\n[\\s\\S]+?)(?=\\n=== |$)`, 'm');
    const m = prompt.match(re);
    if (m && m[1].trim()) blocks.push(m[1].trim());
  }
  if (blocks.length === 0) return '';
  return blocks.join('\n\n');
}

/**
 * W3.RECOV — Stale-diff retry detector. Scans a batch of tool errors and
 * returns the unique paths where `replace_in_file` failed with the
 * `SEARCH block ... did not match` signature. This is the spin-loop
 * pattern documented in `smoke-metrics-baseline-post-phase{1,2}-2026-05-16
 * .flake-notes.md`: a sibling-scope reconciler rewrites the file
 * between turns, the agent's diffs reference text that no longer exists,
 * every retry fails the same way until the wall-clock kills the run.
 *
 * Signature: case-insensitive match on either "SEARCH block did not match"
 * or "SEARCH block N did not match" — both forms produced by
 * file-tools.js's replace_in_file throw at line ~322.
 *
 * Returns the deduped list of paths (read from the tool-error's path
 * field, populated by the dispatcher when replace_in_file throws). The
 * caller decides whether to inject a `read_file` synthesised result for
 * each — typically gated by N≥2 distinct paths AND per-path injection
 * count < MAX_FIX_ATTEMPTS_PER_SCOPE.
 *
 * Exported for the unit test in `agent/__tests__/stale-diff-detector.test.js`.
 *
 * @param {Array<{ name, path, snippet }>} toolErrors
 * @returns {string[]} deduped affected paths (absolute or relative as
 *                     written by the original tool call)
 */
export function detectStaleDiffPaths(toolErrors) {
  const paths = new Set();
  if (!Array.isArray(toolErrors)) return [];
  for (const err of toolErrors) {
    if (!err || err.name !== 'replace_in_file') continue;
    const snippet = String(err.snippet || '');
    // Both forms produced by file-tools.js's throw:
    //   "replace_in_file: SEARCH block 1 did not match. ..."
    //   "replace_in_file: SEARCH block did not match. ..."
    if (!/SEARCH\s+block\s+(?:\d+\s+)?did\s+not\s+match/i.test(snippet)) continue;
    if (err.path) paths.add(err.path);
  }
  return [...paths];
}

/**
 * Synthesise a `read_file` tool-result block for a given absolute path,
 * using the file's CURRENT on-disk content. Used by the stale-diff
 * recovery injection: when the agent's batch produced N≥2 stale-diff
 * errors, we prepend one of these blocks per affected path into the next
 * user message so the agent's next turn sees fresh state.
 *
 * Mirrors the existing read_file tool-result format the agent already
 * knows how to parse: `[TOOL RESULT — read_file] ... [/TOOL RESULT]`.
 * Returns null when the file is unreadable (deleted, permissions).
 *
 * @param {string} workspaceDir
 * @param {string} relPath
 * @returns {string|null}
 */
export function buildReadFileInjection(workspaceDir, relPath) {
  try {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(workspaceDir, relPath);
    if (!existsSync(abs)) {
      return `[TOOL RESULT — read_file (synthesised by stale-diff recovery)]\nFile ${relPath} does not exist on disk. Your prior replace_in_file SEARCH blocks may be referencing the old file path. Adjust accordingly.\n[/TOOL RESULT]`;
    }
    const content = readFileSync(abs, 'utf-8');
    return `[TOOL RESULT — read_file (synthesised by stale-diff recovery)]\npath: ${relPath}\n--- current content (the harness re-read the file because your replace_in_file SEARCH blocks did not match; use this exact text in any new replace_in_file calls) ---\n${content}\n[/TOOL RESULT]`;
  } catch (err) {
    logAndSwallow(err, '[stale-diff-recovery] failed to read file for injection');
    return null;
  }
}

/**
 * Run one user-facing turn through the custom agent.
 *
 * @param {string} sessionId - The active session.
 * @param {string} prompt - The first user message for this turn (scope restriction + task).
 * @param {object} opts
 * @param {string|null} [opts.conversationId] - Existing MGA conversation_id to continue, or null.
 * @param {string|null} [opts.scope] - Task scope label (for event tagging).
 * @param {AbortSignal} [opts.signal] - Cancellation.
 * @param {object} [opts.priorTokenTotals] - Session-level cumulative totals from prior user prompts in the same chat. Added to this run's totals before emission so the UI's token chip shows session-wide cost, not per-prompt cost.
 * @param {string} opts.phase - REQUIRED. PhaseStateMachine initial phase. Must be 'ORCHESTRATING' or 'SUBAGENT'. The legacy 'EXECUTING' phase was removed in Phase C; every dispatch picks an explicit assistant via the phase + scope combo.
 * @returns {Promise<{ exitCode:number, conversationId:string|null, completionText:string|null, usage:object|null, runTokenTotals:object, buildPassed:boolean }>}
 */
export async function runCustomAgent(sessionId, prompt, { conversationId = null, scope = null, signal = null, priorTokenTotals = null, phase = null, subagentDepth = 0, isIterate = false } = {}) {
  if (!phase) {
    throw new Error('runCustomAgent: `phase` is required (PHASES.ORCHESTRATING or PHASES.SUBAGENT). The legacy EXECUTING default was removed in Phase C.');
  }
  const logScope = scope ? `[agent:${scope}]` : '[agent]';
  tlog('%s starting turn: conversation=%s prompt=%d chars',
    logScope, conversationId || 'new', Number(prompt.length) || 0);

  // Step 7c — derive run context for per-scenario / per-phase logs. The
  // smoke harness sets WORKSPACE_DIR to a path encoding the scenario and
  // run timestamp; deriveRunContext extracts those into a stable key the
  // logger uses to organize folders. Returns null for non-smoke runs;
  // recordLlmCall no-ops when the context is null.
  //
  // W1.TEL Section M item 5: attach sessionId so the new run-logs layout
  // (run-logs/<sessionId>/<phase>/) is used uniformly for smoke + manual
  // runs. scenarioId / runTimestamp are preserved inside meta.json sidecar
  // for backwards-compatible scenario tagging.
  const runContext = attachSessionId(deriveRunContext(WORKSPACE_DIR), sessionId);

  // Helper to emit events to the session stream, matching Cline-event path.
  // Every payload is tagged with scope so the UI groups correctly.
  const emit = (payload) => {
    const enriched = scope ? { ...payload, scope } : payload;
    const event = appendEvent(sessionId, 'cline', enriched);
    sessionEvents.emit('event', sessionId, event);
  };

  // W1.TEL Section M item 8 — typed phase_start / phase_end transcript
  // events. Today runCustomAgent enters and exits exactly one phase
  // (the legacy multi-transition flow was retired in Phase C); we record
  // the boundary here. Wrapping each return in `endPhase(...)` ensures the
  // phase_end event fires regardless of which exit path the run takes.
  const phaseStartTs = Date.now();
  try {
    const phaseStartEvent = appendEvent(sessionId, 'phase_start', {
      phase, scope: scope || null, sessionId, ts: phaseStartTs,
    });
    sessionEvents.emit('event', sessionId, phaseStartEvent);
  } catch (err) {
    logAndSwallow(err, '[telemetry-phase-start]');
  }
  let phaseEndEmitted = false;
  const endPhase = (returnValue) => {
    if (!phaseEndEmitted) {
      phaseEndEmitted = true;
      try {
        const endTs = Date.now();
        const phaseEndEvent = appendEvent(sessionId, 'phase_end', {
          phase, scope: scope || null, sessionId, ts: endTs,
          durationMs: endTs - phaseStartTs,
        });
        sessionEvents.emit('event', sessionId, phaseEndEvent);
      } catch (err) {
        logAndSwallow(err, '[telemetry-phase-end]');
      }
    }
    return returnValue;
  };

  // Extract the actual task spec from the enriched prompt — we re-inject it
  // as a header on every tool-result turn so the model stays anchored on
  // the task. Without this, MGA's conversation_id keeps history but the model
  // focuses on the latest user message (the tool response) and loses track
  // of what it was supposed to build.
  const taskSpec = extractTaskSpec(prompt);
  const contractBlocks = extractContractBlocks(prompt);
  tlog('%s extracted task spec: %d chars', logScope, Number(taskSpec.length) || 0);
  dlog('%s task spec: %s', logScope, logSafe(taskSpec));

  let currentConversationId = conversationId;
  let currentMessage = prompt;
  let completionText = null;
  let aggregatedUsage = null;
  const sessionTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, turns: 0, truncations: 0 };

  // Session-level totals (prior user prompts' cumulative cost) baseline. We
  // add these to the per-run totals before emitting token_metrics so the UI
  // shows session-wide cost, not per-prompt cost. Defaults to zero (first
  // prompt in the session).
  const priorTotals = priorTokenTotals || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, apiCalls: 0 };

  // Virtual history mirror (Phase 1: measurement only). Keeps a client-side
  // shadow of what we've sent to MGA under this conversation_id so later
  // phases can drive microcompact / rotation decisions. In Phase 1 this is
  // passive — we record and log, never intervene.
  const history = new VirtualHistoryManager({ conversationId, scope });

  // Microcompact cache (Phase 2a): dedups read_file results for paths
  // already read or written in this run. Gated on USE_COMPACTION so we can
  // A/B against the Phase 1 baseline without touching code paths.
  // `let` because rotation replaces it with a fresh instance.
  let microcompact = USE_COMPACTION ? new MicrocompactCache() : null;

  // Phase 3: rotation trigger + summarizer. Rotation fires at the top of
  // each iteration when virtual-history tokens exceed the threshold (default
  // 134K, Claude-Code-derived). On rotation we call the summarizer, reset
  // per-run MGA-tied state (history, microcompact, error counts, nudges),
  // and seed a fresh conversation_id with the summary as the first user
  // message. writtenPaths persists across rotations because filesystem state
  // persists — the model shouldn't rewrite what it already wrote. Gated on
  // USE_COMPACTION so Phase 1 baseline runs are unaffected.
  const rotationTrigger = USE_COMPACTION ? new CompactionTrigger() : null;
  const summarizerClient = USE_COMPACTION ? new SummarizerClient() : null;
  let rotationJustDone = false;

  // PhaseStateMachine gates assistant selection + tool dispatch.
  // SUBAGENT and INVESTIGATING have no tool restrictions; ORCHESTRATING has a
  // tool whitelist (legacy LLM orchestrator, no longer dispatched). Assistant
  // routing per phase comes from resolvePhaseAssistant():
  //   - ORCHESTRATING → orchestratorAssistantId
  //   - SUBAGENT (+ scope) → subagent<Scope>AssistantId
  //   - INVESTIGATING → investigatorAssistantId
  // EXECUTING/PLANNING/DONE were retired in Phase C — every live dispatch now
  // picks an explicit assistant via the phase + scope combo.
  const phaseMachine = new PhaseStateMachine({ initialPhase: phase });
  let phaseAssistantIdResolved = null;
  let phaseAssistantLabel = 'MGA';
  {
    const creds = getCredentials();
    const resolved = resolvePhaseAssistant(phase, { scope, creds });
    if (resolved.error) {
      tlog('%s phase=%s scope=%s → resolution error: %s', logScope, phase, scope, resolved.error);
      throw new MgaLlmError(resolved.error, { status: 400 });
    }
    if (phaseMachine.isOrchestrating() || phaseMachine.isSubagent() || phaseMachine.isInvestigating()) {
      // Post-transport-refactor the assistant ID is retained ONLY as a log
      // label — the model comes from pickModel and instructions from disk
      // (see below), so callMgaCompletions never receives the ID. A missing
      // ID is therefore non-fatal: fall back to the resolved label so phases
      // whose account-bound assistant isn't provisioned in this environment
      // (e.g. the read-only investigator in local dev) still run on
      // model-from-config rather than hard-failing the turn.
      phaseAssistantIdResolved = resolved.assistantId;
      phaseAssistantLabel = resolved.label;
      if (resolved.assistantId) {
        tlog('%s phase=%s → routing to %s assistant (%s)', logScope, phase, resolved.label, phaseAssistantIdResolved);
      } else {
        tlog('%s phase=%s scope=%s → no assistant ID configured; proceeding with model-from-config (label=%s)',
          logScope, phase, scope, resolved.label);
      }
    }
  }

  // ── /chat/completions transport ────────────────────────────────────────
  // Ships full message history per call with cache_control on the system
  // prompt. /chat/agent's conversation_id does NOT load prior context into
  // the LLM (see /tmp/cache-probes/MGA_ANTHROPIC_CACHING.md), so it gave
  // the agent zero memory turn-over-turn — every iteration the LLM saw
  // only the new user message. /chat/completions is the only way to get
  // real agent memory, plus it caches the system-prompt prefix at ~0.1x rate.
  //
  // `completionsMessages` is the wire-shape array we send every call: the
  // system prompt once (with cache_control), then alternating user/assistant
  // entries as the loop runs.
  // Model resolved 100% from config (pickModel) — no getAssistantConfig call,
  // so the runtime never depends on account-bound MGA assistant IDs to pick a
  // model. `phaseAssistantIdResolved` is retained only as a log label.
  const { pickModel } = await import('./llm/model-picker.js');
  const picked = pickModel({ phase, scope, isIterate });
  const completionsModel = picked.model;
  // Instructions: disk-composed via the shared manifest + composer so runtime +
  // upload-assistant-prompt.js produce identical bytes.
  // PHASES.SUBAGENT + scope → 'subagent-<scope>'; PHASES.INVESTIGATING →
  // 'investigator'. Anything not in the manifest gets no instructions (only the
  // retired LLM orchestrator phase, which isn't dispatched in current builds).
  let manifestKey = null;
  if (phase === PHASES.SUBAGENT && scope) manifestKey = `subagent-${scope}`;
  else if (phase === PHASES.INVESTIGATING) manifestKey = 'investigator';
  let instructionsText;
  let instructionsSource;
  if (manifestKey && ASSISTANTS[manifestKey]) {
    instructionsText = composeAssistantPrompt(manifestKey);
    instructionsSource = `disk(${manifestKey})`;
  } else {
    // No disk prompt for this phase. Current builds always resolve a manifest
    // prompt (subagent-<scope> / investigator); this branch remains only for the
    // retired orchestrator phase, which isn't dispatched in current builds.
    instructionsText = '';
    instructionsSource = 'none';
  }
  const completionsMessages = [{
    role: 'system',
    content: [{
      type: 'text',
      text: instructionsText,
      cache_control: { type: 'ephemeral' },
    }],
  }];
  tlog('%s /chat/completions: model=%s%s system=%d chars source=%s',
    logScope,
    completionsModel,
    picked.source,
    instructionsText.length,
    instructionsSource);

  // Subagent recursion guard — phase agents cannot themselves spawn subagents.
  // The orchestrator is the only level allowed to dispatch.
  if (subagentDepth > 1) {
    throw new MgaLlmError(
      `subagentDepth=${subagentDepth} exceeds limit (1). Phase agents cannot spawn further subagents.`,
      { status: 400 },
    );
  }

  // Track file paths the model has successfully written or edited this run.
  // Used only when a ghost-file report is suppressed — we echo this list back
  // to the model so it can fix the report without guessing.
  const writtenPaths = new Set();

  // Track file paths the model has read_file'd this run. Echoed back in the
  // verification-scope nudge so the model stops re-reading the same files.
  // Verification was observed reading docker-compose.yml 7 times in a single
  // 15-turn cap; without an explicit "you have already read this" signal the
  // model treats each nudge as permission to re-read what it already saw.
  const readPaths = new Set();

  // Count consecutive turns where every tool was info-gathering. Without this
  // pressure, the model will happily re-fetch the same rules/snippets/dirs
  // indefinitely (confirmed empirically — stripping the nudge causes 15-turn
  // pure-gather loops). Nudge fires on turn 3. GATHER_TOOLS is imported from
  // permission-pipeline.js (also used by the gather-lock gate).
  let gatherOnlyTurns = 0;

  // Verification-scope hard lock. Once the gather-nudge has fired for a
  // verification run, further gather-tool calls are rejected at the dispatcher
  // with a synthetic error result. Text-pressure nudges alone were empirically
  // insufficient — the model kept list_files-looping the same 3 directories
  // and re-reading files in readPaths even when the nudge forbade it. Hard
  // enforcement guarantees the only productive path out is build/write/finalize.
  let verificationGatherLocked = false;

  // Track whether docker-compose build returned exit 0 in this verification
  // run. After Track B item B5 the harness no longer gates anything on this
  // — tryAutoStartApp at the session boundary runs the build authoritatively.
  // The flag remains for telemetry and for the runCustomAgent return value
  // so callers (smoke harness, session/routes.js) can see whether the build passed
  // inside the loop without re-running it themselves.
  let verificationBuildPassed = false;

  // Second finalize trigger: count turns since the FIRST successful write.
  // The gather-only counter alone misses the case where the model alternates
  // read_file (gather) → execute_command (not gather) → read_file → ... —
  // execute_command resets the gather counter, so it never reaches 2 even
  // though the model is in pure verification theater after writes succeeded.
  // If writes happened and we're more than 2 turns past, force finalize.
  let firstWriteIter = -1;

  // Task-impossibility safeguard. If the model has produced zero writes after
  // N iterations AND hasn't emitted attempt_completion, it's either searching
  // for something that doesn't exist (e.g. "mark /ping as deployed" when /ping
  // doesn't exist) or stuck in an unproductive investigation loop. Text nudges
  // alone don't solve this — the model keeps oscillating between read_file /
  // execute_command / use_mcp_tool (which reset each other's counters). We
  // engage a dispatcher-level lock that blocks everything except
  // attempt_completion, forcing the model to finalize with what it knows
  // (or explain why it couldn't).
  //
  // Per-scope thresholds. Integration legitimately needs more gather turns
  // than other scopes — it works on 4+ other scopes' output (read each scope
  // folder, read docker-compose templates, fetch integration rules, fetch the
  // appropriate compose snippet, then write). Test 6 hit the original
  // threshold-8 lock at iter 9 just as the model was about to write
  // docker-compose.yml + nginx.local.conf + .env.example — all blocked,
  // run aborted with no integration output. Raise to 15 for integration; keep
  // 8 for other scopes (still catches /ping-style infeasible tasks).
  const TASK_IMPOSSIBILITY_THRESHOLDS = {
    backend: 8,
    frontend: 8,
    database: 8,
    vectordb: 8,
    integration: 15,
  };
  const TASK_IMPOSSIBILITY_LOCK_THRESHOLD = TASK_IMPOSSIBILITY_THRESHOLDS[scope] ?? 8;
  let taskImpossibilityLocked = false;

  // Error-repeat detector. Tracks identical tool calls (same name + same args)
  // that keep failing. Claude Code's 3-strike circuit-breaker pattern: block
  // on the 3rd consecutive identical error. Successful dispatch of the same
  // signature resets the counter — transient failures recover. The threshold
  // and the signature helper live in permission-pipeline.js; the Map state is
  // owned here and threaded into the cascade via ctx.
  const toolErrorCounts = new Map();

  // W3.RECOV — stale-diff detector state. Tracks how many times we've
  // synthesised a `read_file` injection for a given path within this
  // agent run. The detector fires when a single batch produces N≥2
  // `replace_in_file` errors with `SEARCH block ... did not match` —
  // the signature of an agent operating on a stale view of a file that
  // a sibling-scope reconciler or post-write validator just rewrote.
  // Without recovery the agent emits the same stale diffs each turn
  // and burns through MAX_ITERATIONS spinning. With recovery, we
  // prepend a synthesized read_file tool-result of the file's CURRENT
  // on-disk content into the next user message; the agent's next turn
  // sees real state and produces matching diffs.
  //
  // Cap re-injections per path at MAX_FIX_ATTEMPTS_PER_SCOPE — after
  // that the agent fails naturally and the orchestrator-level auto-
  // recovery loop takes over.
  const staleDiffReinjections = new Map(); // absolutePath → count

  // Rotation closure shared by proactive (top-of-iter, threshold-driven) and
  // reactive (catch block, prompt_too_long-driven) callers. Captures all the
  // per-run state by reference so a reset in either path is consistently
  // applied. Returns { ok, error } — the caller decides how to surface
  // failures (proactive emits a soft warning + continues; reactive falls
  // through to the existing exit-1 path).
  async function performRotation(reasonText, iterIdx, { proactive }) {
    if (!rotationTrigger || !summarizerClient) return { ok: false, error: new Error('compaction disabled') };
    const banner = proactive
      ? `Context threshold reached — rotating conversation. ${reasonText}`
      : `Prompt too long — rotating conversation reactively. ${reasonText}`;
    emit({ say: 'compacting', text: banner });
    try {
      const sumResult = await summarizerClient.summarizeConversationState(history);
      if (!sumResult?.summary) {
        throw new Error('summarizer returned no <summary> block');
      }
      tlog('%s rotation: summary produced (mode=%s, %d chars, %dms, prompt=%s completion=%s)',
        logScope,
        sumResult.mode || 'full',
        sumResult.summary.length,
        sumResult.elapsedMs,
        sumResult.usage?.prompt_tokens ?? '?',
        sumResult.usage?.completion_tokens ?? '?');
      const pendingMatch = sumResult.summary.match(/## 7\.\s*Pending Tasks([\s\S]*?)(?=\n## |$)/i);
      if (pendingMatch) {
        tlog('%s rotation: Section 7 (Pending Tasks) says: %s',
          logScope, pendingMatch[1].trim().replace(/\s+/g, ' ').slice(0, 200));
      }
      currentMessage = buildRotationUserMessage({
        summaryText: sumResult.summary,
        writtenPaths,
        taskSpec,
      });
      currentConversationId = null;
      history.turns.length = 0;
      history.turnCount = 0;
      // Drop accumulated history, keep system message. The rotation summary
      // becomes the new turn-1 user message on next call.
      completionsMessages.length = 1;
      if (USE_COMPACTION) microcompact = new MicrocompactCache();
      toolErrorCounts.clear();
      gatherOnlyTurns = 0;
      taskImpossibilityLocked = false;
      verificationGatherLocked = false;
      verificationBuildPassed = false;
      firstWriteIter = -1;
      rotationJustDone = true;
      rotationTrigger.recordSuccess(iterIdx);
      tlog('%s rotation complete (%s) — per-run state reset, cooldown=%d turns active',
        logScope, proactive ? 'proactive' : 'reactive', rotationTrigger.cooldownTurns);
      return { ok: true };
    } catch (err) {
      rotationTrigger.recordFailure();
      tlog('%s rotation FAILED (%s, %d consecutive): %s',
        logScope, proactive ? 'proactive' : 'reactive', rotationTrigger.consecutiveFailures, err.message);
      return { ok: false, error: err };
    }
  }

  // Build the standard error-return object for an LLM call that we couldn't
  // recover from. Captures the running-totals snapshot at call time.
  const buildLlmErrorReturn = () => ({
    exitCode: 1,
    conversationId: currentConversationId,
    completionText,
    usage: aggregatedUsage,
    runTokenTotals: {
      promptTokens: sessionTotals.prompt_tokens,
      completionTokens: sessionTotals.completion_tokens,
      cachedTokens: sessionTotals.cached_tokens,
      apiCalls: sessionTotals.turns,
      truncations: sessionTotals.truncations,
    },
    virtualHistory: history, writtenPaths: [...writtenPaths],
    buildPassed: verificationBuildPassed,
  });

  // Surface a MgaLlmError as an api_req_failed event + tlog. Used by the
  // primary catch and the reactive-retry catch.
  const emitLlmError = (e, qualifier = null) => {
    const msg = qualifier ? `${qualifier}: ${e.message}` : e.message;
    emit({
      ask: 'api_req_failed',
      text: JSON.stringify({
        message: msg,
        status: e.status ?? null,
        modelId: null,
        providerId: 'mga-coder',
      }),
    });
    tlog('%s LLM error%s: %s (status=%s)', logScope, qualifier ? ` (${qualifier})` : '', e.message, e.status);
  };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) {
      tlog('%s aborted at iter %d', logScope, iter);
      return endPhase({ exitCode: 130, conversationId: currentConversationId, completionText, usage: aggregatedUsage, runTokenTotals: { promptTokens: sessionTotals.prompt_tokens, completionTokens: sessionTotals.completion_tokens, cachedTokens: sessionTotals.cached_tokens, apiCalls: sessionTotals.turns, truncations: sessionTotals.truncations }, virtualHistory: history, writtenPaths: [...writtenPaths], buildPassed: verificationBuildPassed });
    }

    // Engage task-impossibility lock when we've had too many turns with no
    // productive writes. Only engage once (idempotent). The dispatcher uses
    // this flag to synthetically error non-completion tool calls.
    //
    // This is a WRITE-PRESSURE guard: "zero writes after N turns = stuck" is
    // only a valid signal for a phase whose product IS file writes (SUBAGENT,
    // incl. the verification scope). ORCHESTRATING spawns agents and
    // INVESTIGATING is read-only — their writtenPaths is permanently empty by
    // design, so the lock would fire mid-run and strangle them (observed:
    // orchestrator blocked at iter 8 on smoke t11; investigator blocked at
    // iter 9 mid-log-gather). Gate on producesFileWrites() so every non-writing
    // phase is exempt by construction. Their runaway-protection lives
    // elsewhere: orchestrator → duplicate-dispatch guard in tools/core.js +
    // MAX_ITERATIONS; investigator → MAX_ITERATIONS + INVESTIGATOR_PHASE_TIMEOUT_MS.
    if (phaseMachine.producesFileWrites() && !taskImpossibilityLocked
        && writtenPaths.size === 0 && iter >= TASK_IMPOSSIBILITY_LOCK_THRESHOLD) {
      taskImpossibilityLocked = true;
      tlog('%s task-impossibility lock ENGAGED at iter %d (no writes after threshold)', logScope, iter + 1);
    }

    // --- Rotation check (Phase 3) ---
    // Ask the trigger whether the conversation has grown past thresholds.
    // If yes: summarize, seed a fresh MGA conversation_id, reset per-run
    // MGA-tied state (history/microcompact/errorCounts/locks), replace
    // currentMessage with the rotation user message, and continue the loop.
    // Graceful degradation: if summarizer fails, the trigger records a
    // failure and we fall through without rotating. After 3 failures the
    // trigger disables itself and MGA's buffer_length takes over.
    if (rotationTrigger) {
      const decision = rotationTrigger.shouldRotate({ history, iter, rotationJustDone });
      if (decision.rotate) {
        tlog('%s rotation trigger fired at iter %d: %s', logScope, iter, decision.reason);
        const result = await performRotation(decision.reason, iter, { proactive: true });
        if (!result.ok) {
          // Soft fall-through — agent continues with existing state. Circuit
          // breaker in the trigger disables rotation after N consecutive
          // failures (then MGA's buffer_length FIFO truncation takes over).
          emit({ say: 'text', text: `(rotation failed: ${result.error.message} — continuing)` });
        }
      } else {
        rotationJustDone = false;
      }
    }

    // --- Microcompact check: REMOVED ---
    // The maybeMicrocompact call was here. Removed because v1 was
    // observability-only — it called the Summarizer assistant to produce
    // a compressed restatement of the oldest tool-result blocks, logged
    // before/after PROJECTIONS, but NEVER actually spliced the summary
    // into the next user message or mutated history. Net effect: paid
    // Summarizer tokens + added a network round-trip every fire, with
    // zero reduction in what got sent to MGA on the next call. The TODO
    // to splice in the summary was deferred indefinitely.
    //
    // Rotation (above, threshold 700K tokens via triggers.js) remains as
    // the actual safety net for runaway context growth. On Sonnet 4.5
    // with its large context window, the previous 100K microcompact
    // threshold (= 50% of an assumed 200K window) was firing routinely
    // on long agent runs while doing nothing useful.

    // --- 1. Call the LLM and stream text out
    //
    // The model's response contains a mix of narrative text and XML tool
    // blocks. We only want the narrative text to reach the UI as `say:'text'`
    // events — the XML blocks become structured tool events once they're
    // parsed. To do that we run the parser on the growing buffer after every
    // delta and emit only the new "text" content since last emission.
    //
    // We also BATCH emissions on a 150ms debounce. SSE deltas can be tiny
    // (a few chars each) and emitting one event per delta causes the UI to
    // render each chunk as a separate bubble and breaks auto-scroll. One
    // event every ~150ms produces readable, stable bubbles.
    const TEXT_FLUSH_MS = 150;
    let assistantResponse;
    let streamBuffer = '';
    let emittedText = '';
    let pendingText = '';
    let flushTimer = null;

    const flushPending = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingText.length > 0) {
        // Emit CUMULATIVE text, not the delta. ChatScreen merges consecutive
        // `say: 'text'` events only when newText.startsWith(oldText). Deltas
        // break that check and render as separate bubbles.
        emit({ say: 'text', text: emittedText });
        pendingText = '';
      }
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPending();
      }, TEXT_FLUSH_MS);
    };

    history.recordUserMessage(currentMessage);

    // Ephemeral liveness heartbeat: every ~1500 streamed chars, push a
    // non-persisted event so the UI's working card can show live progress
    // ("generating… Nk chars") instead of a frozen step count. Bypasses the
    // transcript deliberately — replay doesn't need heartbeats.
    let heartbeatChars = 0;
    let heartbeatLastEmit = 0;
    const emitHeartbeat = () => {
      sessionEvents.emit('event', sessionId, {
        type: 'scope_heartbeat',
        ts: Date.now(),
        payload: { scope: scope || null, phase, chars: heartbeatChars },
      });
    };

    // Streaming callback shared by both transport paths.
    const buildOnTextDelta = () => (delta) => {
      heartbeatChars += delta.length;
      if (heartbeatChars - heartbeatLastEmit >= 1500) {
        heartbeatLastEmit = heartbeatChars;
        emitHeartbeat();
      }
      streamBuffer += delta;
      const blocks = parseAssistantMessage(streamBuffer);
      let currentText = blocks
        .filter(b => b.type === 'text')
        .map(b => b.content)
        .join('\n');
      const lastLt = currentText.lastIndexOf('<');
      if (lastLt !== -1 && !currentText.slice(lastLt).includes('>')) {
        currentText = currentText.slice(0, lastLt);
      }
      if (currentText.length > emittedText.length && currentText.startsWith(emittedText)) {
        pendingText += currentText.slice(emittedText.length);
        emittedText = currentText;
        scheduleFlush();
      }
    };

    try {
      completionsMessages.push({ role: 'user', content: currentMessage });
      assistantResponse = await callMgaCompletions({
        messages: completionsMessages,
        model: completionsModel,
        assistantLabel: phaseAssistantLabel,
        signal,
        runContext,
        phase,
        scope,
        onTextDelta: buildOnTextDelta(),
      });
      // Incremental caching: wrap the assistant response as a content-block
      // array with cache_control so its position becomes a cache breakpoint
      // for the NEXT call. Anthropic supports up to 4 breakpoints/request;
      // system is always one, plus up to 3 of the most recent assistants.
      // The doc's pattern (MGA_ANTHROPIC_CACHING.md §2.3) — each call reads
      // the longest matching cached prefix, dramatically reducing cost on
      // long conversations (t6 backend was 15 turns × growing prompt).
      completionsMessages.push({
        role: 'assistant',
        content: [{
          type: 'text',
          text: assistantResponse.content,
          cache_control: { type: 'ephemeral' },
        }],
      });
      // Demote older assistant breakpoints — keep only system + last 3 assistants.
      _trimCompletionsBreakpoints(completionsMessages, 3);
    } catch (err) {
      if (err instanceof MgaLlmError) {
        // ── Reactive compaction (Phase 3 layer 2). If MGA returned a "prompt
        // is too long" error AND rotation is available, summarize + retry
        // once. Catches the case where our token estimate lagged or a single
        // large tool result spiked input length above MGA's hard cap mid-
        // iteration. Layered on top of proactive rotation, not a replacement.
        if (isPromptTooLongError(err) && rotationTrigger && !rotationTrigger.disabled) {
          tlog('%s reactive compaction: prompt_too_long detected (status=%s) — rotating + retrying once',
            logScope, err.status);
          const rotated = await performRotation(err.message, iter, { proactive: false });
          if (rotated.ok) {
            // Retry once with the rotation seed as the new user message.
            // Reset stream state — partial text from the failed call must
            // not double-emit.
            streamBuffer = '';
            emittedText = '';
            pendingText = '';
            history.recordUserMessage(currentMessage);
            try {
              completionsMessages.push({ role: 'user', content: currentMessage });
              assistantResponse = await callMgaCompletions({
                messages: completionsMessages,
                model: completionsModel,
                assistantLabel: phaseAssistantLabel,
                signal,
                runContext,
                phase,
                scope,
                onTextDelta: buildOnTextDelta(),
              });
              // Incremental caching breakpoint on the assistant response.
              // See main call site for rationale.
              completionsMessages.push({
                role: 'assistant',
                content: [{
                  type: 'text',
                  text: assistantResponse.content,
                  cache_control: { type: 'ephemeral' },
                }],
              });
              _trimCompletionsBreakpoints(completionsMessages, 3);
              // Retry succeeded — fall through to normal post-LLM processing.
            } catch (retryErr) {
              if (retryErr instanceof MgaLlmError) {
                emitLlmError(retryErr, 'reactive retry failed');
                return endPhase(buildLlmErrorReturn());
              }
              throw retryErr;
            }
          } else {
            // Rotation itself failed (summarizer error, circuit breaker,
            // etc.). Fall through to original error path with the original
            // prompt_too_long message.
            emitLlmError(err);
            return endPhase(buildLlmErrorReturn());
          }
        } else {
          // Non-recoverable LLM error path.
          emitLlmError(err);
          return endPhase(buildLlmErrorReturn());
        }
      } else {
        throw err;
      }
    } finally {
      // Ensure any pending text is flushed before we move on to tool exec.
      flushPending();
    }

    currentConversationId = assistantResponse.conversationId ?? currentConversationId;
    if (assistantResponse.usage) aggregatedUsage = assistantResponse.usage;

    history.setConversationId(currentConversationId);
    history.recordAssistantResponse(assistantResponse.content || '', assistantResponse.usage);

    const rawContent = assistantResponse.content || '';
    const redacted = redact(rawContent);
    dlog('%s LLM response (%d chars): %s', logScope, redacted.length,
      redacted.replace(/\s+/g, ' ').slice(0, 200) + (redacted.length > 200 ? '…' : ''));

    // --- Token usage accounting & logging
    if (assistantResponse.usage) {
      const u = assistantResponse.usage;
      const pt = u.prompt_tokens ?? u.input_tokens ?? 0;
      const ct = u.completion_tokens ?? u.output_tokens ?? 0;
      const tt = u.total_tokens ?? (pt + ct);
      sessionTotals.prompt_tokens += pt;
      sessionTotals.completion_tokens += ct;
      sessionTotals.total_tokens += tt;
      sessionTotals.cached_tokens += u.prompt_tokens_details?.cached_tokens ?? 0;
      sessionTotals.turns += 1;

      tlog('%s LLM response: %d chars | tokens: prompt=%d completion=%d total=%d | turn %d cumulative total=%d',
        logScope, redacted.length, pt, ct, tt, sessionTotals.turns, sessionTotals.total_tokens);

      // Emit token_metrics so the UI can show the running chip.
      // Shape mirrors session.js's Cline-path event (delta + totals).
      // `totals` is session-cumulative = priorTotals (all prior user prompts)
      // + this run's accumulated usage. The UI replaces its state from every
      // event, so this lets the chip show true session-wide cost rather than
      // per-prompt cost.
      const metricsPayload = {
        delta: {
          promptTokens: pt,
          completionTokens: ct,
          cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
          apiCalls: 1,
        },
        totals: {
          promptTokens: priorTotals.promptTokens + sessionTotals.prompt_tokens,
          completionTokens: priorTotals.completionTokens + sessionTotals.completion_tokens,
          cachedTokens: priorTotals.cachedTokens + sessionTotals.cached_tokens,
          apiCalls: priorTotals.apiCalls + sessionTotals.turns,
        },
        scope: scope || null,
      };
      const metricsEvent = appendEvent(sessionId, 'token_metrics', metricsPayload);
      sessionEvents.emit('event', sessionId, metricsEvent);
    } else {
      tlog('%s LLM response: %d chars (conversation=%s) [no usage returned]',
        logScope, redacted.length, currentConversationId || '?');
    }

    {
      const snap = history.getMetrics();
      const microStats = microcompact ? microcompact.getStats() : { stubCount: 0, cachedPaths: [] };
      const rotStats = rotationTrigger ? rotationTrigger.getStats() : { rotationCount: 0, disabled: false };
      tlog('%s virtual-history: turn=%d conv=%s promptTok=%d completionTok=%d virtualTok=%d stubs=%d rotations=%d',
        logScope, snap.turnCount, snap.conversationId || 'new',
        snap.totalPromptTokens, snap.totalCompletionTokens, snap.estimatedVirtualTokens,
        microStats.stubCount, rotStats.rotationCount);
      const compactEvent = appendEvent(sessionId, 'compact_metrics', {
        ...snap,
        compactionActive: USE_COMPACTION,
        microcompactStubs: microStats.stubCount,
        microcompactCachedPaths: microStats.cachedPaths.length,
        rotationCount: rotStats.rotationCount,
        rotationDisabled: rotStats.disabled,
      });
      sessionEvents.emit('event', sessionId, compactEvent);
    }

    // --- 2. Parse for tool calls
    const blocks = parseAssistantMessage(redacted);
    const toolUses = blocks.filter(b => b.type === 'tool_use' && !b.partial);

    if (toolUses.length === 0) {
      // No tool calls — the model stalled. Two sub-cases:
      //   (a) it tried to finalize in prose instead of calling attempt_completion
      //   (b) it asked the user a question / is confused
      //
      // We can't distinguish cleanly without heuristics. Prod a nudge message
      // back and loop — tell the model it must use tools and either continue
      // or finalize. If it stalls AGAIN on the next turn, give up.
      if (iter > 0 && currentMessage.startsWith('<nudge>')) {
        // We already nudged. Before giving up: a model that finalizes in
        // prose instead of calling attempt_completion has usually WRITTEN its
        // report — it just skipped the tool wrapper (observed live: database
        // agent wrote schema + migration, then emitted its PHASE AGENT REPORT
        // as plain text twice; the scope was scored failed on a green build).
        // Salvage the prose as the completion text when the agent plainly
        // tried to finalize, or when it already did real work this run.
        const proseLooksLikeReport = /PHASE AGENT REPORT|\*{0,2}Status:?\*{0,2}\s*(complete|partial)/i.test(redacted);
        if (redacted.trim().length > 100 && (proseLooksLikeReport || writtenPaths.size > 0)) {
          tlog('%s model stalled twice — salvaging prose as completion (reportMarker=%s writtenPaths=%d)',
            logScope, proseLooksLikeReport, writtenPaths.size);
          completionText = redacted;
          emit({ say: 'completion_result', text: completionText });
          return endPhase({ exitCode: 0, stalled: true, salvaged: true, conversationId: currentConversationId, completionText, usage: aggregatedUsage, runTokenTotals: { promptTokens: sessionTotals.prompt_tokens, completionTokens: sessionTotals.completion_tokens, cachedTokens: sessionTotals.cached_tokens, apiCalls: sessionTotals.turns, truncations: sessionTotals.truncations }, virtualHistory: history, writtenPaths: [...writtenPaths], buildPassed: verificationBuildPassed });
        }
        // Nothing to salvage — the stall is real.
        tlog('%s model stalled twice (no tool calls) — giving up', logScope);
        emit({
          ask: 'api_req_failed',
          text: JSON.stringify({
            message: 'Model stopped emitting tool calls without finalizing. The task may need rephrasing or the system prompt may need adjustment.',
            status: 500,
            providerId: 'custom-agent',
          }),
        });
        return endPhase({ exitCode: 1, stalled: true, conversationId: currentConversationId, completionText, usage: aggregatedUsage, runTokenTotals: { promptTokens: sessionTotals.prompt_tokens, completionTokens: sessionTotals.completion_tokens, cachedTokens: sessionTotals.cached_tokens, apiCalls: sessionTotals.turns, truncations: sessionTotals.truncations }, virtualHistory: history, writtenPaths: [...writtenPaths], buildPassed: verificationBuildPassed });
      }

      tlog('%s no tool calls in response — nudging', logScope);
      currentMessage =
        '<nudge>No tool calls in your last response. Emit a tool call, or attempt_completion to finalize.</nudge>';
      continue;
    }

    // --- 3. Execute tools, collect results
    //
    // Read-only tools (read_file, list_files, use_mcp_tool — see
    // isToolConcurrencySafe in tools/core.js) are dispatched in parallel batches
    // up to MAX_TOOL_USE_CONCURRENCY (default 10) so a turn that reads 4-6
    // files in gather phase doesn't pay 4-6× the round-trip cost. Mutating
    // tools always run serially so they observe each other's side effects in
    // input order. Mirrors Claude Code's partitionToolCalls +
    // runToolsConcurrently (services/tools/toolOrchestration.ts:91-177).
    //
    // Two-pass for completion: first run every tool EXCEPT attempt_completion
    // and record any errors. If errors occurred AND attempt_completion was in
    // the batch, we DON'T fire the completion — we force another LLM turn
    // with the errors summarized so the model sees reality (a read failed, a
    // write hit a missing dir, a command returned non-zero) before closing
    // out. This prevents the "pre-wrote the completion report while the tools
    // that were supposed to produce the result actually failed" bug.
    const toolResults = [];
    const toolErrors = [];
    let pendingCompletion = null;
    let terminated = false;

    const concurrencyCap = Math.max(1,
      parseInt(process.env.MAX_TOOL_USE_CONCURRENCY || '10', 10) || 10);
    const pendingDispatches = []; // [{ toolUse, toolSig, dispatchPromise }]

    // Apply per-tool post-dispatch effects: telemetry, history, results
    // accumulator, error-repeat counters, microcompact records, write/read
    // tracking, verification-build detection. Synchronous; must be called in
    // input order to preserve toolResults ordering and counter semantics.
    const applyPostProcessOutcome = (toolUse, resultStr, stubFired, toolSig) => {
      const isErrorResult = resultStr.startsWith('ERROR:') || /\bexit code: [1-9]/.test(resultStr);
      dlog('%s → %d chars: %s', logScope, resultStr.length,
        resultStr.replace(/\s+/g, ' ').slice(0, 150) + (resultStr.length > 150 ? '…' : ''));
      history.recordToolCall(toolUse.name, toolUse.params, resultStr);
      toolResults.push({ name: toolUse.name, result: resultStr });
      if (isErrorResult) {
        toolErrors.push({ name: toolUse.name, path: toolUse.params.path || toolUse.params.command || '', snippet: resultStr.slice(0, 200) });
        // Error-repeat tracking: increment count for this signature. Don't
        // increment for stubbed dispatches (stubs aren't real dispatches and
        // shouldn't consume the repeat budget) — but stubs return non-error
        // text so they wouldn't hit this branch anyway.
        if (!stubFired) {
          const prev = toolErrorCounts.get(toolSig) || { count: 0, lastSnippet: '' };
          toolErrorCounts.set(toolSig, { count: prev.count + 1, lastSnippet: resultStr.slice(0, 200) });
        }
      } else if ((toolUse.name === 'write_to_file' || toolUse.name === 'replace_in_file') && toolUse.params.path) {
        writtenPaths.add(toolUse.params.path);
        microcompact?.recordWrite(toolUse.params.path, iter);
        toolErrorCounts.delete(toolSig);
      } else if (toolUse.name === 'copy_template' && toolUse.params.dest) {
        writtenPaths.add(toolUse.params.dest);
        microcompact?.recordWrite(toolUse.params.dest, iter);
        toolErrorCounts.delete(toolSig);
      } else if (toolUse.name === 'read_file' && toolUse.params.path) {
        readPaths.add(toolUse.params.path);
        if (!stubFired) {
          microcompact?.recordRead(toolUse.name, toolUse.params, resultStr.length, iter);
        }
        toolErrorCounts.delete(toolSig);
      } else if (toolUse.name === 'use_mcp_tool') {
        // Record successful MCP calls for microcompact dedup on the
        // subset of tools that are immutable within a run. Only populates
        // the cache when the dispatch actually happened (stubbed calls
        // already point at the earlier result).
        if (!stubFired) {
          microcompact?.recordMcpCall(toolUse.params, iter);
        }
        toolErrorCounts.delete(toolSig);
      } else {
        // Other tool successes (execute_command ok, etc.) — reset any
        // prior error count for this signature.
        toolErrorCounts.delete(toolSig);
      }
      // Detect docker-compose build success in verification scope. Match
      // both spellings ("docker-compose build" and "docker compose build").
      // After Track B B5 this is telemetry only — no gate fires on it. The
      // value is forwarded in the return record so session/routes.js / smoke.js
      // can see whether the build passed inside the loop.
      if (scope === 'verification' && toolUse.name === 'execute_command' && !isErrorResult && !verificationBuildPassed) {
        const cmd = String(toolUse.params.command || '');
        if (/docker[- ]compose\s+build\b/.test(cmd)) {
          verificationBuildPassed = true;
          tlog('%s docker-compose build PASSED at turn %d', logScope, iter + 1);
        }
      }
    };

    // Resolve all eagerly-dispatched concurrent reads, applying their
    // outcomes in input order. Called before any operation that has to
    // observe the latest toolResults/toolErrors state — guard rejection
    // pushes, microcompact stub processing, attempt_completion hold-aside,
    // unsafe-tool dispatch — so concurrent results land in input order.
    const flushPendingDispatches = async () => {
      if (pendingDispatches.length === 0) return;
      const items = pendingDispatches.splice(0);
      const settled = await Promise.allSettled(items.map(p => p.dispatchPromise));
      for (let i = 0; i < items.length; i++) {
        const { toolUse, toolSig } = items[i];
        const r = settled[i];
        if (r.status === 'fulfilled') {
          // Truncation — same logic as the inline serial path.
          const truncation = truncateToolResult({
            toolName: toolUse.name,
            params: toolUse.params,
            resultText: r.value,
          });
          const resultStr = truncation.text;
          if (truncation.truncated) {
            sessionTotals.truncations += 1;
            tlog('%s tool-result truncated: %s(%s) %d → %d chars (~%d tokens originally)',
              logScope, toolUse.name, toolUse.params.path || toolUse.params.command?.slice(0, 40) || '?',
              truncation.originalChars, resultStr.length, truncation.originalTokens);
          }
          applyPostProcessOutcome(toolUse, resultStr, false, toolSig);
        } else {
          const err = r.reason;
          tlog('%s tool error (%s): %s', logScope, toolUse.name, err.message);
          toolResults.push({ name: toolUse.name, result: `ERROR: ${err.message}` });
          toolErrors.push({ name: toolUse.name, path: toolUse.params.path || toolUse.params.command || '', snippet: err.message });
          const prev = toolErrorCounts.get(toolSig) || { count: 0, lastSnippet: '' };
          toolErrorCounts.set(toolSig, { count: prev.count + 1, lastSnippet: (err.message || '').slice(0, 200) });
        }
      }
    };

    for (const toolUse of toolUses) {
      // One-line tool summary: name + compact arg preview. For MCP calls, show
      // tool_name + arguments inline so we can see what's being fetched.
      const argPreview = toolUse.name === 'use_mcp_tool'
        ? `${toolUse.params.tool_name}(${String(toolUse.params.arguments || '').replace(/\s+/g, ' ').slice(0, 80)})`
        : Object.entries(toolUse.params)
            .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').slice(0, 60)}`)
            .join(' ')
            .slice(0, 160);
      tlog('%s tool: %s %s', logScope, toolUse.name, argPreview);

      // Hold attempt_completion aside; only fire after we've seen everything else.
      if (toolUse.name === 'attempt_completion') {
        pendingCompletion = toolUse.params.result || '';
        continue;
      }

      // W1.PATH — per-tool checkPermissions gate (Section E + Section L of
      // HARNESS_EVOLUTION.md). Each write-class tool exposes
      // `checkPermissions(params, ctx) → { verdict, reason }`. The
      // default cascade (defined in chat/server/agent/tools/util/check-
      // permissions.js) covers: workspace escape, protected files
      // (.github/workflows, .template-version, .gitignore, .env*),
      // `forbidden_paths` from .harness/contracts.json's file_structure
      // (the wrong-language deny), generated_dirs (replaces the prior
      // W1.TYPES.GEN inline deny here), and scope folder lockdown (with
      // the agreed `backend/vectordb-connections.ts` carve-out for the
      // vectordb scope).
      //
      // First deny wins; the dispatch is short-circuited with the deny
      // reason emitted as the tool result. The UX matches the previous
      // inline-deny block exactly so the model sees the same kind of
      // refusal message.
      const permissionChecker = getToolPermissionChecker(toolUse.name);
      if (permissionChecker) {
        let permissionVerdict;
        try {
          permissionVerdict = permissionChecker(toolUse.params, {
            workspaceDir: WORKSPACE_DIR,
            scope,
          });
        } catch (err) {
          // Defensive: a throwing permission check should not crash the
          // run. Treat as deny so the model gets a clear signal.
          permissionVerdict = {
            verdict: 'deny',
            reason: `checkPermissions threw for ${toolUse.name}: ${err.message}`,
          };
        }
        // `ask` is reserved for the Phase 3 investigator-confirm flow;
        // treat as deny defensively today.
        if (permissionVerdict && (permissionVerdict.verdict === 'deny' || permissionVerdict.verdict === 'ask')) {
          tlog('%s BLOCKED %s (checkPermissions: %s)',
            logScope, toolUse.name, permissionVerdict.reason);
          const msg = `ERROR: ${toolUse.name} refused — ${permissionVerdict.reason}`;
          await flushPendingDispatches();
          toolResults.push({ name: toolUse.name, result: msg });
          toolErrors.push({
            name: toolUse.name,
            path: toolUse.params.path || toolUse.params.dest || toolUse.params.command || '',
            snippet: msg.slice(0, 200),
          });
          continue;
        }
      }

      // Permission pipeline — single ordered cascade of dispatch-time gates
      // (gather-lock, task-impossibility lock, phase-tool whitelist,
      // error-repeat lock). Pure decision; agent loop applies any returned
      // state changes (release of the task-impossibility lock on a
      // productive write tool) and pushes the synthetic error result for
      // deny decisions. See chat/server/agent/permission-pipeline.js.
      const decision = decideTool(toolUse, {
        verificationGatherLocked,
        taskImpossibilityLocked,
        phaseMachine,
        toolErrorCounts,
        iter,
      });
      if (decision.releaseLogTags) {
        for (const tag of decision.releaseLogTags) tlog('%s %s', logScope, tag);
      }
      if (decision.stateChanges?.taskImpossibilityLocked === false) {
        taskImpossibilityLocked = false;
      }
      if (decision.behavior === 'deny-hard' || decision.behavior === 'deny-soft') {
        await flushPendingDispatches();
        tlog('%s %s', logScope, decision.logTag);
        toolResults.push({ name: toolUse.name, result: decision.message });
        // deny-hard counts as a tool error (feeds the stop-hook tool-error-
        // batching validator → suppresses any attempt_completion bundled
        // alongside, forces another turn). deny-soft is informational —
        // model sees the advisory in toolResults but a bundled
        // attempt_completion can still land. See B7 severity ladder in
        // chat/server/agent/permission-pipeline.js.
        if (decision.behavior === 'deny-hard') {
          toolErrors.push({
            name: toolUse.name,
            path: toolUse.params.path || toolUse.params.command || '',
            snippet: decision.message.slice(0, 160),
          });
        }
        continue;
      }

      // Stable signature for post-dispatch error-repeat tracking. Same as the
      // pipeline's internal computation; declared here so success/failure
      // bookkeeping below can reset / increment the counter under the same key.
      const toolSig = toolSignature(toolUse.name, toolUse.params);

      // Microcompact stub check (synchronous; runs BEFORE deciding batch
      // vs serial). Stubs don't go through dispatchTool — they short-circuit
      // a re-read against the in-run cache. Process them serially: flush
      // any pending concurrent reads first, then apply the stub outcome
      // synchronously to preserve toolResults order.
      let stubFired = false;
      let stubResult;
      if (microcompact) {
        try {
          const stub = microcompact.maybeStub(toolUse.name, toolUse.params, iter);
          if (stub.replaced) {
            stubFired = true;
            stubResult = stub.result;
            tlog('%s microcompact: stubbed %s(%s) at turn %d', logScope,
              toolUse.name, toolUse.params.path || '?', iter + 1);
          }
        } catch (err) {
          // maybeStub is synchronous + read-only over its own cache; treat
          // any throw the same way the prior try/catch did.
          await flushPendingDispatches();
          tlog('%s tool error (%s): %s', logScope, toolUse.name, err.message);
          toolResults.push({ name: toolUse.name, result: `ERROR: ${err.message}` });
          toolErrors.push({ name: toolUse.name, path: toolUse.params.path || toolUse.params.command || '', snippet: err.message });
          const prev = toolErrorCounts.get(toolSig) || { count: 0, lastSnippet: '' };
          toolErrorCounts.set(toolSig, { count: prev.count + 1, lastSnippet: (err.message || '').slice(0, 200) });
          continue;
        }
      }

      if (stubFired) {
        await flushPendingDispatches();
        applyPostProcessOutcome(toolUse, stubResult, true, toolSig);
        continue;
      }

      // Dispatch path. Concurrency-safe tools (read_file, list_files,
      // use_mcp_tool) queue into pendingDispatches and run in parallel;
      // unsafe tools flush first, then dispatch serially.
      const ctx = {
        emit, signal, writtenPaths,
        // W1.PATH — Section L. Every file-touching tool resolves its input
        // path against `ctx.workspaceDir` exactly once at entry via
        // `resolveWorkspacePath`. Threaded here so the dispatcher and the
        // tool-level `checkPermissions` hooks share the same resolution
        // base. Defaults to the module-level WORKSPACE_DIR today; a future
        // per-session workspace override (Section A "session-scoped
        // .harness/") can land without re-touching every tool body.
        workspaceDir: WORKSPACE_DIR,
        scope,
        // Phase-agent spawn tools (Part B) need these to dispatch a child
        // runCustomAgent. Threaded via ctx to avoid circular import
        // between tools/core.js and agent.js.
        sessionId,
        subagentDepth,
        runCustomAgent,
        phaseMachine,
      };

      if (isToolConcurrencySafe(toolUse.name) && pendingDispatches.length < concurrencyCap) {
        // Eagerly kick off the dispatch without awaiting; flush will collect.
        // Promise rejections are caught by Promise.allSettled inside the flush.
        pendingDispatches.push({
          toolUse,
          toolSig,
          dispatchPromise: dispatchTool(toolUse.name, toolUse.params, ctx),
        });
        continue;
      }

      // Unsafe tool, or batch already at concurrency cap: flush pending
      // reads first so their results land in input order, then dispatch
      // this tool and immediately flush its single-element batch so its
      // outcome (and any state mutations like verificationBuildPassed)
      // observed by the next iteration's guards.
      await flushPendingDispatches();
      pendingDispatches.push({
        toolUse,
        toolSig,
        dispatchPromise: dispatchTool(toolUse.name, toolUse.params, ctx),
      });
      await flushPendingDispatches();
    }

    // Final flush: any tail-end concurrent batch that didn't hit a non-safe
    // tool or the cap (e.g. a turn that ended with multiple read_file calls).
    await flushPendingDispatches();

    // Decide whether to honour attempt_completion (Track B item B3 — stop
    // hooks). Held-aside attempt_completion runs through a validator cascade
    // (tool-error-batching → ghost-file → scope-required-files → pre-build-
    // CHECK-4); first blocker wins. Blocker → don't terminate, inject
    // directive in the next user turn. No blocker → terminate cleanly.
    // See chat/server/agent/stop-hooks.js.
    const stopResult = pendingCompletion !== null
      ? runStopHooks(pendingCompletion, {
          toolErrors,
          scope,
          workspaceDir: WORKSPACE_DIR,
          writtenPaths,
          phaseMachine,
        })
      : { blocking: false };

    if (pendingCompletion !== null && !stopResult.blocking) {
      completionText = pendingCompletion;
      emit({ say: 'completion_result', text: completionText });
      terminated = true;
    } else if (stopResult.blocking) {
      tlog('%s %s', logScope, stopResult.logTag);
    }

    if (terminated) {
      // Fill in any Dockerfile the model was supposed to cp but skipped, plus
      // any stack-specific scaffolding files (e.g. React+Vite package.json).
      // Both are evidence-driven and only fire on EXECUTING.
      ensureScopeDockerfile(scope, writtenPaths, emit, logScope, prompt);
      ensureScopeScaffolding(scope, writtenPaths, emit, logScope);
      return endPhase({ exitCode: 0, conversationId: currentConversationId, completionText, usage: aggregatedUsage, runTokenTotals: { promptTokens: sessionTotals.prompt_tokens, completionTokens: sessionTotals.completion_tokens, cachedTokens: sessionTotals.cached_tokens, apiCalls: sessionTotals.turns, truncations: sessionTotals.truncations }, virtualHistory: history, writtenPaths: [...writtenPaths], buildPassed: verificationBuildPassed });
    }

    // --- 4. Build the next user message — task reminder + contract blocks +
    // tool results.
    //
    // Per an experiment, stripping the task reminder caused the model to
    // "lose" the task ("I see tool results but no explicit task request
    // yet"). MGA has the task in history, but the model's recency bias
    // anchors it on the most recent user message — if that's just tool
    // results, it loses the thread. The reminder is a minimal structural
    // anchor, not behavioral scaffolding.
    //
    // Same recency-bias bug observed t38 (2026-05-09) for the contract
    // blocks: frontend agent on turn 2 reported "missing === UI CONTRACT ===
    // / === API CONTRACT === sections" even though they were in turn-1's
    // spawn message. Re-injecting the contracts here closes the hallucination
    // path — the agent always sees them in the latest user message.
    //
    // Everything else (gather nudges, results header, verbose error
    // boilerplate) was noise — dropped. Error notices are kept for the
    // two cases where the model needs an explicit signal that an
    // attempt_completion was rejected.
    const taskReminder = taskSpec
      ? `[TASK]\n${taskSpec}\n\n`
      : '';
    // Gate the reminder to early turns only. The hallucination we're closing
    // (frontend on t38 turn 2: "missing UI/API contract") happens at the
    // gather→write transition. After turn 3 the agent has seen the contracts
    // up to twice as a re-injection (plus turn 1's spawn message in MGA
    // history); if it's still confused, the bug is upstream and more
    // reminders just bloat context. Cap at 2 turns of re-injection — that
    // limits the worst-case extra context to ~6 KB per scope per run, well
    // under the rotation threshold.
    const contractReminder = (contractBlocks && iter <= 2)
      ? `${contractBlocks}\n\n`
      : '';

    // Stop-hook directive message (B3 + B4). When a validator blocked the
    // completion above, runStopHooks already composed the directive user
    // message via composeBlockingMessage in error-formatter.js. Empty string
    // when nothing blocked or no completion was emitted.
    const errorNotice = stopResult.blocking ? stopResult.message : '';

    // W3.RECOV — stale-diff recovery (Addition 1, HEADLINE). When this
    // batch produced ≥2 `replace_in_file` errors with the
    // `SEARCH block ... did not match` signature, the agent is operating
    // on a stale view of those files — a sibling-scope reconciler or
    // post-write validator rewrote them between turns. Without recovery,
    // the agent retries the same diffs each turn and spins until
    // MAX_ITERATIONS (the failure mode bisected to pre-W1.PATH in the
    // post-Phase-1 + post-Phase-2 flake notes). We synthesise a
    // `read_file` tool-result for each affected path so the agent's
    // next turn sees the file's CURRENT on-disk state.
    //
    // Per-path budget: cap at MAX_FIX_ATTEMPTS_PER_SCOPE re-injections
    // for the same path within this run. If the agent still emits stale
    // diffs after the budget, the orchestrator-level auto-recovery
    // loop handles it (different dispatch primitive).
    //
    // Telemetry: tlog `[auto-recovery] stale-diff detected` parallel to
    // the orchestrator-loop telemetry; typed transcript event
    // `auto_recovery_stale_diff` (logAndSwallow per L.5).
    let staleDiffInjection = '';
    const staleDiffPaths = detectStaleDiffPaths(toolErrors);
    // Fire on the FIRST SEARCH-mismatch (threshold lowered from N≥2 → N≥1
    // on 2026-05-21 after observing that the LLM autoregressively
    // hallucinates literal strings even when the structural code IS in the
    // file — e.g., it wrote `message: 'User not authenticated'` in turn 1
    // but later composes SEARCH with `message: 'Authentication required'`
    // (the training-data default). Telling the LLM "use prior tool-result
    // content" via the system prompt has no effect because the LLM is
    // confident in its (wrong) memory. Stale-diff recovery injects the
    // actual disk bytes as a synthesised read_file, giving the LLM exact
    // anchoring on its next turn. Per-path budget (MAX_FIX_ATTEMPTS_PER_SCOPE)
    // still caps runaway re-injection for the same file.
    if (staleDiffPaths.length >= 1) {
      const injected = [];
      const skipped = [];
      for (const p of staleDiffPaths) {
        const used = staleDiffReinjections.get(p) || 0;
        if (used >= MAX_FIX_ATTEMPTS_PER_SCOPE) {
          skipped.push({ path: p, used });
          continue;
        }
        const block = buildReadFileInjection(WORKSPACE_DIR, p);
        if (block) {
          injected.push(block);
          staleDiffReinjections.set(p, used + 1);
        }
      }
      if (injected.length) {
        tlog('%s [auto-recovery] stale-diff detected: scope=%s paths=%j fixAttempts=%j budget=%d',
          logScope, scope || 'none',
          [...staleDiffReinjections.keys()],
          Object.fromEntries(staleDiffReinjections),
          MAX_FIX_ATTEMPTS_PER_SCOPE);
        try {
          const event = appendEvent(sessionId, 'auto_recovery_stale_diff', {
            type: 'auto_recovery_stale_diff',
            sessionId,
            ts: Date.now(),
            scope: scope || null,
            paths: staleDiffPaths,
            injected: injected.length,
            skipped,
            budget: MAX_FIX_ATTEMPTS_PER_SCOPE,
            action: 'injected-read-files',
          });
          sessionEvents.emit('event', sessionId, event);
        } catch (err) {
          logAndSwallow(err, '[telemetry-auto-recovery-stale-diff]');
        }
        const header =
          `[STALE-DIFF RECOVERY — ${injected.length} file(s) re-read]\n` +
          `Your last batch produced ${staleDiffPaths.length} replace_in_file SEARCH-block-no-match errors. ` +
          `The harness re-read each affected file. Use the EXACT text shown below for any new replace_in_file ` +
          `calls, or use write_to_file with the corrected full content.\n\n`;
        staleDiffInjection = header + injected.join('\n\n') + '\n\n';
      }
    }

    const toolResultBlock = toolResults
      .map(({ name, result }) => `[TOOL RESULT — ${name}]\n${result}\n[/TOOL RESULT]`)
      .join('\n\n');

    // Gather-only tracking. Resets whenever the model writes/runs/finalizes.
    const allGather = toolUses.length > 0 && toolUses.every(t => GATHER_TOOLS.has(t.name));
    gatherOnlyTurns = allGather ? gatherOnlyTurns + 1 : 0;

    // Release the verification gather lock the moment the model takes a
    // productive action (execute_command / write_to_file / replace_in_file).
    // Without this, a model that hits the gather-lock once stays locked for
    // the rest of the run — which over-blocks legitimate post-build-failure
    // diagnostic reads. The lock will re-engage if the model drifts back
    // into 4+ consecutive gather-only turns.
    if (scope === 'verification' && verificationGatherLocked) {
      const tookAction = toolUses.some(t =>
        t.name === 'execute_command' ||
        t.name === 'write_to_file' ||
        t.name === 'replace_in_file'
      );
      if (tookAction) {
        verificationGatherLocked = false;
        tlog('%s gather lock RELEASED — model took productive action', logScope);
      }
    }

    // Track first-write iteration for the secondary finalize trigger.
    if (writtenPaths.size > 0 && firstWriteIter === -1) {
      firstWriteIter = iter;
    }
    const turnsSinceFirstWrite = firstWriteIter >= 0 ? iter - firstWriteIter : -1;

    // Fire the finalize/write nudge on EITHER condition:
    //   (a) N consecutive gather-only turns — the original signal
    //   (b) writes have succeeded AND >=2 turns have passed since the first
    //       write without attempt_completion — catches the read→execute→read
    //       alternation loop where (a) never triggers because execute_command
    //       resets the gather counter
    //
    // Verification scope gets a higher gather threshold and a softer nudge text.
    // Its job is fundamentally "read 3-5 files to compare contracts, then build"
    // — forbidding read_file by turn 2 pushed the model into a pathological
    // failure mode where it internalized "I can't use read_file" and hallucinated
    // a fake conversation transcript to satisfy contradictory pressure. Giving
    // verification 4 gather turns before nudging, and keeping read_file off the
    // forbidden list, lets CHECK 2/3 investigation complete naturally.
    const gatherThreshold = scope === 'verification' ? 4 : 2;
    const gatherTriggered = gatherOnlyTurns >= gatherThreshold;
    const stallTriggered = writtenPaths.size > 0 && turnsSinceFirstWrite >= 2;
    // Build-passed nudge: once the build step has returned exit 0, push the
    // agent toward attempt_completion via text pressure. After Track B B5
    // there's no structural lock backing this — tryAutoStartApp re-runs the
    // build authoritatively at session boundary, so an over-eager loop here
    // costs a few extra turns at most.
    const buildPassedStall = verificationBuildPassed;

    // Write-pressure finalize nudge — only meaningful for phases that produce
    // file writes (SUBAGENT, incl. verification). For ORCHESTRATING /
    // INVESTIGATING the generic branch below would inject "Do NOT call
    // read_file / list_files", which is actively wrong for a read-only agent
    // whose product IS reading. Same gate as the task-impossibility lock: read-
    // only phases terminate via their prompt + MAX_ITERATIONS + (investigator)
    // INVESTIGATOR_PHASE_TIMEOUT_MS, not via write-pressure.
    let gatherNudge = '';
    if (phaseMachine.producesFileWrites() && (gatherTriggered || stallTriggered || buildPassedStall)) {
      tlog('%s nudge fired — gatherTurns=%d writtenPaths=%d sinceFirstWrite=%d buildPassed=%s',
        logScope, gatherOnlyTurns, writtenPaths.size, turnsSinceFirstWrite, verificationBuildPassed);
      if (buildPassedStall) {
        // Build exit 0 + any further turn = verify-theater. Advisory text
        // pressure only — tryAutoStartApp at the session boundary is the
        // structural backstop.
        gatherNudge =
          `[BUILD PASSED — FINALIZE NOW]\n` +
          `docker-compose build has returned exit 0. That IS the verification closure criterion.\n` +
          `Your next response MUST be attempt_completion with an implementation report covering CHECK 1-4 outcomes. ` +
          `Stop verifying, emit the report.\n\n`;
      } else if (writtenPaths.size > 0) {
        // Writes have already succeeded. The loop is at the "emit completion"
        // step, not the "get work done" step. Push hard toward attempt_completion.
        const list = [...writtenPaths].map(p => `- ${p}`).join('\n');
        gatherNudge =
          `[FINALIZE NOW — work is done, ${turnsSinceFirstWrite} turn(s) since your writes succeeded]\n` +
          `You have already written these files this run:\n${list}\n\n` +
          `The work is done. Your next response MUST be attempt_completion with an ` +
          `implementation report listing the paths above. Do NOT re-read these files, ` +
          `do NOT re-run verification (even if the last verification succeeded — running it again will not change anything), ` +
          `do NOT fetch more rules/snippets. Finalize.\n\n`;
      } else if (scope === 'verification') {
        // Verification-specific push. Three prior iterations failed on pure
        // text pressure — soft nudge, blanket nudge, and path-listed surgical
        // nudge all got ignored (model kept re-reading App.jsx, looping
        // list_files on three directories, etc). Empirical conclusion: the
        // Coder assistant does not reliably honor "do not call X" instructions
        // in verification. So we flip the dispatcher lock here; gather tools
        // are rejected at call time starting next turn. The nudge text now
        // describes WHAT was locked so the model knows why its gather calls
        // are failing, but the enforcement is real, not advisory.
        verificationGatherLocked = true;
        gatherNudge =
          `[GATHER PHASE ENDED — ${gatherOnlyTurns} turns, now locked]\n` +
          `read_file, list_files, and use_mcp_tool are now blocked in this verification run. ` +
          `Calls to them will return a synthetic error — don't bother retrying.\n\n` +
          `Your next response MUST be one of:\n` +
          `- execute_command running \`docker-compose build\` (the required build test — run this first if you have not yet)\n` +
          `- write_to_file or replace_in_file, ONLY if you identified a specific contract mismatch that needs fixing\n` +
          `- attempt_completion, ONLY if docker-compose build has already returned exit 0\n\n`;
      } else {
        // Scoped phases — neutral "finalize OR act" framing. Previously this
        // was "[WRITE NOW]" which biased the model toward writing SOMETHING
        // when it couldn't find what the task required, producing hallucinated
        // completions (e.g. the /ping test: asked to mark a non-existent
        // endpoint as deployed, the old nudge pushed the model to fabricate
        // a brand-new PROJECT_STATUS.md at the wrong path with fake content,
        // then finalize claiming success). The reframing:
        //   - headline is neutral, not biased toward writes
        //   - attempt_completion is listed first with explicit permission to
        //     emit it for infeasible tasks
        //   - "do not fabricate" is stated explicitly
        gatherNudge =
          `[FINALIZE OR ACT — ${gatherOnlyTurns} gather-only turns]\n` +
          `Your next response must be ONE of:\n` +
          `- attempt_completion: emit this if (a) you have enough information to finalize, OR ` +
          `(b) the task is infeasible — the entity you were asked to modify doesn't exist, ` +
          `a precondition isn't met, or the resource is missing. In case (b), the report should ` +
          `explain exactly what you checked and what's missing. "Not found" is a valid outcome.\n` +
          `- write_to_file / replace_in_file: ONLY when the task clearly requires creating or editing ` +
          `a SPECIFIC file AND you know the exact content. Do NOT create a placeholder or fabricated ` +
          `file just to "have something to show." A write invented to satisfy this nudge is a failure, not a success.\n` +
          `- execute_command: if you need to run a build / test / install.\n\n` +
          `Do NOT call get_rules, get_snippet, list_snippets, list_files, or read_file.\n\n`;
      }
    }

    // W3.RECOV — staleDiffInjection prepended BEFORE toolResultBlock so
    // the agent sees the re-read content adjacent to the error results
    // that explain why it was injected. Gather nudge / task / contracts
    // come first; the recovery hint sits at the natural seam between
    // error notice and tool results.
    currentMessage = gatherNudge + taskReminder + contractReminder + errorNotice + staleDiffInjection + toolResultBlock;
  }

  // Exceeded iteration cap
  tlog('%s hit max iterations (%d) — terminating turn', logScope, MAX_ITERATIONS);
  emit({
    ask: 'api_req_failed',
    text: JSON.stringify({
      message: `Agent exceeded ${MAX_ITERATIONS} tool-use iterations without completing. The task may be stuck in a loop.`,
      status: 500,
      providerId: 'custom-agent',
    }),
  });
  return endPhase({ exitCode: 1, conversationId: currentConversationId, completionText, usage: aggregatedUsage, runTokenTotals: { promptTokens: sessionTotals.prompt_tokens, completionTokens: sessionTotals.completion_tokens, cachedTokens: sessionTotals.cached_tokens, apiCalls: sessionTotals.turns, truncations: sessionTotals.truncations }, virtualHistory: history, writtenPaths: [...writtenPaths], buildPassed: verificationBuildPassed });
}
