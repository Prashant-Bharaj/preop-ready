/**
 * `read_harness_state` tool — read counterpart to `write_harness_state`.
 *
 * Returns the current `.harness/state.md` (as raw Markdown) plus the parsed
 * contracts.json envelope. Used by:
 *
 *   - the router on iteration spawns (Phase 2: it needs prior state + pinned
 *     contracts to compute `contract_diffs`)
 *   - subagents on spawn when scope-gated contracts pulls move to MCP
 *     (Phase 4 H — Tier-2 fetch path)
 *
 * Shipping the read tool now so it's available when those phases land; the
 * router's iteration path will import this directly rather than re-walking
 * the filesystem.
 *
 * Failure policy: telemetry-class. A missing harness layer is the expected
 * state for the first build of a fresh workspace — return null fields rather
 * than throwing so the caller can branch on "no prior state".
 */
import { WORKSPACE_DIR } from '../../core/paths.js';
import { logAndSwallow } from '../../util/log-helpers.js';
import { readStateMd, readContracts } from '../../session/harness-state.js';
import { makeToolEventPayload } from './core.js';

export async function toolReadHarnessState(_params, { emit } = {}) {
  let stateMd = null;
  let contracts = null;

  try {
    stateMd = readStateMd(WORKSPACE_DIR);
  } catch (err) {
    logAndSwallow(err, '[harness-state] readStateMd failed');
  }

  try {
    contracts = readContracts(WORKSPACE_DIR);
  } catch (err) {
    logAndSwallow(err, '[harness-state] readContracts failed');
  }

  if (typeof emit === 'function') {
    emit(makeToolEventPayload('readHarnessState', {
      hasState: stateMd != null,
      hasContracts: contracts != null,
    }));
  }

  // Tool results are strings; serialize the structured payload to JSON so the
  // model gets both pieces in one read.
  const result = {
    state: stateMd,
    contracts: contracts ? contracts.data : null,
    contractsVersion: contracts ? contracts.version : null,
  };
  return JSON.stringify(result, null, 2);
}
