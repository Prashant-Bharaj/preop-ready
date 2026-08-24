/**
 * CompactionTrigger — decides when to rotate the MGA conversation.
 *
 * Phase 3 of the compaction architecture. Consumed by agent.js at the top of
 * each loop iteration. When shouldRotate returns `{rotate: true}`, agent.js
 * calls the summarizer, seeds a fresh MGA conversation_id with the summary,
 * and resets per-run state.
 *
 * Thresholds are Claude-Code-derived (src/services/compact/autoCompact.ts):
 *   - autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
 *   - effectiveContextWindow = contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY
 *   - Claude Code constants: AUTOCOMPACT_BUFFER_TOKENS = 13_000,
 *     MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
 *   - For Claude Opus 200K → threshold ≈ 167K. Our default is 134K (80% of
 *     that, safety margin because we estimate tokens client-side rather
 *     than reading them from the API).
 *
 * All env vars are int-coerced with fallback to the baked-in defaults.
 * Use COMPACT_THRESHOLD_TOKENS=30000 (or similar) to force rotation on
 * small test workloads for synthetic verification.
 *
 * Circuit breaker: on 3 consecutive summarizer/rotation failures, the
 * trigger disables itself for the rest of the run and agent.js falls back
 * to MGA's buffer_length FIFO truncation (blunt but safe).
 */

// Sized for claude-sonnet-4.5's 1,048,576-token context window (MGA's hosted
// Anthropic model as of 2026-05). Originally 134K (sized for Claude Opus
// 200K window with 67% safety margin). Bumping to 700K leaves comfortable
// headroom for the summarizer's own work AND eliminates rotation events for
// almost every normal build — t11 + t6 backend runs both top out at ~140K
// virtual tokens even on long convos, so we essentially never trigger
// rotation in practice. The rotation path was lossy (summarizer
// occasionally returns no <summary> block → fallback to microcompact);
// skipping it entirely is the right move now that /chat/completions ships
// full history with prompt caching keeping the cost manageable.
const DEFAULT_COMPACT_THRESHOLD_TOKENS = 700_000;
const DEFAULT_ROTATION_ITER_LIMIT = 10;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
// Cooldown: minimum iterations between rotations. Without this, MGA's
// buffer_length re-sends recent history on every turn, so cumulative
// tokens spike back over the threshold within 2 turns and we rotate
// again. Observed empirically on a threshold=10K synthetic test: 5
// rotations in 10 turns with ~60s of pure summarizer latency. With a
// cooldown of 5 turns, the model has room to do real work after a
// rotation before we consider compacting again.
const DEFAULT_ROTATION_COOLDOWN_TURNS = 5;

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class CompactionTrigger {
  constructor({
    compactThresholdTokens = intFromEnv('COMPACT_THRESHOLD_TOKENS', DEFAULT_COMPACT_THRESHOLD_TOKENS),
    rotationIterLimit = intFromEnv('ROTATION_ITER_LIMIT', DEFAULT_ROTATION_ITER_LIMIT),
    maxConsecutiveFailures = intFromEnv('MAX_CONSECUTIVE_COMPACT_FAILURES', DEFAULT_MAX_CONSECUTIVE_FAILURES),
    cooldownTurns = intFromEnv('ROTATION_COOLDOWN_TURNS', DEFAULT_ROTATION_COOLDOWN_TURNS),
  } = {}) {
    this.compactThresholdTokens = compactThresholdTokens;
    this.rotationIterLimit = rotationIterLimit;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.cooldownTurns = cooldownTurns;
    this.consecutiveFailures = 0;
    this.disabled = false;
    this.rotationCount = 0;
    // Iteration index of the most recent successful rotation. Cooldown
    // check: `iter - lastRotatedAtIter < cooldownTurns` ⇒ suppress.
    // -Infinity initial so the first rotation is never suppressed.
    this.lastRotatedAtIter = -Infinity;
  }

  /**
   * Decide whether the current state warrants a rotation. Call at the top of
   * each agent iteration, before the LLM call.
   *
   * @param {object} args
   * @param {VirtualHistoryManager} args.history
   * @param {number} args.iter - current iteration index (0-based)
   * @param {boolean} [args.rotationJustDone] - set true when we've just
   *   rotated this iteration, to prevent a second back-to-back rotation
   * @returns {{ rotate: boolean, reason: string|null, metrics: object }}
   */
  shouldRotate({ history, iter, rotationJustDone = false }) {
    const tokens = history?.estimateVirtualTokens?.() ?? 0;
    const turnsSinceLastRotation = iter - this.lastRotatedAtIter;
    const metrics = {
      virtualTokens: tokens,
      iter,
      threshold: this.compactThresholdTokens,
      disabled: this.disabled,
      failures: this.consecutiveFailures,
      turnsSinceLastRotation,
      cooldownTurns: this.cooldownTurns,
    };

    if (this.disabled) return { rotate: false, reason: null, metrics };
    if (rotationJustDone) return { rotate: false, reason: null, metrics };

    // Cooldown — after a rotation, let the model work for N turns before we
    // consider another. Without this, MGA's buffer_length causes cumulative
    // tokens to re-exceed the threshold within 2 turns, producing a rotation
    // storm (observed: 5 rotations in 10 turns with ~60s of summarizer
    // latency, and the model re-doing already-finished work).
    if (turnsSinceLastRotation < this.cooldownTurns) {
      return {
        rotate: false,
        reason: `cooldown: only ${turnsSinceLastRotation} turns since last rotation (need ≥${this.cooldownTurns})`,
        metrics,
      };
    }

    if (tokens > this.compactThresholdTokens) {
      return {
        rotate: true,
        reason: `virtualTokens=${tokens} > threshold=${this.compactThresholdTokens}`,
        metrics,
      };
    }
    if (iter > this.rotationIterLimit) {
      return {
        rotate: true,
        reason: `iter=${iter} > rotationIterLimit=${this.rotationIterLimit}`,
        metrics,
      };
    }

    return { rotate: false, reason: null, metrics };
  }

  /**
   * Called by agent.js after a rotation succeeds. Records the iteration
   * index so the cooldown check has a baseline.
   */
  recordSuccess(iter) {
    this.consecutiveFailures = 0;
    this.rotationCount += 1;
    if (typeof iter === 'number') this.lastRotatedAtIter = iter;
  }

  recordFailure() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.disabled = true;
    }
  }

  getStats() {
    return {
      disabled: this.disabled,
      consecutiveFailures: this.consecutiveFailures,
      rotationCount: this.rotationCount,
      compactThresholdTokens: this.compactThresholdTokens,
      rotationIterLimit: this.rotationIterLimit,
    };
  }
}

/**
 * Build the user message seeded to a rotated conversation. The message has:
 *   - boundary marker (explicit signal this is a rotation)
 *   - summary block (9-section state summary from summarizer)
 *   - list of files already written (so the model doesn't redo work)
 *   - tool protocol reminder (fresh MGA conversation = model's "memory" of
 *     the XML tool format lives in its system prompt, but the reminder
 *     anchors it)
 *   - original task specification
 *   - next-action hint biased toward finishing
 */
export function buildRotationUserMessage({ summaryText, writtenPaths, taskSpec }) {
  const lines = [];
  lines.push('=== CONVERSATION ROTATED (context threshold reached) ===');
  lines.push('');
  lines.push('The previous conversation grew too long and was summarized. Below is the state summary of work so far.');
  lines.push('');
  lines.push('--- State summary ---');
  lines.push(summaryText || '(no summary generated — context was too long but summarizer was unavailable)');
  lines.push('');
  if (writtenPaths?.size) {
    lines.push('--- Files already written or modified this run ---');
    for (const p of writtenPaths) lines.push(`- ${p}`);
    lines.push('');
    lines.push('These files ARE on disk with the content you produced. Do NOT re-write them. Do NOT re-read them to "verify." Trust the summary above.');
    lines.push('');
  }
  lines.push('--- Original task ---');
  lines.push(taskSpec || '(task specification not captured — see State summary Section 1)');
  lines.push('');
  lines.push('--- Next action (read carefully) ---');
  lines.push(
    'Check Section 7 of the summary ("Pending Tasks"). If it says "All task requirements appear to be met" or ' +
    'equivalent, your NEXT response MUST be attempt_completion with the implementation report from ' +
    'Section 3. Do NOT re-write files listed above, do NOT re-run verification, do NOT re-gather rules/snippets. ' +
    'Only if Section 7 explicitly names missing work should you take another action — and only the specific action ' +
    'Section 7 identifies.'
  );
  return lines.join('\n');
}
