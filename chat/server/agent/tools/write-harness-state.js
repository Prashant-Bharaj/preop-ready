/**
 * `write_harness_state` tool — the orchestrator's end-of-build write of the
 * `.harness/` project-memory layer (Section A + D of HARNESS_EVOLUTION.md).
 *
 * Surface (XML params parsed by the agent loop):
 *
 *   <write_harness_state>
 *     <state>{ "stack": {...}, "built": {...}, "known_issues": [...],
 *              "next_likely_actions": [...] }</state>
 *     <decision>{ "summary": "...", "reason": "...",
 *                 "alternatives_considered": ["..."] }</decision>  (optional)
 *     <file_structure>{...}</file_structure>                        (optional)
 *   </write_harness_state>
 *
 * Both `state` and `decision` are JSON strings — the agent loop's tag parser
 * delivers them as the raw text content of each tag. `state` is REQUIRED.
 *
 * Semantics:
 *   - Always rewrites `<workspace>/.harness/state.md` from the structured
 *     state via `renderStateMd` (deterministic — same input → same bytes).
 *   - If `decision` is present, appends a dated entry to
 *     `<workspace>/.harness/decisions.md`.
 *   - If `file_structure` override is present, it's stored back into
 *     contracts.json (overwriting the deterministic compute). Almost always
 *     omitted — the harness computes file_structure on plan finalization.
 *
 * Failure policy: telemetry-class (per L.5). A failed write must never block
 * a build. We wrap each IO step in try/catch and surface a soft warning to
 * the orchestrator in the tool result so the next-iteration framing knows
 * the memory layer isn't reliable for this run.
 */
import { WORKSPACE_DIR } from '../../core/paths.js';
import { logAndSwallow } from '../../util/log-helpers.js';
import {
  writeStateMd,
  appendDecision,
  readContracts,
  writeContracts,
  getHarnessDir,
} from '../../session/harness-state.js';
import { generateContractTypes } from '../contract-types-generator.js';
import { makeToolEventPayload } from './core.js';

function parseJsonParam(raw, paramName) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`write_harness_state: ${paramName} is not valid JSON — ${err.message}`);
  }
}

export async function toolWriteHarnessState(params, { emit } = {}) {
  const state = parseJsonParam(params.state, 'state');
  if (!state || typeof state !== 'object') {
    throw new Error('write_harness_state: state is required (JSON object with stack/built/known_issues/next_likely_actions)');
  }
  const decision = parseJsonParam(params.decision, 'decision');
  const fileStructureOverride = parseJsonParam(params.file_structure, 'file_structure');

  const warnings = [];

  // 1. state.md — deterministic rewrite
  try {
    writeStateMd(WORKSPACE_DIR, state);
  } catch (err) {
    logAndSwallow(err, '[harness-state] writeStateMd failed');
    warnings.push(`state.md write failed: ${err.message}`);
  }

  // 2. decisions.md — append (optional)
  if (decision && typeof decision === 'object') {
    if (!decision.summary) {
      warnings.push('decision provided without `summary` — entry skipped');
    } else {
      try {
        appendDecision(WORKSPACE_DIR, decision);
      } catch (err) {
        logAndSwallow(err, '[harness-state] appendDecision failed');
        warnings.push(`decisions.md append failed: ${err.message}`);
      }
    }
  }

  // 3. file_structure override (rare) — merge into contracts.json under
  //    .data.fileStructure. Orchestrator should normally omit this; the
  //    harness computes file_structure deterministically at plan finalization.
  if (fileStructureOverride && typeof fileStructureOverride === 'object') {
    try {
      const current = readContracts(WORKSPACE_DIR) || { version: 1, data: {} };
      const data = { ...(current.data || {}), fileStructure: fileStructureOverride };
      writeContracts(WORKSPACE_DIR, data);
    } catch (err) {
      logAndSwallow(err, '[harness-state] file_structure override failed');
      warnings.push(`file_structure update failed: ${err.message}`);
    }
  }

  // 4. Contract type generation (W1.TYPES.GEN — HARNESS_EVOLUTION.md §O).
  //    Runs AFTER state.md / decisions.md writes so a failed validation here
  //    doesn't roll back the project-memory snapshot. The generator itself is
  //    defensive — schema-validates first, self-tests TS via tsc, atomic-
  //    writes — but the outer try/catch + logAndSwallow guarantees that even
  //    an unexpected throw stays telemetry-class (per L.5). Result records
  //    are appended to `<workspace>/.harness/contract-types-generator.log`
  //    by the generator itself.
  let typeGen = null;
  try {
    typeGen = generateContractTypes(WORKSPACE_DIR);
  } catch (err) {
    logAndSwallow(err, '[contract-types-generator] generateContractTypes threw');
    warnings.push(`contract types generation failed: ${err.message}`);
  }
  if (typeGen && Array.isArray(typeGen.errors) && typeGen.errors.length > 0) {
    for (const e of typeGen.errors) warnings.push(`contract types: ${e}`);
  }

  if (typeof emit === 'function') {
    emit(makeToolEventPayload('writeHarnessState', {
      path: `${getHarnessDir(WORKSPACE_DIR)}/state.md`,
      hadDecision: Boolean(decision && decision.summary),
      typesWritten: typeGen ? typeGen.written.length : 0,
    }));
  }

  const typeNote = typeGen && typeGen.written.length > 0
    ? `, contract types regenerated (${typeGen.written.length} files)`
    : '';

  if (warnings.length > 0) {
    return `Harness state written with warnings:\n- ${warnings.join('\n- ')}`;
  }
  return `Harness state written: .harness/state.md${decision?.summary ? ', .harness/decisions.md (appended)' : ''}${typeNote}.`;
}

/**
 * W1.PATH — Section E hook. write_harness_state is the harness's own write
 * tool (orchestrator-only); it intentionally writes outside any single
 * scope (always to `.harness/`). Explicitly exempt so the audit trail
 * shows the carve-out instead of a silent allow.
 */
toolWriteHarnessState.checkPermissions = function () {
  return { verdict: 'allow', reason: 'harness-internal' };
};
