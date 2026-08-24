// Unit test for the killed-mid-flight cleanup helper in tests/smoke/smoke.js.
//
// The helper is responsible for tearing down Docker compose projects + temp
// workspace dirs when smoke.js is killed mid-run (SIGTERM/SIGINT/uncaughtException).
// In production the helper shells out to `docker compose` + uses `fs.rmSync`;
// here we inject mocks for both via the documented `{ runner, fsImpl }` opts
// and assert the helper:
//   1. Calls `docker compose -p <project> down …` for every active project.
//   2. Falls back to `docker ps … | xargs docker rm -f` when compose-down throws.
//   3. Calls `fs.rmSync(ws, { recursive: true, force: true })` for every workspace.
//   4. Empties the active-resource sets/maps after running.
//   5. No-ops on second invocation (cleanupInProgress guard).
//
// SMOKE_SKIP_MAIN=1 prevents smoke.js's bottom-of-file `main()` from running
// when imported as a module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SMOKE_SKIP_MAIN = '1';

const smoke = await import('../smoke/smoke.js');
const {
  runKilledMidFlightCleanup,
  registerWorkspace,
  registerComposeProject,
  registerServerProc,
  activeWorkspaces,
  activeComposeProjects,
  activeServerProcs,
  _resetCleanupGuardForTest,
} = smoke;

function resetState() {
  activeWorkspaces.clear();
  activeComposeProjects.clear();
  activeServerProcs.clear();
  _resetCleanupGuardForTest();
}

// Stub proc with a pid + exitCode + .kill() method, mirroring the surface
// of a child_process.ChildProcess that runKilledMidFlightCleanup touches.
function makeMockProc(pid) {
  const killCalls = [];
  return {
    pid,
    exitCode: null,
    kill(sig) { killCalls.push({ via: 'proc.kill', sig }); },
    killCalls,
  };
}

// process.kill mock used to assert pgrp-targeted signals + simulate failure
// without firing a real syscall against an arbitrary pid.
function makeMockProcessKill({ failPids = new Set() } = {}) {
  const calls = [];
  return {
    fn(pid, sig) {
      calls.push({ pid, sig });
      if (failPids.has(pid)) throw new Error(`mock process.kill EPERM on ${pid}`);
    },
    calls,
  };
}

function makeMockRunner() {
  const calls = [];
  let throwOnNext = null;
  return {
    fn(cmd, opts) {
      calls.push({ cmd, opts });
      if (throwOnNext && throwOnNext(cmd)) {
        throw new Error('mock runner throw');
      }
    },
    setThrowOnNext(predicate) { throwOnNext = predicate; },
    calls,
  };
}

function makeMockFs() {
  const rmCalls = [];
  return {
    rmSync(p, opts) { rmCalls.push({ p, opts }); },
    rmCalls,
  };
}

test('runKilledMidFlightCleanup compose-down + workspace-rm happy path', () => {
  resetState();
  const runner = makeMockRunner();
  const fsImpl = makeMockFs();
  const processKill = makeMockProcessKill();

  registerWorkspace('/tmp/custom-agent-smoke-aaa');
  registerWorkspace('/tmp/custom-agent-smoke-mscope-t1-bbb');
  registerComposeProject('smoke-t1-1234', '/tmp/custom-agent-smoke-mscope-t1-bbb');
  registerComposeProject('smoke-t2-5678', '/tmp/custom-agent-smoke-mscope-t2-ccc');

  runKilledMidFlightCleanup({ reason: 'SIGTERM', runner: runner.fn, fsImpl, processKill: processKill.fn });

  // Compose down ran for each project, with the right cwd.
  const downCalls = runner.calls.filter(c => c.cmd.includes('docker compose -p'));
  assert.equal(downCalls.length, 2, 'expected one compose-down per project');
  const projects = downCalls.map(c => c.cmd.match(/-p (\S+)/)[1]).sort();
  assert.deepEqual(projects, ['smoke-t1-1234', 'smoke-t2-5678']);
  // Compose-down uses --volumes --remove-orphans and has a 5s timeout.
  for (const c of downCalls) {
    assert.match(c.cmd, /--volumes/);
    assert.match(c.cmd, /--remove-orphans/);
    assert.equal(c.opts.timeout, 5_000);
  }

  // Workspaces removed via fs.rmSync, recursive + force.
  assert.equal(fsImpl.rmCalls.length, 2);
  const wsPaths = fsImpl.rmCalls.map(c => c.p).sort();
  assert.deepEqual(wsPaths, [
    '/tmp/custom-agent-smoke-aaa',
    '/tmp/custom-agent-smoke-mscope-t1-bbb',
  ]);
  for (const c of fsImpl.rmCalls) {
    assert.equal(c.opts.recursive, true);
    assert.equal(c.opts.force, true);
  }

  // Trackers emptied after cleanup.
  assert.equal(activeComposeProjects.size, 0);
  assert.equal(activeWorkspaces.size, 0);
});

test('runKilledMidFlightCleanup falls back to docker rm -f when compose down fails', () => {
  resetState();
  const runner = makeMockRunner();
  // Compose-down throws; the helper should then invoke the fallback `docker ps`
  // pipeline matching the project prefix.
  runner.setThrowOnNext((cmd) => cmd.includes('docker compose -p'));
  const fsImpl = makeMockFs();
  const processKill = makeMockProcessKill();

  registerComposeProject('smoke-fallback-xyz', '/tmp/ws-fallback');

  runKilledMidFlightCleanup({ reason: 'SIGINT', runner: runner.fn, fsImpl, processKill: processKill.fn });

  // First call: compose down (threw). Second call: fallback rm -f.
  assert.equal(runner.calls.length, 2);
  assert.match(runner.calls[0].cmd, /docker compose -p smoke-fallback-xyz down/);
  assert.match(runner.calls[1].cmd, /docker ps -a --filter "name=\^smoke-fallback-xyz-" -q \| xargs -r docker rm -f/);

  assert.equal(activeComposeProjects.size, 0);
});

test('runKilledMidFlightCleanup is idempotent (second call no-ops)', () => {
  resetState();
  const runner = makeMockRunner();
  const fsImpl = makeMockFs();
  const processKill = makeMockProcessKill();

  registerWorkspace('/tmp/once-only');
  registerComposeProject('smoke-once-only', '/tmp/once-only');

  runKilledMidFlightCleanup({ reason: 'SIGTERM', runner: runner.fn, fsImpl, processKill: processKill.fn });
  const firstCallCount = runner.calls.length;
  const firstRmCount = fsImpl.rmCalls.length;
  assert.ok(firstCallCount > 0);
  assert.ok(firstRmCount > 0);

  // Re-register to simulate a race where new resources got added between
  // the first signal and the second. The guard should still no-op.
  registerWorkspace('/tmp/once-only-again');
  registerComposeProject('smoke-once-only-again', '/tmp/once-only-again');

  runKilledMidFlightCleanup({ reason: 'SIGTERM', runner: runner.fn, fsImpl, processKill: processKill.fn });
  assert.equal(runner.calls.length, firstCallCount, 'second invocation should not call runner');
  assert.equal(fsImpl.rmCalls.length, firstRmCount, 'second invocation should not call fs.rmSync');
});

test('runKilledMidFlightCleanup swallows individual operation failures', () => {
  resetState();
  // Both compose-down AND fallback throw; fs.rmSync also throws; process.kill
  // also throws (EPERM-style failure). Helper should still complete without
  // re-throwing and still attempt every resource (best-effort semantics).
  const runner = makeMockRunner();
  runner.setThrowOnNext(() => true);
  const fsImpl = {
    rmSync() { throw new Error('mock fs.rmSync fail'); },
    rmCalls: [],
  };
  Object.defineProperty(fsImpl, 'rmCalls', { value: [], writable: true });
  let rmAttempts = 0;
  fsImpl.rmSync = function () { rmAttempts++; throw new Error('mock fs.rmSync fail'); };
  // Make every process.kill call throw; the helper falls back to proc.kill().
  const processKill = makeMockProcessKill({ failPids: new Set([-91, -92]) });
  const proc1 = makeMockProc(91);
  const proc2 = makeMockProc(92);

  registerServerProc(proc1);
  registerServerProc(proc2);
  registerWorkspace('/tmp/ws-fail-1');
  registerWorkspace('/tmp/ws-fail-2');
  registerComposeProject('smoke-fail-1', '/tmp/ws-fail-1');
  registerComposeProject('smoke-fail-2', '/tmp/ws-fail-2');

  // Should not throw.
  runKilledMidFlightCleanup({ reason: 'uncaughtException', runner: runner.fn, fsImpl, processKill: processKill.fn });

  // Compose down ran twice (one per project) + fallback ran twice = 4 runner calls.
  assert.equal(runner.calls.length, 4);
  // Workspace rm attempted for each of the 2 workspaces despite failures.
  assert.equal(rmAttempts, 2);
  // process.kill attempted for each server proc (both threw).
  assert.equal(processKill.calls.length, 2);
  // Fallback to proc.kill ran for each.
  assert.equal(proc1.killCalls.length, 1);
  assert.equal(proc2.killCalls.length, 1);
});

test('runKilledMidFlightCleanup signals server-proc process groups', () => {
  resetState();
  const runner = makeMockRunner();
  const fsImpl = makeMockFs();
  const processKill = makeMockProcessKill();
  const proc = makeMockProc(42);
  registerServerProc(proc);

  runKilledMidFlightCleanup({ reason: 'SIGTERM', runner: runner.fn, fsImpl, processKill: processKill.fn });

  // Negative pid targets the process group (detached:true children).
  assert.equal(processKill.calls.length, 1);
  assert.equal(processKill.calls[0].pid, -42);
  assert.equal(processKill.calls[0].sig, 'SIGTERM');
  // proc.kill() fallback NOT called because process.kill succeeded.
  assert.equal(proc.killCalls.length, 0);
  assert.equal(activeServerProcs.size, 0);
});

test('runKilledMidFlightCleanup skips already-exited server procs', () => {
  resetState();
  const runner = makeMockRunner();
  const fsImpl = makeMockFs();
  const processKill = makeMockProcessKill();
  const exitedProc = { pid: 99, exitCode: 0, kill() { throw new Error('should not be called'); } };
  registerServerProc(exitedProc);

  runKilledMidFlightCleanup({ reason: 'SIGINT', runner: runner.fn, fsImpl, processKill: processKill.fn });

  assert.equal(processKill.calls.length, 0, 'should skip procs whose exitCode is no longer null');
  assert.equal(activeServerProcs.size, 0);
});
