/**
 * Permission Pipeline — single ordered cascade of dispatch-time gates.
 *
 * Replaces the 5 inline gate blocks that used to live in agent.js around the
 * tool-use loop. Each gate is a pure function `(toolCall, ctx) → decision`
 * with one of four outcomes:
 *
 *   - { behavior: 'allow' }                               — gate doesn't fire
 *   - { behavior: 'allow', stateChanges, logTag? }        — gate fires and
 *     auto-releases (e.g. write tool releases the task-impossibility lock);
 *     caller applies the state change and continues the cascade
 *   - { behavior: 'deny-soft', reason, message, logTag, extra? }
 *                                                          — tool dispatch
 *     blocked; caller adds the message to toolResults so the model sees the
 *     advisory, but DOES NOT push to toolErrors. A soft-deny bundled with
 *     attempt_completion does NOT trigger the tool-error-batching stop-hook
 *     — the completion can land. Use for informational/advisory blocks
 *     where the model has enough info to either finalize or change tactics.
 *   - { behavior: 'deny-hard', reason, message, logTag, extra? }
 *                                                          — tool dispatch
 *     blocked AND counted as a tool error. A hard-deny bundled with
 *     attempt_completion triggers stop-hook suppression; the model is
 *     forced into another turn. Use for "wrong phase / wrong tool / model
 *     stuck" cases where the dispatch must not be allowed AND the
 *     completion must wait for a corrected next turn.
 *
 * Order matters — first deny wins. Allow-with-state-change keeps the cascade
 * going so subsequent gates evaluate against the released state, matching the
 * pre-refactor inline fall-through semantics exactly.
 *
 * Severity ladder (Track B B7) — tightest at top, loosest at bottom:
 *   gather-lock           : DENY-HARD  (verification-only, history shows
 *                                       text pressure alone insufficient)
 *   task-impossibility    : DENY-HARD  (releases on write, has escape hatch)
 *   phase-tool-whitelist  : DENY-HARD  (wrong tool for phase, no advisory)
 *   error-repeat          : DENY-SOFT  (3-strikes is informational; let
 *                                       attempt_completion land alongside)
 *
 * Modeled on Claude Code's `hasPermissionsToUseToolInner`
 * (utils/permissions/permissions.ts:1158-1319): ordered cascade with a uniform
 * return shape.
 */

/**
 * Tools that are pure information-gathering. Used by the verification
 * gather-lock to detect non-productive turns post gather-nudge.
 */
export const GATHER_TOOLS = new Set(['read_file', 'list_files', 'use_mcp_tool', 'task_progress']);

/**
 * Number of identical (name + params) tool errors before the error-repeat
 * gate blocks further dispatches. Counter resets on a successful dispatch
 * of the same signature.
 */
export const ERROR_REPEAT_BLOCK_THRESHOLD = 2;

/**
 * Stable signature for a tool call (name + sorted-key JSON params, capped to
 * 400 chars to bound the map key size for huge param payloads). Same
 * signature → same row in `toolErrorCounts`.
 */
export function toolSignature(name, params) {
  try {
    const p = params || {};
    const norm = Object.keys(p).sort().reduce((acc, k) => {
      acc[k] = p[k];
      return acc;
    }, {});
    return `${name}::${JSON.stringify(norm).slice(0, 400)}`;
  } catch {
    return `${name}::?`;
  }
}

const ALLOW = Object.freeze({ behavior: 'allow' });

/**
 * Gate 1 — Verification gather-lock.
 *
 * Once the gather-nudge has fired for a verification run, further gather-tool
 * calls are rejected at dispatch with a synthetic error. Text-pressure nudges
 * alone were empirically insufficient — the model kept list_files-looping the
 * same 3 directories. Hard enforcement guarantees the only productive path
 * out is build/write/finalize.
 */
function gatherLockGate(toolCall, ctx) {
  if (!ctx.verificationGatherLocked) return ALLOW;
  if (!GATHER_TOOLS.has(toolCall.name)) return ALLOW;
  return {
    behavior: 'deny-hard',
    reason: 'gather_lock',
    message:
      `ERROR: ${toolCall.name} is blocked in verification after the gather phase ended. ` +
      `Your next response MUST call execute_command (docker-compose build), ` +
      `write_to_file, replace_in_file, or attempt_completion. ` +
      `Further gather-tool calls will keep returning this error.`,
    logTag: `BLOCKED gather tool: ${toolCall.name} (verification lock)`,
  };
}

/**
 * Gate 2 — Task-impossibility lock.
 *
 * Fires when the model has had too many turns without any file writes,
 * suggesting the task is infeasible or the model is stuck. attempt_completion
 * is the only escape hatch by default.
 *
 * Release exception: a write tool releases the lock — the model is finally
 * ready to do real work. Without this, Test 6's frontend run hit the lock at
 * iter 9 (after re-fetching the same rules 4 times) and then had ALL 13 of
 * its batched writes blocked, turning recoverable confusion into a hard fail.
 */
function taskImpossibilityLockGate(toolCall, ctx) {
  if (!ctx.taskImpossibilityLocked) return ALLOW;
  if (toolCall.name === 'attempt_completion') return ALLOW;

  const isWriteTool = toolCall.name === 'write_to_file' || toolCall.name === 'replace_in_file';
  if (isWriteTool) {
    return {
      behavior: 'allow',
      stateChanges: { taskImpossibilityLocked: false },
      logTag: `task-impossibility lock RELEASED — ${toolCall.name} call indicates model is ready to write`,
    };
  }

  return {
    behavior: 'deny-hard',
    reason: 'task_impossibility',
    message:
      `ERROR: ${toolCall.name} is blocked. You've investigated for ${ctx.iter + 1} turns ` +
      `without writing any files. Either: (1) the task is infeasible — the thing you're ` +
      `looking for doesn't exist, or the required prerequisite isn't present — emit ` +
      `attempt_completion explaining what you found and what's missing, or (2) you ` +
      `already have enough information — call write_to_file with the corrected content, ` +
      `which will release this lock automatically.`,
    logTag: `BLOCKED ${toolCall.name} (task-impossibility lock)`,
  };
}

/**
 * Gate 4 — Phase-gated tool whitelist.
 *
 * In ORCHESTRATING phase, only orchestration tools are permitted. Any tool
 * outside the whitelist returns a synthetic error pointing the model at
 * attempt_completion (or at the correct alternative). This is the
 * dispatcher-level counterpart to the assistant's narrow system prompt.
 *
 * Whitelist owned by `PhaseStateMachine` in phase.js — this gate is the
 * runtime hookup.
 */
function phaseWhitelistGate(toolCall, ctx) {
  if (ctx.phaseMachine.isToolAllowed(toolCall.name)) return ALLOW;
  return {
    behavior: 'deny-hard',
    reason: 'phase_whitelist',
    message: ctx.phaseMachine.getBlockedToolMessage(toolCall.name),
    logTag: `BLOCKED ${toolCall.name} (phase=${ctx.phaseMachine.phase})`,
  };
}

/**
 * Gate 5 — Error-repeat lock.
 *
 * Tracks identical tool calls (same name + same args) that keep failing.
 * Claude Code's 3-strike circuit-breaker pattern: block on the 3rd
 * consecutive identical error (threshold = 2 prior errors). Successful
 * dispatch of the same signature resets the counter — transient failures
 * recover cleanly.
 *
 * Targets the pathological pattern observed in the /ping test: same call,
 * same error, repeated 4 times, model never gave up.
 */
function errorRepeatGate(toolCall, ctx) {
  const sig = toolSignature(toolCall.name, toolCall.params);
  const prev = ctx.toolErrorCounts.get(sig);
  if (!prev || prev.count < ERROR_REPEAT_BLOCK_THRESHOLD) return ALLOW;
  // SOFT-DENY (B7): the tool dispatch is blocked AND the model sees an
  // advisory message, but the block is NOT recorded as a tool error.
  // Rationale: 3-strikes-on-same-args is an informational signal — the
  // model should change approach OR finalize, but if it bundled a stale
  // failing call alongside attempt_completion, we don't want the soft
  // deny to suppress the completion via the tool-error-batching stop-
  // hook. Letting the completion land is the right call: the subagent
  // already has enough information to report.
  return {
    behavior: 'deny-soft',
    reason: 'error_repeat',
    message:
      `NOTICE: ${toolCall.name} skipped — you've called this exact command with these ` +
      `exact arguments ${prev.count} times already and gotten the same error every ` +
      `time. The most recent error was:\n  ${prev.lastSnippet}\n\n` +
      `Either: (1) try a materially different approach (different path, different tool, ` +
      `different arguments), or (2) emit attempt_completion with what you know — describe ` +
      `what you found and what you couldn't find.`,
    logTag: `SOFT-DENY ${toolCall.name} (error-repeat lock, count=${prev.count})`,
    extra: { count: prev.count },
  };
}

/**
 * Ordered cascade. Order is load-bearing — earlier gates take priority. The
 * order here matches the pre-refactor inline cascade exactly.
 */
const GATES = [
  gatherLockGate,
  taskImpossibilityLockGate,
  phaseWhitelistGate,
  errorRepeatGate,
];

/**
 * Run the cascade for a single tool call. Returns the first non-allow
 * decision (deny-soft or deny-hard); otherwise returns `allow` with any
 * accumulated stateChanges and release-log tags from gates that
 * auto-released along the way. First deny wins regardless of severity —
 * gates earlier in the array take priority over later gates.
 *
 * @param {{name: string, params: object}} toolCall
 * @param {{
 *   verificationGatherLocked: boolean,
 *   taskImpossibilityLocked: boolean,
 *   phaseMachine: { phase: string, isToolAllowed: (n: string) => boolean, getBlockedToolMessage: (n: string) => string },
 *   toolErrorCounts: Map<string, { count: number, lastSnippet: string }>,
 *   iter: number
 * }} ctx
 * @returns {{
 *   behavior: 'allow' | 'deny-soft' | 'deny-hard',
 *   reason?: string,
 *   message?: string,
 *   logTag?: string,
 *   stateChanges?: { taskImpossibilityLocked?: false },
 *   releaseLogTags?: string[],
 *   extra?: object
 * }}
 */
export function decideTool(toolCall, ctx) {
  let stateChanges = null;
  const releaseLogTags = [];

  for (const gate of GATES) {
    const r = gate(toolCall, ctx);
    if (r.behavior === 'deny-hard' || r.behavior === 'deny-soft') {
      return r;
    }
    if (r.stateChanges) {
      stateChanges = { ...(stateChanges || {}), ...r.stateChanges };
      if (r.logTag) releaseLogTags.push(r.logTag);
    }
  }

  if (stateChanges) {
    return { behavior: 'allow', stateChanges, releaseLogTags };
  }
  return ALLOW;
}
