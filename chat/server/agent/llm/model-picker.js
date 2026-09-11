/**
 * Shared model picker. Resolves the model used for a /chat/completions
 * call given the calling phase + scope + assistant-config default.
 *
 * Precedence (highest first):
 *   1. MGA_MODEL_OVERRIDE_<SCOPE>  — force one scope/phase (debugging)
 *   2. MGA_MODEL_OVERRIDE           — force whole run (A/B benchmarks)
 *   3. Phase-aware default:
 *        - SUBAGENT phase: INITIAL_BUILD_MODEL on initial build,
 *          ITERATE_MODEL on iterate / continuation pass.
 *        - All other build-time phases (UNDERSTANDING, CONTRACT, JUDGE,
 *          SUMMARIZER): INITIAL_BUILD_MODEL. Per 2026-05-24 the assistant-
 *          config default (opus-4.7) is non-deterministic and rejects
 *          temperature; pinning planner+judge+summarizer to the same
 *          INITIAL_BUILD_MODEL keeps the whole build on one deterministic
 *          model and lets MGA prompt-cache hits work across phases that
 *          share a model.
 *   4. Assistant config default (MGA's stored model for this assistant).
 *      Only reached when no override AND no phase rule applies — i.e.
 *      an unknown phase.
 *
 * Returns { model, source } where source describes WHY this model was
 * picked so callers can log it for run-log auditability.
 */
import { INITIAL_BUILD_MODEL, ITERATE_MODEL, CODER_MODEL, DEFAULT_MODEL } from '../../config/defaults.js';

const SUBAGENT_PHASES = new Set(['SUBAGENT', 'subagent']);
// Build-time phases that should pin to INITIAL_BUILD_MODEL by default.
// JUDGE included so the reconciler's Contract-Agent continuation shares
// the same model as the original Contract Agent call (prefix cache hits).
const INITIAL_BUILD_PHASES = new Set([
  'UNDERSTANDING', 'CONTRACT', 'JUDGE', 'SUMMARIZER',
]);

// Model is resolved 100% from config — NO MGA assistant lookup. Any phase
// without an explicit rule (CONCIERGE, INVESTIGATING, …) resolves to
// DEFAULT_MODEL, so the harness never depends on account-bound assistant IDs
// to pick a model. Tune any single scope/phase via MGA_MODEL_OVERRIDE_<SCOPE>.
export function pickModel({ phase, scope, isIterate = false }) {
  const scopeOverrideKey = scope ? `MGA_MODEL_OVERRIDE_${scope.toUpperCase()}` : null;
  const explicitOverride =
    (scopeOverrideKey && process.env[scopeOverrideKey])
    || process.env.MGA_MODEL_OVERRIDE
    || null;
  if (explicitOverride) {
    return { model: explicitOverride, source: ' (env override)' };
  }

  // Coding subagents (initial + fix agents): CODER_MODEL — Sonnet writes
  // code, Opus thinks (see defaults.js CODER_MODEL rationale). Note
  // MGA_MODEL_INITIAL intentionally does NOT reach this branch anymore: it
  // tunes the THINKING phases below; coders are tuned via MGA_MODEL_CODER.
  if (SUBAGENT_PHASES.has(phase)) {
    const phaseModel = isIterate
      ? (process.env.MGA_MODEL_ITERATE || ITERATE_MODEL)
      : (process.env.MGA_MODEL_CODER || CODER_MODEL);
    return { model: phaseModel, source: ` (phase=${isIterate ? 'iterate' : 'initial-coder'} default)` };
  }

  if (INITIAL_BUILD_PHASES.has(phase)) {
    const phaseModel = process.env.MGA_MODEL_INITIAL || INITIAL_BUILD_MODEL;
    return { model: phaseModel, source: ` (phase=${String(phase).toLowerCase()} default)` };
  }

  // Unknown phase — guaranteed global default (config only).
  return { model: DEFAULT_MODEL, source: ' (global default)' };
}
