/**
 * Coverage: flows 5, 8, 10 via the chain
 *   flow 10 → permission-pipeline gate ordering is load-bearing
 *             for hard-guard cascade
 *   flow  5 → INVESTIGATING phase whitelist enforced by gate (4)
 *   flow  8 → recovery dispatch must obey phase whitelist when
 *             SUBAGENT phase fires
 *
 * This file tests the dispatch-time permission cascade (4 gates,
 * ordered) in isolation. Tests serve flows 5, 8, 10 by ensuring
 * gate ordering, soft/hard deny semantics, and tool-error-count
 * state are all correct.
 *
 * If you change tests in this file: confirm the chain link is still valid.
 * If you remove a test: confirm no chain dependency disappears with it.
 *
 * Module under test: chat/server/agent/loop/permission-pipeline.js (255 LoC).
 * Gates (in cascade order):
 *   1. gatherLockGate            — verification-gather-only block
 *   2. taskImpossibilityLockGate — N turns without write → block
 *                                  (write tool releases the lock)
 *   3. phaseWhitelistGate        — phase-machine isToolAllowed(name)
 *   4. errorRepeatGate           — same call + same params + same error
 *                                  ≥ ERROR_REPEAT_BLOCK_THRESHOLD → soft-deny
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideTool,
  toolSignature,
  ERROR_REPEAT_BLOCK_THRESHOLD,
  GATHER_TOOLS,
} from '../../server/agent/loop/permission-pipeline.js';

// ── Test fixture: phase-machine stub ─────────────────────────────────────

function makePhaseMachine({ phase = 'SUBAGENT', allow = null, blockedMsg = null } = {}) {
  return {
    phase,
    // If `allow` is an array, only those tool names are allowed.
    // If `allow` is null, everything is allowed.
    isToolAllowed: (name) => allow === null ? true : allow.includes(name),
    getBlockedToolMessage: (name) =>
      blockedMsg || `Tool ${name} not allowed in phase ${phase}`,
  };
}

function baseCtx(overrides = {}) {
  return {
    verificationGatherLocked: false,
    taskImpossibilityLocked: false,
    phaseMachine: makePhaseMachine(),
    toolErrorCounts: new Map(),
    iter: 1,
    ...overrides,
  };
}

// ── toolSignature: stability + key bounds ────────────────────────────────

test('toolSignature: identical name + params yields identical signature', () => {
  const a = toolSignature('read_file', { path: 'a.ts' });
  const b = toolSignature('read_file', { path: 'a.ts' });
  assert.equal(a, b);
});

test('toolSignature: param-key order normalized (sorted JSON)', () => {
  const a = toolSignature('write_to_file', { path: 'x', content: 'y' });
  const b = toolSignature('write_to_file', { content: 'y', path: 'x' });
  assert.equal(a, b, 'different key insertion order → same signature');
});

test('toolSignature: differs when params differ', () => {
  const a = toolSignature('read_file', { path: 'a.ts' });
  const b = toolSignature('read_file', { path: 'b.ts' });
  assert.notEqual(a, b);
});

test('toolSignature: name encoded in the prefix', () => {
  const sig = toolSignature('read_file', { x: 1 });
  assert.ok(sig.startsWith('read_file::'));
});

test('toolSignature: huge param payload truncated to 400 chars (key-size bound)', () => {
  const big = 'x'.repeat(10_000);
  const sig = toolSignature('write_to_file', { content: big });
  // The full encoded payload is `{ "content": "xxx..." }` — well over 400 chars.
  // We don't pin the exact length; we pin that the signature is bounded.
  assert.ok(sig.length <= 'write_to_file::'.length + 400);
});

// ── GATHER_TOOLS sanity ──────────────────────────────────────────────────

test('GATHER_TOOLS: contains the expected gather-class tool names', () => {
  for (const name of ['read_file', 'list_files', 'use_mcp_tool', 'task_progress']) {
    assert.ok(GATHER_TOOLS.has(name), `${name} should be in GATHER_TOOLS`);
  }
});

// ── Gate 1: gatherLockGate ───────────────────────────────────────────────

test('Gate 1 gather-lock: gather tool blocked when verificationGatherLocked=true', () => {
  const ctx = baseCtx({ verificationGatherLocked: true });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'gather_lock');
  assert.match(r.message, /blocked in verification/i);
});

test('Gate 1 gather-lock: non-gather tool passes through when locked', () => {
  const ctx = baseCtx({ verificationGatherLocked: true });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  // Lock only fires on gather-class tools.
  assert.equal(r.behavior, 'allow');
});

test('Gate 1 gather-lock: when not locked, gather tool passes through', () => {
  const ctx = baseCtx({ verificationGatherLocked: false });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'allow');
});

// ── Gate 2: taskImpossibilityLockGate ────────────────────────────────────

test('Gate 2 task-impossibility: non-write tool denied when locked', () => {
  const ctx = baseCtx({ taskImpossibilityLocked: true, iter: 9 });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'task_impossibility');
  assert.match(r.message, /investigated for 10 turns/, 'message includes iter+1');
});

test('Gate 2 task-impossibility: attempt_completion passes through (escape hatch)', () => {
  const ctx = baseCtx({ taskImpossibilityLocked: true, iter: 9 });
  const r = decideTool({ name: 'attempt_completion', params: { result: 'done' } }, ctx);
  assert.equal(r.behavior, 'allow');
});

test('Gate 2 task-impossibility: write_to_file RELEASES the lock (stateChanges + log tag)', () => {
  const ctx = baseCtx({ taskImpossibilityLocked: true, iter: 9 });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'allow');
  assert.ok(r.stateChanges, 'returned stateChanges');
  assert.equal(r.stateChanges.taskImpossibilityLocked, false,
    'lock was released');
  assert.ok(Array.isArray(r.releaseLogTags) && r.releaseLogTags.length > 0,
    'release event tagged for telemetry');
  assert.match(r.releaseLogTags[0], /RELEASED/);
});

test('Gate 2 task-impossibility: replace_in_file ALSO releases the lock', () => {
  const ctx = baseCtx({ taskImpossibilityLocked: true, iter: 9 });
  const r = decideTool({ name: 'replace_in_file', params: { path: 'x', diff: 'd' } }, ctx);
  assert.equal(r.behavior, 'allow');
  assert.equal(r.stateChanges.taskImpossibilityLocked, false);
});

test('Gate 2 task-impossibility: not locked → all tools pass through', () => {
  const ctx = baseCtx({ taskImpossibilityLocked: false });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'allow');
  assert.equal(r.stateChanges, undefined, 'no state changes when lock not engaged');
});

// ── Gate 3 (renumbered phaseWhitelistGate per source — gate 4 in inline-narrative) ─

test('Gate 3 phase-whitelist: tool not in phase whitelist → deny-hard', () => {
  const ctx = baseCtx({
    phaseMachine: makePhaseMachine({ phase: 'ORCHESTRATING', allow: ['attempt_completion'] }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'phase_whitelist');
  assert.match(r.logTag, /phase=ORCHESTRATING/);
});

test('Gate 3 phase-whitelist: tool in phase whitelist → allow', () => {
  const ctx = baseCtx({
    phaseMachine: makePhaseMachine({ phase: 'SUBAGENT', allow: ['read_file', 'write_to_file', 'attempt_completion'] }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'allow');
});

test('Gate 3 phase-whitelist: INVESTIGATING phase allows read_file, denies write_to_file', () => {
  // Investigator is read-only — flow 5 hard requirement.
  const invPhase = makePhaseMachine({
    phase: 'INVESTIGATING',
    allow: ['read_file', 'list_files', 'attempt_completion'],
    blockedMsg: 'investigator is read-only; write tools are not allowed',
  });
  const ctx = baseCtx({ phaseMachine: invPhase });

  const allowed = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(allowed.behavior, 'allow');

  const blocked = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(blocked.behavior, 'deny-hard');
  assert.equal(blocked.reason, 'phase_whitelist');
  assert.match(blocked.message, /investigator is read-only/);
});

// ── Gate 4: errorRepeatGate ──────────────────────────────────────────────

test('Gate 4 error-repeat: below threshold → allow', () => {
  const counts = new Map();
  const sig = toolSignature('read_file', { path: 'x' });
  counts.set(sig, { count: ERROR_REPEAT_BLOCK_THRESHOLD - 1, lastSnippet: 'ENOENT' });
  const ctx = baseCtx({ toolErrorCounts: counts });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'allow', `count=${ERROR_REPEAT_BLOCK_THRESHOLD - 1} is below the block threshold`);
});

test('Gate 4 error-repeat: AT threshold → soft-deny', () => {
  const counts = new Map();
  const sig = toolSignature('read_file', { path: 'x' });
  counts.set(sig, { count: ERROR_REPEAT_BLOCK_THRESHOLD, lastSnippet: 'ENOENT: no such file' });
  const ctx = baseCtx({ toolErrorCounts: counts });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'deny-soft', 'AT threshold the gate fires soft-deny');
  assert.equal(r.reason, 'error_repeat');
  assert.match(r.message, /ENOENT/);
  assert.equal(r.extra.count, ERROR_REPEAT_BLOCK_THRESHOLD);
});

test('Gate 4 error-repeat: ABOVE threshold → soft-deny continues', () => {
  const counts = new Map();
  const sig = toolSignature('read_file', { path: 'x' });
  counts.set(sig, { count: ERROR_REPEAT_BLOCK_THRESHOLD + 5, lastSnippet: 'still failing' });
  const ctx = baseCtx({ toolErrorCounts: counts });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'deny-soft');
});

test('Gate 4 error-repeat: state is per-signature — different params have separate counts', () => {
  const counts = new Map();
  // Path A is at threshold; path B is unseen.
  const sigA = toolSignature('read_file', { path: 'a.ts' });
  counts.set(sigA, { count: ERROR_REPEAT_BLOCK_THRESHOLD, lastSnippet: 'EOF' });

  const ctx = baseCtx({ toolErrorCounts: counts });

  // Path A: blocked
  const rA = decideTool({ name: 'read_file', params: { path: 'a.ts' } }, ctx);
  assert.equal(rA.behavior, 'deny-soft');

  // Path B: no entry → allow
  const rB = decideTool({ name: 'read_file', params: { path: 'b.ts' } }, ctx);
  assert.equal(rB.behavior, 'allow', 'separate signature → separate state');
});

test('Gate 4 error-repeat: soft-deny logTag includes the count', () => {
  const counts = new Map();
  const sig = toolSignature('execute_command', { cmd: 'ls' });
  counts.set(sig, { count: ERROR_REPEAT_BLOCK_THRESHOLD, lastSnippet: 'failed' });
  const ctx = baseCtx({ toolErrorCounts: counts });
  const r = decideTool({ name: 'execute_command', params: { cmd: 'ls' } }, ctx);
  assert.match(r.logTag, /count=\d+/);
});

// ── Gate ordering: earlier gate wins ─────────────────────────────────────

test('Gate ordering: gather-lock beats phase-whitelist when both would fire', () => {
  // verificationGatherLocked=true + gather tool not in phase whitelist.
  // Gate 1 should fire first; the deny reason should be 'gather_lock', not
  // 'phase_whitelist'.
  const ctx = baseCtx({
    verificationGatherLocked: true,
    phaseMachine: makePhaseMachine({ phase: 'ORCHESTRATING', allow: [] }),
  });
  const r = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'gather_lock', 'gate 1 wins');
});

test('Gate ordering: task-impossibility beats phase-whitelist when both would fire', () => {
  // taskImpossibilityLocked=true + tool not in phase whitelist.
  // Gate 2 should fire first.
  const ctx = baseCtx({
    taskImpossibilityLocked: true,
    iter: 5,
    phaseMachine: makePhaseMachine({ phase: 'ORCHESTRATING', allow: [] }),
  });
  const r = decideTool({ name: 'list_files', params: { path: 'x' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'task_impossibility', 'gate 2 wins');
});

test('Gate ordering: phase-whitelist beats error-repeat when both would fire', () => {
  // tool not in phase whitelist + error-repeat would also fire.
  const counts = new Map();
  const sig = toolSignature('write_to_file', { path: 'x', content: 'y' });
  counts.set(sig, { count: ERROR_REPEAT_BLOCK_THRESHOLD, lastSnippet: 'denied' });
  const ctx = baseCtx({
    toolErrorCounts: counts,
    phaseMachine: makePhaseMachine({ phase: 'ORCHESTRATING', allow: ['attempt_completion'] }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'deny-hard',
    'phase-whitelist (hard) wins over error-repeat (soft)');
  assert.equal(r.reason, 'phase_whitelist');
});

test('Gate ordering: task-impossibility write-release fires THROUGH to subsequent gates', () => {
  // taskImpossibilityLocked=true; write_to_file releases the lock; but the
  // tool is NOT in the phase whitelist — gate 3 should now fire with
  // deny-hard (not the release-allow result).
  const ctx = baseCtx({
    taskImpossibilityLocked: true,
    iter: 5,
    phaseMachine: makePhaseMachine({ phase: 'ORCHESTRATING', allow: ['attempt_completion'] }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'phase_whitelist',
    'auto-release in gate 2 lets gate 3 still deny via phase whitelist');
});

test('Gate ordering: task-impossibility release + phase allow → final allow with stateChanges', () => {
  // The full happy path of gate-2 release: lock engaged, write tool, phase
  // permits it → final allow includes the state change.
  const ctx = baseCtx({
    taskImpossibilityLocked: true,
    iter: 5,
    phaseMachine: makePhaseMachine({
      phase: 'SUBAGENT',
      allow: ['write_to_file', 'replace_in_file', 'attempt_completion'],
    }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'allow');
  assert.equal(r.stateChanges.taskImpossibilityLocked, false);
});

// ── Phase context: multiple phases ───────────────────────────────────────

test('Phase context: ORCHESTRATING blocks write_to_file (only orchestrator-class tools allowed)', () => {
  const ctx = baseCtx({
    phaseMachine: makePhaseMachine({
      phase: 'ORCHESTRATING',
      allow: ['dispatch_scope', 'attempt_completion'],
    }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'deny-hard');
  assert.equal(r.reason, 'phase_whitelist');
});

test('Phase context: SUBAGENT allows write_to_file (the scope is doing real work)', () => {
  const ctx = baseCtx({
    phaseMachine: makePhaseMachine({
      phase: 'SUBAGENT',
      allow: ['write_to_file', 'replace_in_file', 'read_file', 'attempt_completion'],
    }),
  });
  const r = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(r.behavior, 'allow');
});

test('Phase context: INVESTIGATING blocks write_to_file but allows read_file', () => {
  const ctx = baseCtx({
    phaseMachine: makePhaseMachine({
      phase: 'INVESTIGATING',
      allow: ['read_file', 'list_files', 'attempt_completion'],
    }),
  });
  const allow = decideTool({ name: 'read_file', params: { path: 'x' } }, ctx);
  assert.equal(allow.behavior, 'allow');
  const block = decideTool({ name: 'write_to_file', params: { path: 'x', content: 'y' } }, ctx);
  assert.equal(block.behavior, 'deny-hard');
});

// ── No deny: full passthrough ────────────────────────────────────────────

test('No deny path: clean ctx + allowed tool → allow with no stateChanges', () => {
  const r = decideTool(
    { name: 'attempt_completion', params: { result: 'done' } },
    baseCtx(),
  );
  assert.equal(r.behavior, 'allow');
  assert.equal(r.stateChanges, undefined);
});
