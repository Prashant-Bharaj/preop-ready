/**
 * W3.RECOV — Auto-recovery loop. HARNESS_EVOLUTION.md §F.
 *
 * Runs AFTER the existing cross-scope reconciler (which handles
 * data_model / api_contract / ui_contract drift) and BEFORE
 * buildAndStartContainers. Collects failures from three new detectors:
 *
 *   1. structural-checks.js   — Dockerfile / nginx.conf invariants
 *   2. file-structure-check.js — required_files exist + > stub threshold
 *   3. runtime-asserts.js     — canonical-entry + dockerfile-sanity
 *                                (promoted from smoke-asserts.js)
 *
 * For each scope with failures: if `scopeCounters[scope].fixAttempts <
 * MAX_FIX_ATTEMPTS_PER_SCOPE` AND the cumulative MGA-token usage is
 * below `MAX_RECOVERY_TOKENS_PER_BUILD`, dispatch a fix run via the
 * existing `reengageScopeForMismatch` mechanism — same dispatch
 * primitive the reconciler uses, but with a different directive shape
 * (failure list framed as "structural-check / file-structure / runtime-
 * assert" rather than "cross-scope mismatch").
 *
 * On scope budget exhaustion: mark "user-attention" and stop trying.
 * On token budget exhaustion: end recovery phase, surface the remaining
 * failures.
 *
 * Telemetry: `[auto-recovery]` label parallel to L.3's `[reconciler-
 * loop]`. Typed transcript events: `auto_recovery_dispatch`,
 * `auto_recovery_scope_exhausted`, `auto_recovery_tokens_exhausted`,
 * `auto_recovery_done`. All telemetry writes wrap in `logAndSwallow` per L.5.
 *
 * The function is best-effort — any throw is caught and swallowed so a
 * recovery-loop bug never blocks the underlying build. Returns
 * `{ recoveredScopes, exhaustedScopes, tokensUsed, surfacedToUser }` for
 * the caller's final report.
 */

import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { appendEvent } from './transcript.js';
import { sessionEvents } from './events.js';
import { accumulateAgentTotals } from './lifecycle.js';
import { WORKSPACE_DIR } from '../core/paths.js';
import {
  MAX_FIX_ATTEMPTS_PER_SCOPE,
  MAX_RECOVERY_TOKENS_PER_BUILD,
} from '../config/defaults.js';
import { runStructuralChecks } from '../reconciler/structural-checks.js';
import { runMgaWiringChecks } from '../reconciler/mga-wiring-check.js';
import { runFileStructureCheck, formatFileStructureReport } from '../reconciler/file-structure-check.js';
import { runRuntimeAsserts } from '../reconciler/runtime-asserts.js';
import { runTypeGate } from '../reconciler/type-gate.js';
import { runRuntimeGateForScopes } from '../reconciler/runtime-gate.js';

/**
 * Emit a typed transcript event. Mirrors emitCascadeEvent's shape in
 * routes.js. logAndSwallow per L.5.
 */
function emitRecoveryEvent(sessionId, type, payload = {}) {
  try {
    const event = appendEvent(sessionId, type, {
      type,
      sessionId,
      ts: Date.now(),
      ...payload,
    });
    sessionEvents.emit('event', sessionId, event);
  } catch (err) {
    logAndSwallow(err, '[telemetry-auto-recovery]');
  }
}

/**
 * W3.TEL Section M item 10 — push a structured per-attempt record onto
 * `session.autoRecoveryAttempts[]`. The run-summary writer reads from
 * there at end-of-build. Record shape (verbatim from Section M item 10):
 *   { scope, attemptN, triggeredBy: 'reconciler'|'smoke',
 *     failureSummary, fixedAt?, exhausted: bool }
 *
 * No separate jsonl file per the worker brief (#5) — these are run-summary
 * fields only. Wrapped in logAndSwallow per L.5; an array-push can't fail
 * today but we wrap it anyway for forward-compat (future schema validation).
 */
export function pushAutoRecoveryRecord(session, record) {
  if (!session) return;
  try {
    if (!Array.isArray(session.autoRecoveryAttempts)) {
      session.autoRecoveryAttempts = [];
    }
    session.autoRecoveryAttempts.push({
      scope: record.scope || null,
      attemptN: typeof record.attemptN === 'number' ? record.attemptN : null,
      triggeredBy: record.triggeredBy === 'smoke' ? 'smoke' : 'reconciler',
      failureSummary: record.failureSummary || null,
      fixedAt: typeof record.fixedAt === 'number' ? record.fixedAt : null,
      exhausted: !!record.exhausted,
      ts: Date.now(),
    });
  } catch (err) {
    logAndSwallow(err, '[telemetry-auto-recovery-record]');
  }
}

// Summarize a failure list to a single string so the run-summary record
// stays compact (failures themselves can be large; we keep the count + a
// short kind-list).
function summarizeFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const sources = [...new Set(failures.map((f) => f.source).filter(Boolean))];
  return `${failures.length} failure(s) [${sources.join(', ')}]`;
}

/**
 * Emit one `auto_recovery_type_gate_failed` event per scope whose
 * type-gate flagged errors this round. Best-effort per L.5; never throws.
 * The payload carries a short truncated preview of the formatted block
 * (the full text reaches the agent via the fix-dispatch directive — the
 * transcript event is for observability, not re-injection).
 *
 * tlog companion emits a one-liner per failing scope so live tails see
 * the gate firing without consulting jsonl events.
 */
function emitTypeGateEvents(sessionId, typeGateByScope, scopeCounters) {
  if (!typeGateByScope) return;
  for (const [scope, gate] of typeGateByScope) {
    if (!gate?.hasErrors) continue;
    const counter = scopeCounters?.get?.(scope) || { reengages: 0, fixAttempts: 0 };
    const fixAttempt = counter.fixAttempts + 1;
    tlog('[auto-recovery] type-gate failed scope=%s runtime=%s errors=%d fixAttempt=%d/%d wall=%dms',
      scope, gate.runtime, gate.errorCount, fixAttempt, MAX_FIX_ATTEMPTS_PER_SCOPE, gate.durationMs);
    emitRecoveryEvent(sessionId, 'auto_recovery_type_gate_failed', {
      scope,
      runtime: gate.runtime,
      errorCount: gate.errorCount,
      durationMs: gate.durationMs,
      fixAttempt,
      budget: MAX_FIX_ATTEMPTS_PER_SCOPE,
      formattedTruncated: (gate.formatted || '').slice(0, 500),
    });
  }
}

/**
 * Scan the workspace for failures across all detectors. Returns
 * `{ failuresByScope: Map<scope, Array<{ source, ... }>>, anyFailures,
 *    typeGateByScope: Map<scope, { hasErrors, formatted, errorCount, durationMs, runtime }> }`.
 *
 * Detector order per W3.TYPES.GATE (HARNESS_EVOLUTION.md §O):
 *   1. type-gate (tsc --noEmit / mypy --strict) — fastest signal, runs first
 *   2. structural-checks (Dockerfile / nginx invariants)
 *   3. file-structure-check (required_files + stubs)
 *   4. runtime-asserts (canonical-entry + dockerfile-sanity)
 *
 * When the type-gate reports errors for a scope, downstream detectors
 * are SKIPPED for that scope's iteration: tsc/mypy errors are the
 * highest-signal fix candidates and downstream checks are slower + less
 * precise. The scope's failure list captures only the type-gate
 * formatted output. Once those land and the gate clears, a later round
 * runs the full detector chain.
 */
async function collectFailures(workspaceDir, scopes) {
  const failuresByScope = new Map();
  const typeGateByScope = new Map();
  const add = (scope, failure) => {
    const list = failuresByScope.get(scope) || [];
    list.push(failure);
    failuresByScope.set(scope, list);
  };

  // 1. Type-gate (FIRST detector per W3.TYPES.GATE).
  const typeGateFailedScopes = new Set();
  for (const scope of scopes) {
    try {
      const gate = await runTypeGate({ workspaceDir, scope });
      typeGateByScope.set(scope, gate);
      if (gate.hasErrors) {
        add(scope, {
          source: 'type-gate',
          runtime: gate.runtime,
          errorCount: gate.errorCount,
          formatted: gate.formatted,
          durationMs: gate.durationMs,
        });
        typeGateFailedScopes.add(scope);
      }
    } catch (err) {
      logAndSwallow(err, `[auto-recovery] type-gate threw for scope=${scope}`);
    }
  }

  // Scopes that pass the type-gate (or have no type-checked runtime)
  // still need the downstream detector chain. Scopes that failed the
  // type-gate get short-circuited so the fix-dispatch gets only the
  // type-error context.
  const downstreamScopes = scopes.filter((s) => !typeGateFailedScopes.has(s));

  // 2. Structural checks (Dockerfile / nginx.conf invariants).
  try {
    const structural = runStructuralChecks(workspaceDir, downstreamScopes);
    for (const v of structural.violations) {
      add(v.scope, { source: 'structural-check', rule: v.rule, file: v.file, found: v.found, expected: v.expected });
    }
  } catch (err) {
    logAndSwallow(err, '[auto-recovery] structural-checks threw');
  }

  // 3. File-structure check (required_files + forbidden_paths).
  try {
    const fsCheck = runFileStructureCheck(workspaceDir, downstreamScopes);
    for (const m of fsCheck.missingFiles)     add(m.scope, { source: 'file-structure', kind: 'missing', path: m.path });
    for (const s of fsCheck.stubFiles)        add(s.scope, { source: 'file-structure', kind: 'stub', path: s.path, size: s.size });
    for (const f of fsCheck.forbiddenPresent) add(f.scope, { source: 'file-structure', kind: 'forbidden', path: f.path });
  } catch (err) {
    logAndSwallow(err, '[auto-recovery] file-structure-check threw');
  }

  // 4. Runtime asserts (promoted from smoke).
  try {
    const runtime = runRuntimeAsserts(workspaceDir, downstreamScopes);
    for (const f of runtime.failures) {
      add(f.scope, { source: 'runtime-assert', check: f.check, error: f.error });
    }
  } catch (err) {
    logAndSwallow(err, '[auto-recovery] runtime-asserts threw');
  }

  // 5. MGA wiring (no-op unless the harness provisioned MGA credentials).
  try {
    const mga = runMgaWiringChecks(workspaceDir, downstreamScopes);
    for (const v of mga.violations) {
      add(v.scope, { source: 'mga-wiring', rule: v.rule, file: v.file, found: v.found, expected: v.expected });
    }
  } catch (err) {
    logAndSwallow(err, '[auto-recovery] mga-wiring-check threw');
  }

  return { failuresByScope, anyFailures: failuresByScope.size > 0, typeGateByScope };
}

/**
 * Build a fix directive describing the collected failures for a single scope.
 *
 * When a type-gate failure is present we lead with the formatted tsc/mypy
 * output (per-file source-line context, capped at MAX_TYPE_ERROR_CONTEXT_BYTES).
 * Type errors are the highest-signal fix candidate so the structural /
 * layout / runtime-assert sections (if any are bundled alongside — they
 * normally aren't, since the type-gate short-circuits downstream
 * detectors) follow underneath.
 */
export function buildFixDirective(scope, failures) {
  const typeGate   = failures.find((f) => f.source === 'type-gate');
  const runtimeGate = failures.find((f) => f.source === 'runtime-gate');
  const endpointProbe = failures.find((f) => f.source === 'endpoint-probe');
  const visualCheck = failures.find((f) => f.source === 'visual-check');
  const structural = failures.filter((f) => f.source === 'structural-check');
  const layout     = failures.filter((f) => f.source === 'file-structure');
  const asserts    = failures.filter((f) => f.source === 'runtime-assert');
  const mgaWiring  = failures.filter((f) => f.source === 'mga-wiring');

  // When the only failures are from the type-gate, return its
  // already-formatted block verbatim — it carries its own header +
  // summary lines (see formatTypeErrors in reconciler/type-gate.js).
  if (typeGate && !runtimeGate && !endpointProbe && !structural.length && !layout.length && !asserts.length && !mgaWiring.length) {
    return typeGate.formatted +
      '\n\nReply with attempt_completion after the edits land.';
  }

  // Same fast-path for runtime-gate-only failures: its `formatted` block
  // already carries the kind/stage/logs/header lines.
  if (runtimeGate && !typeGate && !endpointProbe && !structural.length && !layout.length && !asserts.length && !mgaWiring.length) {
    return runtimeGate.formatted +
      '\n\nReply with attempt_completion after the edits land.';
  }

  // Same fast-path for endpoint-probe-only failures (post-compose runtime
  // verification): its `formatted` block carries endpoint/status/log lines.
  if (endpointProbe && !typeGate && !runtimeGate && !structural.length && !layout.length && !asserts.length && !mgaWiring.length) {
    return endpointProbe.formatted +
      '\n\nReply with attempt_completion after the edits land.';
  }

  // Same fast-path for visual-check-only failures (screenshot of the running
  // app): its `formatted` block carries the defect list + primary view/action.
  if (visualCheck && !typeGate && !runtimeGate && !endpointProbe && !structural.length && !layout.length && !asserts.length && !mgaWiring.length) {
    return visualCheck.formatted +
      '\n\nReply with attempt_completion after the edits land.';
  }

  const lines = [
    `=== AUTO-RECOVERY — ${scope.toUpperCase()} FIX DISPATCH ===`,
    '',
    `${failures.length} compile-time / structural / file-layout / runtime-assert failure(s) were detected`,
    `in your scope after attempt_completion. Fix each one, then emit attempt_completion.`,
    '',
    `Reconcile each failure by editing the listed file(s). Do NOT introduce new`,
    `endpoints, columns, or schema items — only fix the drift below.`,
    '',
  ];

  if (typeGate) {
    lines.push('--- COMPILE-TIME TYPE-GATE FAILURES (highest priority — fix first) ---');
    lines.push(typeGate.formatted);
    lines.push('');
  }

  if (runtimeGate) {
    lines.push('--- RUNTIME-GATE FAILURES (docker build / run / probe) ---');
    lines.push(runtimeGate.formatted);
    lines.push('');
  }

  if (endpointProbe) {
    lines.push('--- ENDPOINT PROBE FAILURES (live requests against the running app) ---');
    lines.push(endpointProbe.formatted);
    lines.push('');
  }

  if (mgaWiring.length) {
    lines.push('--- MGA WIRING VIOLATIONS (LLM integration invariants) ---');
    for (const v of mgaWiring) {
      lines.push(`  ${v.file}:`);
      lines.push(`    rule:     ${v.rule}`);
      lines.push(`    found:    ${v.found}`);
      lines.push(`    expected: ${v.expected}`);
    }
    lines.push('');
  }

  if (structural.length) {
    lines.push('--- STRUCTURAL CHECK VIOLATIONS (Dockerfile / nginx.conf invariants) ---');
    for (const v of structural) {
      lines.push(`  ${v.file}:`);
      lines.push(`    rule:     ${v.rule}`);
      lines.push(`    found:    ${v.found}`);
      lines.push(`    expected: ${v.expected}`);
    }
    lines.push('');
  }
  if (layout.length) {
    lines.push('--- FILE-STRUCTURE FAILURES (canonical paths from .harness/contracts.json) ---');
    for (const f of layout) {
      if (f.kind === 'missing')    lines.push(`  MISSING: ${f.path} — create at this canonical path.`);
      if (f.kind === 'stub')       lines.push(`  STUB:    ${f.path} (${f.size} bytes) — populate with real content.`);
      if (f.kind === 'forbidden')  lines.push(`  FORBIDDEN PRESENT: ${f.path} — wrong-language or wrong-scope file; remove.`);
    }
    lines.push('');
  }
  if (asserts.length) {
    lines.push('--- RUNTIME ASSERT FAILURES (canonical-entry + Dockerfile sanity) ---');
    for (const a of asserts) {
      lines.push(`  ${a.check}: ${a.error}`);
    }
    lines.push('');
  }
  lines.push('Reply with attempt_completion after the edits land.');
  return lines.join('\n');
}

/**
 * Estimate tokens consumed by the recovery loop so far. Best-effort —
 * reads from session.coderTokenTotals which the dispatcher updates via
 * accumulateAgentTotals. The auto-recovery budget is purely defensive
 * (rare trip) so a slightly-off estimate is acceptable.
 */
function recoveryTokensUsed(session, baselineTokens) {
  const totals = session.coderTokenTotals;
  if (!totals) return 0;
  const current = (totals.promptTokens || 0) + (totals.completionTokens || 0);
  return Math.max(0, current - baselineTokens);
}

/**
 * Top-level entrypoint. Called from tryAutoStartApp after the reconciler
 * loop returns (and before compose build).
 *
 * @param {object} args
 * @param {object} args.session
 * @param {string[]} args.scopes       - scopes from router emission
 * @param {Map} args.scopeCounters     - shared Map<scope, { reengages, fixAttempts }>
 * @param {object} args.routerContracts
 * @returns {Promise<{ recoveredScopes: string[], exhaustedScopes: string[], tokensUsed: number, surfacedToUser: boolean, finalFailures: object }>}
 */
export async function runAutoRecovery({ session, scopes, scopeCounters, routerContracts }) {
  const phaseStart = Date.now();
  const summary = {
    recoveredScopes: [],
    exhaustedScopes: [],
    tokensUsed: 0,
    surfacedToUser: false,
    finalFailures: {},
  };

  const baselineTokens = ((session.coderTokenTotals?.promptTokens) || 0)
    + ((session.coderTokenTotals?.completionTokens) || 0);

  tlog('[auto-recovery] start: budget=%d/scope tokens-cap=%d',
    MAX_FIX_ATTEMPTS_PER_SCOPE, MAX_RECOVERY_TOKENS_PER_BUILD);

  try {
    const { reengageScopeForMismatch } = await import('../reconciler/reengage.js');

    // Initial pass: capture entry-state failure set. The async signature
    // is W3.TYPES.GATE — type-gate runs first per-scope and may spawn a
    // tsc/mypy child process, so collectFailures is awaitable.
    let { failuresByScope, anyFailures, typeGateByScope } = await collectFailures(WORKSPACE_DIR, scopes);
    // Emit one typed event per scope where the type-gate fired so the
    // transcript captures the compile-time signal independent of which
    // dispatches end up running this round.
    emitTypeGateEvents(session.id, typeGateByScope, scopeCounters);
    if (!anyFailures) {
      tlog('[auto-recovery] no failures detected — recovery skipped');
      tlog('[auto-recovery] done: wall=%dms fixAttempts={} tokensUsed=0',
        Date.now() - phaseStart);
      return summary;
    }

    // Dispatch loop. Each iteration: try one fix-attempt per scope that
    // still has failures and budget remaining. Re-collect failures after
    // the round and continue until clean or all exhausted.
    let round = 0;
    while (true) {
      round++;
      // Token-budget gate first — defensive ceiling.
      const tokensUsed = recoveryTokensUsed(session, baselineTokens);
      if (tokensUsed >= MAX_RECOVERY_TOKENS_PER_BUILD) {
        tlog('[auto-recovery] tokens-budget-exhausted (used=%d/%d) — ending recovery phase',
          tokensUsed, MAX_RECOVERY_TOKENS_PER_BUILD);
        emitRecoveryEvent(session.id, 'auto_recovery_tokens_exhausted', {
          tokensUsed,
          budget: MAX_RECOVERY_TOKENS_PER_BUILD,
        });
        summary.tokensUsed = tokensUsed;
        summary.surfacedToUser = true;
        break;
      }

      // Determine which scopes can still be dispatched this round.
      const scopesToFix = [];
      for (const [scope, _failures] of failuresByScope) {
        const counter = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
        if (counter.fixAttempts >= MAX_FIX_ATTEMPTS_PER_SCOPE) {
          // Already at budget — surface, don't dispatch again.
          if (!summary.exhaustedScopes.includes(scope)) {
            summary.exhaustedScopes.push(scope);
            tlog('[auto-recovery] scope=%s fix-budget-exhausted (%d/%d) — surfacing to user',
              scope, counter.fixAttempts, MAX_FIX_ATTEMPTS_PER_SCOPE);
            emitRecoveryEvent(session.id, 'auto_recovery_scope_exhausted', {
              scope,
              fixAttempts: counter.fixAttempts,
              budget: MAX_FIX_ATTEMPTS_PER_SCOPE,
              failures: failuresByScope.get(scope),
            });
            // W3.TEL — terminal record for an exhausted scope. attemptN is
            // the budget-cap value, exhausted=true. No fixedAt because the
            // scope never recovered.
            pushAutoRecoveryRecord(session, {
              scope,
              attemptN: counter.fixAttempts,
              triggeredBy: 'reconciler',
              failureSummary: summarizeFailures(failuresByScope.get(scope)),
              exhausted: true,
            });
          }
          continue;
        }
        scopesToFix.push(scope);
      }

      if (scopesToFix.length === 0) {
        // All failing scopes have hit the per-scope budget. Surface and exit.
        tlog('[auto-recovery] all scopes with failures exhausted (%j) — recovery phase ending',
          Object.fromEntries(
            Array.from(failuresByScope.keys()).map((s) => [s, scopeCounters.get(s)?.fixAttempts || 0])
          ));
        summary.surfacedToUser = true;
        break;
      }

      // W4.BUDGET.4 — dispatch fixes across scopes in parallel. Each scope's
      // fix is independent (different files, separate conversation context, no
      // cross-scope coordination during the dispatch). Sequential dispatch
      // wasted wall-clock waiting on the slowest scope's MGA round-trip per
      // round; concurrent dispatch saves ~1 min on multi-scope scenarios.
      //
      // Concurrency safety: scopeCounters and coderConversationIds are
      // per-scope keys (no cross-scope write contention); accumulateAgentTotals
      // does synchronous += on session.coderTokenTotals (atomic in single-
      // threaded JS, no torn writes); emitRecoveryEvent + pushAutoRecoveryRecord
      // append to arrays which are safe under concurrent calls. Pre-await
      // snapshots are taken inside each async iteration so no read-modify-write
      // happens across an await boundary.
      const dispatchPromises = scopesToFix.map(async (scope) => {
        const failures = failuresByScope.get(scope);
        const counter = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
        const attemptIdx = counter.fixAttempts + 1;
        tlog('[auto-recovery] dispatching fix scope=%s round=%d attempt=%d/%d failures=%d',
          scope, round, attemptIdx, MAX_FIX_ATTEMPTS_PER_SCOPE, failures.length);
        emitRecoveryEvent(session.id, 'auto_recovery_dispatch', {
          scope,
          round,
          attempt: attemptIdx,
          budget: MAX_FIX_ATTEMPTS_PER_SCOPE,
          failureCount: failures.length,
          sources: [...new Set(failures.map((f) => f.source))],
        });
        // W3.TEL — per-attempt record onto session.autoRecoveryAttempts[].
        // Pushed BEFORE the dispatch runs so the record exists even if the
        // runCustomAgent throws (the catch below logAndSwallow-s the error).
        // `fixedAt` is filled later when the post-round failure check shows
        // this scope as recovered.
        pushAutoRecoveryRecord(session, {
          scope,
          attemptN: attemptIdx,
          triggeredBy: 'reconciler',
          failureSummary: summarizeFailures(failures),
          exhausted: false,
        });
        const directive = buildFixDirective(scope, failures);
        try {
          const { runCustomAgent } = await import('../agent/agent.js');
          const { PHASES } = await import('../agent/loop/phase.js');
          // conversationId: null is intentional. /chat/agent's
          // conversation_id does NOT load prior context into the LLM (see
          // chat/server/agent/agent.js:565). With /chat/completions
          // (default), each runCustomAgent call inits a fresh
          // completionsMessages array — cross-call continuity would
          // require persisting and replaying that array, which is a
          // separate architectural change.
          const result = await runCustomAgent(session.id, directive, {
            conversationId: null,
            scope,
            phase: PHASES.SUBAGENT,
            priorTokenTotals: session.coderTokenTotals || null,
          });
          accumulateAgentTotals(session, result);
          if (result?.conversationId) {
            session.coderConversationIds = session.coderConversationIds || {};
            session.coderConversationIds[scope] = result.conversationId;
          }
        } catch (err) {
          logAndSwallow(err, `[auto-recovery] fix dispatch threw for scope=${scope}`);
        }
        // Increment fixAttempts regardless of dispatch outcome — a crashed
        // dispatch still counts against the budget so we don't infinitely
        // retry a known-broken scope.
        scopeCounters.set(scope, { ...counter, fixAttempts: counter.fixAttempts + 1 });
      });
      await Promise.allSettled(dispatchPromises);

      // Re-collect failures after this round's dispatches landed.
      ({ failuresByScope, anyFailures, typeGateByScope } = await collectFailures(WORKSPACE_DIR, scopes));
      emitTypeGateEvents(session.id, typeGateByScope, scopeCounters);

      // W3.TEL — back-patch fixedAt on the most-recent record for any scope
      // that recovered this round. Walking the array backwards finds the
      // latest matching record without an extra index. The loop runs even
      // when !anyFailures so the all-clear branch below benefits too.
      const recoveredThisRound = scopesToFix.filter((s) => !failuresByScope.has(s));
      if (recoveredThisRound.length > 0 && Array.isArray(session.autoRecoveryAttempts)) {
        const now = Date.now();
        for (const scope of recoveredThisRound) {
          for (let i = session.autoRecoveryAttempts.length - 1; i >= 0; i--) {
            const rec = session.autoRecoveryAttempts[i];
            if (rec.scope === scope && rec.fixedAt == null && !rec.exhausted) {
              rec.fixedAt = now;
              break;
            }
          }
        }
      }

      if (!anyFailures) {
        // Track which scopes were dispatched and now have zero failures.
        for (const scope of scopesToFix) {
          if (!summary.recoveredScopes.includes(scope)) {
            summary.recoveredScopes.push(scope);
          }
        }
        tlog('[auto-recovery] all failures cleared after round=%d', round);
        break;
      }

      // Some scopes recovered, others still failing — mark recovered.
      for (const scope of scopesToFix) {
        if (!failuresByScope.has(scope) && !summary.recoveredScopes.includes(scope)) {
          summary.recoveredScopes.push(scope);
        }
      }

      // Safety: cap rounds at MAX_FIX_ATTEMPTS_PER_SCOPE — even if all
      // scopes start fresh each round, this loop bounds at 2 rounds with
      // today's value of 2. Belt-and-braces in case scope-counter
      // bookkeeping ever drifts.
      if (round >= MAX_FIX_ATTEMPTS_PER_SCOPE) {
        tlog('[auto-recovery] hit round-cap (%d) — ending recovery phase', round);
        summary.surfacedToUser = true;
        // Record any scopes still failing as exhausted.
        for (const scope of failuresByScope.keys()) {
          if (!summary.exhaustedScopes.includes(scope)) {
            summary.exhaustedScopes.push(scope);
          }
        }
        break;
      }
    }

    // Capture final failure snapshot for the caller's user-facing report.
    if (failuresByScope.size > 0) {
      const finalSnapshot = {};
      for (const [scope, failures] of failuresByScope) {
        finalSnapshot[scope] = failures;
      }
      summary.finalFailures = finalSnapshot;

      // Best-effort human-readable diagnostic into the transcript so the
      // user sees what's still broken without consulting jsonl events.
      try {
        const fileLayoutReport = formatFileStructureReport({
          missingFiles: [].concat(...Object.values(finalSnapshot).map((arr) =>
            arr.filter((f) => f.source === 'file-structure' && f.kind === 'missing')
              .map((f) => ({ scope: f.scope || 'unknown', path: f.path })))),
          stubFiles: [].concat(...Object.values(finalSnapshot).map((arr) =>
            arr.filter((f) => f.source === 'file-structure' && f.kind === 'stub')
              .map((f) => ({ scope: f.scope || 'unknown', path: f.path, size: f.size })))),
          forbiddenPresent: [].concat(...Object.values(finalSnapshot).map((arr) =>
            arr.filter((f) => f.source === 'file-structure' && f.kind === 'forbidden')
              .map((f) => ({ scope: f.scope || 'unknown', path: f.path })))),
        });
        const lines = [
          `Auto-recovery surfaced ${Object.keys(finalSnapshot).length} scope(s) with failures the harness could not auto-resolve:`,
          '',
        ];
        for (const [scope, failures] of Object.entries(finalSnapshot)) {
          lines.push(`  ${scope}: ${failures.length} failure(s)`);
        }
        if (fileLayoutReport) {
          lines.push('');
          lines.push(fileLayoutReport);
        }
        // Surface any unresolved type-gate output verbatim — these are
        // the highest-signal diagnostics for a user looking at "what is
        // still broken after auto-recovery gave up". One block per scope
        // that still has type-gate failures in its finalSnapshot list.
        for (const [scope, failures] of Object.entries(finalSnapshot)) {
          const tg = failures.find((f) => f.source === 'type-gate');
          if (tg?.formatted) {
            lines.push('');
            lines.push(`--- ${scope} type-gate output (unresolved) ---`);
            lines.push(tg.formatted);
          }
        }
        const event = appendEvent(session.id, 'cline', {
          say: 'text',
          text: lines.join('\n'),
        });
        sessionEvents.emit('event', session.id, event);
      } catch (err) {
        logAndSwallow(err, '[telemetry-auto-recovery] user-facing diagnostic');
      }
    }
  } catch (err) {
    logAndSwallow(err, '[auto-recovery] loop threw (non-fatal — build proceeds)');
  } finally {
    summary.tokensUsed = recoveryTokensUsed(session, baselineTokens);
    const fixAttemptsSnapshot = {};
    for (const [s, c] of scopeCounters) {
      if (c.fixAttempts) fixAttemptsSnapshot[s] = c.fixAttempts;
    }
    tlog('[auto-recovery] done: wall=%dms fixAttempts=%j tokensUsed=%d recovered=%j exhausted=%j',
      Date.now() - phaseStart, fixAttemptsSnapshot, summary.tokensUsed,
      summary.recoveredScopes, summary.exhaustedScopes);
    emitRecoveryEvent(session.id, 'auto_recovery_done', {
      wallMs: Date.now() - phaseStart,
      fixAttempts: fixAttemptsSnapshot,
      tokensUsed: summary.tokensUsed,
      recoveredScopes: summary.recoveredScopes,
      exhaustedScopes: summary.exhaustedScopes,
      surfacedToUser: summary.surfacedToUser,
    });
  }
  return summary;
}

/**
 * Type-gate-only phase, runs BEFORE the reconciler-loop per HARNESS_EVOLUTION.md
 * §O ("Type-gate fires after subagents emit attempt_completion and BEFORE the
 * reconciler-loop"). Same loop shape as runAutoRecovery but the failure-
 * collector is type-gate ONLY — no structural / file-structure / runtime-assert
 * detectors. Those are post-reconciler `runAutoRecovery`'s job.
 *
 * Why the reorder matters: in the tAI1 ERROR run (post-W3.TYPES.GATE smoke
 * 2026-05-16 19:42), the reconciler-loop ate 7m43s discovering the same drift
 * the type-gate identified in <2s once it finally ran. Putting type-gate first
 * means we either fix-dispatch quickly OR reconciler-loop runs on type-clean
 * code (fewer mismatches → faster reconciler).
 *
 * Budget: type-gate fix-dispatches increment the SAME `scopeCounters[scope]
 * .fixAttempts` that post-reconciler runAutoRecovery uses (cap
 * MAX_FIX_ATTEMPTS_PER_SCOPE = 2 across both phases). Reconciler re-engages
 * count separately against `scopeCounters[scope].reengages`. Tokens count
 * against the shared `MAX_RECOVERY_TOKENS_PER_BUILD` ceiling.
 *
 * @returns {Promise<{ recoveredScopes, exhaustedScopes, tokensUsed, surfacedToUser, finalFailures }>}
 */
export async function runTypeGatePhase({ session, scopes, scopeCounters, routerContracts }) {
  void routerContracts; // accepted for signature symmetry with runAutoRecovery; unused for type-gate-only
  const phaseStart = Date.now();
  const summary = {
    recoveredScopes: [],
    exhaustedScopes: [],
    tokensUsed: 0,
    surfacedToUser: false,
    finalFailures: {},
  };

  const baselineTokens = ((session.coderTokenTotals?.promptTokens) || 0)
    + ((session.coderTokenTotals?.completionTokens) || 0);

  tlog('[type-gate-phase] start: budget=%d/scope tokens-cap=%d',
    MAX_FIX_ATTEMPTS_PER_SCOPE, MAX_RECOVERY_TOKENS_PER_BUILD);

  // Pre-reconciler failure collector — runs:
  //   1. type-gate per scope (tsc --noEmit / mypy --strict)
  //   2. runtime-gate per scope (docker build + run + minimal probe), in
  //      parallel via Promise.all in runRuntimeGateForScopes.
  //
  // Short-circuit: a scope that failed the type-gate SKIPS runtime-gate
  // for this round. Reasons: (a) type errors typically cause runtime
  // failures anyway, so the runtime signal is noise; (b) docker build is
  // ~25s/scope wall-clock, expensive to burn on code that doesn't compile.
  // Once the type error lands, the next round runs runtime-gate fresh.
  //
  // The runtime-gate is disabled with RUNTIME_GATE_DISABLED=true. Useful
  // for local debugging when you want to bypass docker entirely.
  const runtimeGateDisabled = process.env.RUNTIME_GATE_DISABLED === 'true';
  const collectPreReconcilerFailures = async () => {
    const failuresByScope = new Map();
    const typeGateByScope = new Map();
    const typeFailedScopes = new Set();
    const add = (scope, failure) => {
      const list = failuresByScope.get(scope) || [];
      list.push(failure);
      failuresByScope.set(scope, list);
    };

    // 1. Type-gate
    for (const scope of scopes) {
      try {
        const gate = await runTypeGate({ workspaceDir: WORKSPACE_DIR, scope });
        typeGateByScope.set(scope, gate);
        if (gate.hasErrors) {
          add(scope, {
            source: 'type-gate',
            runtime: gate.runtime,
            errorCount: gate.errorCount,
            formatted: gate.formatted,
            durationMs: gate.durationMs,
          });
          typeFailedScopes.add(scope);
        }
      } catch (err) {
        logAndSwallow(err, `[type-gate-phase] type-gate threw for scope=${scope}`);
      }
    }

    // 2. Runtime-gate for scopes that passed the type-gate.
    if (!runtimeGateDisabled) {
      const runtimeEligibleScopes = scopes.filter((s) => !typeFailedScopes.has(s));
      if (runtimeEligibleScopes.length > 0) {
        try {
          const runtimeStart = Date.now();
          const runtimeByScope = await runRuntimeGateForScopes({
            workspaceDir: WORKSPACE_DIR,
            scopes: runtimeEligibleScopes,
            runId: session.id,
            portOffset: 0,
          });
          tlog('[type-gate-phase] runtime-gate done: scopes=%d wall=%dms results=%j',
            runtimeEligibleScopes.length, Date.now() - runtimeStart,
            Object.fromEntries(
              Array.from(runtimeByScope.entries()).map(([s, r]) => [
                s,
                r.skipped ? `skip(${r.skipReason})`
                  : r.inconclusive ? 'inconclusive(no-evidence timeout — deferred to compose-up/probe)'
                    : (r.hasErrors ? `fail(${r.errors.length})` : 'ok'),
              ]),
            ));
          for (const [scope, result] of runtimeByScope) {
            if (result.skipped) continue;
            if (result.hasErrors) {
              add(scope, {
                source: 'runtime-gate',
                runtime: result.runtime,
                errorCount: result.errors.length,
                formatted: result.formatted,
                durationMs: result.durationMs,
              });
            }
          }
        } catch (err) {
          logAndSwallow(err, '[type-gate-phase] runtime-gate threw');
        }
      }
    }

    // 3. MGA wiring (no-op unless the harness provisioned MGA credentials).
    try {
      const mga = runMgaWiringChecks(WORKSPACE_DIR, scopes.filter((s) => !typeFailedScopes.has(s)));
      for (const v of mga.violations) {
        add(v.scope, { source: 'mga-wiring', rule: v.rule, file: v.file, found: v.found, expected: v.expected });
      }
    } catch (err) {
      logAndSwallow(err, '[type-gate-phase] mga-wiring-check threw');
    }

    return { failuresByScope, anyFailures: failuresByScope.size > 0, typeGateByScope };
  };

  try {
    let { failuresByScope, anyFailures, typeGateByScope } = await collectPreReconcilerFailures();
    emitTypeGateEvents(session.id, typeGateByScope, scopeCounters);
    if (!anyFailures) {
      tlog('[type-gate-phase] no failures detected — pre-reconciler gate clean');
      tlog('[type-gate-phase] done: wall=%dms fixAttempts={} tokensUsed=0',
        Date.now() - phaseStart);
      return summary;
    }

    let round = 0;
    while (true) {
      round++;
      const tokensUsed = recoveryTokensUsed(session, baselineTokens);
      if (tokensUsed >= MAX_RECOVERY_TOKENS_PER_BUILD) {
        tlog('[type-gate-phase] tokens-budget-exhausted (used=%d/%d)',
          tokensUsed, MAX_RECOVERY_TOKENS_PER_BUILD);
        emitRecoveryEvent(session.id, 'type_gate_phase_tokens_exhausted', {
          tokensUsed,
          budget: MAX_RECOVERY_TOKENS_PER_BUILD,
        });
        summary.tokensUsed = tokensUsed;
        summary.surfacedToUser = true;
        break;
      }

      const scopesToFix = [];
      for (const [scope, _failures] of failuresByScope) {
        const counter = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
        if (counter.fixAttempts >= MAX_FIX_ATTEMPTS_PER_SCOPE) {
          if (!summary.exhaustedScopes.includes(scope)) {
            summary.exhaustedScopes.push(scope);
            tlog('[type-gate-phase] scope=%s fix-budget-exhausted (%d/%d) — surfacing to user',
              scope, counter.fixAttempts, MAX_FIX_ATTEMPTS_PER_SCOPE);
            emitRecoveryEvent(session.id, 'type_gate_phase_scope_exhausted', {
              scope,
              fixAttempts: counter.fixAttempts,
              budget: MAX_FIX_ATTEMPTS_PER_SCOPE,
              failures: failuresByScope.get(scope),
            });
          }
          continue;
        }
        scopesToFix.push(scope);
      }

      if (scopesToFix.length === 0) {
        tlog('[type-gate-phase] all scopes with failures exhausted — ending');
        summary.surfacedToUser = true;
        break;
      }

      // W4.BUDGET.4 — parallelize across scopes. The pre-W4 sequential
      // dispatch was the dominant wall-clock cost on multi-scope scenarios:
      // tAI1's post-W3.TYPES.GATE deep-dive (flake-notes.md 2026-05-16) showed
      // backend round-1 4:39 + frontend round-1 0:57 in series for 5:36; the
      // frontend dispatch could have overlapped backend for ~4:30 of save.
      // Same concurrency safety as runAutoRecovery's parallelization above —
      // per-scope counters + coderConversationIds keys, atomic += on token
      // totals, no read-modify-write across awaits.
      const dispatchPromises = scopesToFix.map(async (scope) => {
        const failures = failuresByScope.get(scope);
        const counter = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
        const attemptIdx = counter.fixAttempts + 1;
        const sources = [...new Set(failures.map((f) => f.source))];
        tlog('[type-gate-phase] dispatching fix scope=%s round=%d attempt=%d/%d sources=%j errors=%d',
          scope, round, attemptIdx, MAX_FIX_ATTEMPTS_PER_SCOPE, sources, failures[0].errorCount);
        emitRecoveryEvent(session.id, 'type_gate_phase_dispatch', {
          scope,
          round,
          attempt: attemptIdx,
          budget: MAX_FIX_ATTEMPTS_PER_SCOPE,
          errorCount: failures[0].errorCount,
          runtime: failures[0].runtime,
          sources,
        });
        // Empty-scope distinction: when the ORIGINAL agent never completed
        // (no completion report in the stash), there is nothing to "fix" —
        // an 8k-char error directive made the recovery agent rebuild the
        // scope blind, without the contract sections or UI-kit catalog
        // (observed live: 62 type errors across 3 rounds after a stream
        // drop killed the first frontend agent). Re-run the FULL original
        // spawn message instead; the fix directive is right only when real
        // files exist to patch.
        let directive = buildFixDirective(scope, failures);
        try {
          const { getOrchestrationContext } = await import('../agent/orchestration-stash.js');
          const stash = getOrchestrationContext(session.id);
          const neverCompleted = !(stash && stash.completionReports && stash.completionReports[scope]);
          if (neverCompleted && stash) {
            const { buildPhaseAgentUserMessage } = await import('../agent/tools/phase-tools.js');
            directive = buildPhaseAgentUserMessage(session.id, {
              scope,
              task: '',
              context: 'NOTE: a previous attempt at this scope failed before writing anything usable. Author the scope from scratch per the sections above.',
            });
            tlog('[type-gate-phase] scope=%s never completed — full re-spawn with original contract sections instead of fix directive', scope);
          }
        } catch (err) { logAndSwallow(err, '[type-gate-phase] respawn-message build failed; using fix directive'); }
        try {
          const { runCustomAgent } = await import('../agent/agent.js');
          const { PHASES } = await import('../agent/loop/phase.js');
          // See matching comment in runAutoRecovery — conversationId: null
          // is intentional given /chat/agent's broken conversation_id
          // semantics + /chat/completions's per-call fresh init.
          const result = await runCustomAgent(session.id, directive, {
            conversationId: null,
            scope,
            phase: PHASES.SUBAGENT,
            priorTokenTotals: session.coderTokenTotals || null,
          });
          accumulateAgentTotals(session, result);
          if (result?.conversationId) {
            session.coderConversationIds = session.coderConversationIds || {};
            session.coderConversationIds[scope] = result.conversationId;
          }
        } catch (err) {
          logAndSwallow(err, `[type-gate-phase] fix dispatch threw for scope=${scope}`);
        }
        scopeCounters.set(scope, { ...counter, fixAttempts: counter.fixAttempts + 1 });
      });
      await Promise.allSettled(dispatchPromises);

      // Re-collect type-gate failures after this round's dispatches.
      ({ failuresByScope, anyFailures, typeGateByScope } = await collectPreReconcilerFailures());
      emitTypeGateEvents(session.id, typeGateByScope, scopeCounters);
      if (!anyFailures) {
        for (const scope of scopesToFix) {
          if (!summary.recoveredScopes.includes(scope)) {
            summary.recoveredScopes.push(scope);
          }
        }
        tlog('[type-gate-phase] all scopes type-clean after round=%d — reconciler-loop can proceed',
          round);
        break;
      }
    }
  } catch (err) {
    logAndSwallow(err, '[type-gate-phase] phase threw');
  } finally {
    summary.tokensUsed = recoveryTokensUsed(session, baselineTokens);
    tlog('[type-gate-phase] done: wall=%dms fixAttempts=%j tokensUsed=%d',
      Date.now() - phaseStart,
      Object.fromEntries(
        Array.from(scopeCounters.entries()).map(([s, c]) => [s, c.fixAttempts])
      ),
      summary.tokensUsed);
    emitRecoveryEvent(session.id, 'type_gate_phase_done', {
      wallMs: Date.now() - phaseStart,
      fixAttempts: Object.fromEntries(
        Array.from(scopeCounters.entries()).map(([s, c]) => [s, c.fixAttempts])
      ),
      tokensUsed: summary.tokensUsed,
      recoveredScopes: summary.recoveredScopes,
      exhaustedScopes: summary.exhaustedScopes,
      surfacedToUser: summary.surfacedToUser,
    });
  }

  return summary;
}
