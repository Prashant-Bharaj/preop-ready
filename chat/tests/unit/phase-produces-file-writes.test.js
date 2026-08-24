/**
 * PhaseStateMachine.producesFileWrites() — write-pressure gating predicate.
 *
 * The agent loop's write-pressure guards (task-impossibility lock + gather-only
 * finalize nudge) encode "zero writes after N turns = stuck". That is only a
 * valid signal for a phase whose product is file writes. This predicate is the
 * single source of truth both guards gate on, so read-only phases
 * (ORCHESTRATING, INVESTIGATING) are exempt by construction rather than via a
 * per-phase exemption list. Lock these expectations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PhaseStateMachine, PHASES } from '../../server/agent/loop/phase.js';

test('SUBAGENT produces file writes (gets the write-pressure guards)', () => {
  const m = new PhaseStateMachine({ initialPhase: PHASES.SUBAGENT });
  assert.equal(m.producesFileWrites(), true);
});

test('INVESTIGATING does NOT produce file writes (read-only; exempt)', () => {
  const m = new PhaseStateMachine({ initialPhase: PHASES.INVESTIGATING });
  assert.equal(m.producesFileWrites(), false);
});

test('ORCHESTRATING does NOT produce file writes (spawns agents; exempt)', () => {
  const m = new PhaseStateMachine({ initialPhase: PHASES.ORCHESTRATING });
  assert.equal(m.producesFileWrites(), false);
});

test('producesFileWrites is exactly isSubagent (no other phase writes)', () => {
  for (const phase of [PHASES.SUBAGENT, PHASES.INVESTIGATING, PHASES.ORCHESTRATING]) {
    const m = new PhaseStateMachine({ initialPhase: phase });
    assert.equal(m.producesFileWrites(), m.isSubagent(),
      `producesFileWrites must track isSubagent for phase=${phase}`);
  }
});
