/**
 * Orchestrator entry point — reads a validated modulePlan array, fans out
 * to specialists via handoff-engine, and returns a consolidated moduleOutputs
 * object keyed by module name.
 *
 * Called by execution-router.js when hybrid routing is active (P1+).
 * This replaces the P0 stub loadSpecialist() in execution-router.js.
 *
 * Each specialist call is traced to session.hybridTrace[] via trace-store.js.
 * On any specialist failure, the module output is null — completion-policy.js
 * determines whether to use the enriched contract or fall back.
 *
 * @param {object} opts
 * @param {Array}  opts.modulePlan   — validated module plan entries
 * @param {object} opts.contract     — current contract snapshot (read-only)
 * @param {object} opts.session      — session record (hybridTrace mutated)
 * @param {object} opts.envContext   — env context
 * @returns {Promise<{ moduleOutputs: object }>}
 */

import { runHandoffEngine } from './handoff-engine.js';
import { appendTraceStep } from './trace-store.js';
import { evaluateCompletion } from './completion-policy.js';
import { tlog } from '../../util/timestamped-log.js';

export async function runOrchestrator({ modulePlan, contract, session, envContext }) {
  tlog('[orchestrator] starting: %d modules for session=%s', modulePlan.length, session.id);

  const t0 = Date.now();
  const { moduleOutputs, hops } = await runHandoffEngine({
    modulePlan,
    contract,
    session,
    envContext,
  });

  // Append per-module trace entries
  for (const entry of modulePlan) {
    const name = entry.module;
    const output = moduleOutputs[name];
    appendTraceStep(session, {
      module: name,
      input: entry.input || null,
      output: output != null ? JSON.stringify(output).slice(0, 500) : null,
      durationMs: Date.now() - t0,
      status: output != null ? 'completed' : 'failed',
    });
  }

  const completion = evaluateCompletion(modulePlan, moduleOutputs);
  tlog('[orchestrator] done: hops=%d complete=%s failed=%j',
    hops, completion.complete, completion.failed);

  return { moduleOutputs, completion };
}
