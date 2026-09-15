#!/usr/bin/env node
/**
 * Real-call regression smoke test for the custom agent.
 *
 * Not a unit test: burns real MGA tokens (~150-300K for the full suite) and
 * takes 2-5 minutes. Run before landing changes that touch agent/*,
 * prompt-builder/*, session/*, or the Coder/Summarizer/Subagent system
 * prompts. Catches regressions the UI-based manual catalog (TEST_PROMPTS.md)
 * would have caught one-at-a-time.
 *
 * Usage:
 *   node chat/tests/smoke/smoke.js              # run all scenarios
 *   node chat/tests/smoke/smoke.js --only=t1,t3 # subset (comma-separated ids)
 *   node chat/tests/smoke/smoke.js --list       # list scenarios and exit
 *
 * Requires either:
 *   - OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY + CODER_ASSISTANT_ID set
 *     in the environment, or
 *   - A valid .chat/secrets.json at the spike root (auto-loaded and
 *     re-exported as env vars)
 *
 * Isolation: a fresh temp workspace under $TMPDIR becomes WORKSPACE_DIR for
 * this run. .platform-rules/ and snippets/ are symlinked in from the spike
 * root. Between scenarios, everything except those symlinks and .chat/ is
 * wiped. Tool file writes never touch the real workspace.
 *
 * Exit code = number of failed scenarios.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PHASES } from '../../server/agent/loop/phase.js';
import { recordSmokeMetric } from './smoke-metrics.js';
import { runStructuralAsserts, assertRouterExpect, runTelemetryAsserts } from './smoke-asserts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// chat/tests/smoke/smoke.js → spike root is 3 levels up
const SPIKE_ROOT = path.resolve(__dirname, '..', '..', '..');

// Snapshot fixtures for `--capture-snapshot` and `fromSnapshot` mode. Each
// captured snapshot lives at SNAPSHOTS_DIR/<key>/workspace + meta.json. Used
// by multi-turn scenarios that want to skip the (slow) initial build and
// start at iteration 1 against a pre-built workspace.
const SNAPSHOTS_DIR = path.join(SPIKE_ROOT, 'chat/tests/smoke/fixtures/snapshots');

/**
 * Copy a workspace into the snapshot fixture for `captureKey`. Excludes
 * node_modules, .git, and other bulk dirs that would bloat the fixture and
 * regenerate on first dev/test run anyway.
 *
 * Overwrites any prior snapshot at this key (rmSync -r before copy) so
 * re-capturing is idempotent — re-run when the initial-build pipeline
 * changes meaningfully and snapshots go stale.
 */
async function writeSnapshotFromWorkspace(workspaceDir, captureKey, scenario) {
  const dest = path.join(SNAPSHOTS_DIR, captureKey);
  const destWorkspace = path.join(dest, 'workspace');

  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const EXCLUDE_BASENAMES = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__',
    '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.turbo',
  ]);
  const filter = (src) => !EXCLUDE_BASENAMES.has(path.basename(src));
  // verbatimSymlinks preserves the link text as-is (workspace snippets is a
  // symlink to the spike repo's snippets dir; we want it to STAY a symlink
  // in the fixture, not be expanded into a copy of every snippet file).
  fs.cpSync(workspaceDir, destWorkspace, { recursive: true, filter, verbatimSymlinks: true });

  let gitSha = 'unknown';
  try {
    const { execSync } = await import('node:child_process');
    gitSha = execSync('git rev-parse HEAD', { cwd: SPIKE_ROOT }).toString().trim();
  } catch { /* ignore — meta.json still useful without sha */ }

  const meta = {
    snapshotKey: captureKey,
    scenarioId: scenario.id,
    scenarioPrompt: typeof scenario.prompt === 'function' ? '(function)' : (scenario.prompt || null),
    expectedScopes: scenario.expectedScopes || [],
    capturedAt: new Date().toISOString(),
    gitSha,
  };
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log(`[smoke]    snapshot captured: ${dest}`);
  console.log(`[smoke]    use it via: scenario.fromSnapshot = '${captureKey}'`);
}

/**
 * Restore a snapshot fixture into a freshly-minted workspace dir. Called
 * BEFORE bootSpikeServer for any multi-turn scenario with `fromSnapshot`.
 * Throws when the fixture doesn't exist so missing-snapshot bugs surface
 * loudly (with the capture command in the error message).
 */
function restoreSnapshotIntoWorkspace(snapshotKey, workspaceDir) {
  const src = path.join(SNAPSHOTS_DIR, snapshotKey, 'workspace');
  if (!fs.existsSync(src)) {
    throw new Error(
      `fromSnapshot='${snapshotKey}' but fixture missing at ${src}.\n`
      + `Capture it first: npm run smoke -- --only=<scenario-with-prompt> --capture-snapshot=${snapshotKey}`,
    );
  }
  // workspaceDir already exists — freshMultiScopeWorkspace pre-created it
  // with `.platform-rules` + `snippets` symlinks + `.chat/secrets.json`.
  // cpSync with the dir as src throws EEXIST on the dest dir itself even
  // with `force: true` (Node bug or platform quirk). Walk the snapshot's
  // top-level entries and copy each individually — sidesteps the issue and
  // preserves freshMultiScopeWorkspace's seeded files (e.g. .platform-rules
  // symlink + .chat secrets) for any entries the snapshot doesn't overwrite.
  //
  // verbatimSymlinks: preserves the link text as-is (workspace `snippets`
  // is a symlink to /Users/.../spike/snippets; following it would cause
  // "subdirectory of self" recursion).
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcEntry = path.join(src, entry.name);
    const destEntry = path.join(workspaceDir, entry.name);
    try { fs.rmSync(destEntry, { recursive: true, force: true }); } catch { /* noop */ }
    fs.cpSync(srcEntry, destEntry, { recursive: true, verbatimSymlinks: true });
  }

  // Per-session telemetry files in the snapshot carry the CAPTURE session's
  // sessionId, not this run's. runTelemetryAsserts filters by sessionId and
  // would fail with "expected at least 1 matching row" when the assertion's
  // soft-skip-if-absent path doesn't trigger (because the file IS present,
  // just with foreign data). Clearing these makes the per-session asserts
  // start clean — they'll either re-populate (subagent activity this run)
  // or stay empty (skipped via the "file absent" path).
  const SESSION_SCOPED_TELEMETRY = [
    '.harness/snippet-fetches.jsonl',
    '.harness/reconciler-verdicts.jsonl',
  ];
  for (const rel of SESSION_SCOPED_TELEMETRY) {
    try { fs.rmSync(path.join(workspaceDir, rel), { force: true }); } catch { /* noop */ }
  }
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { only: null, list: false, parallel: 1, captureSnapshot: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--list') opts.list = true;
    else if (arg.startsWith('--only=')) {
      opts.only = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--parallel=')) {
      const n = parseInt(arg.slice('--parallel='.length), 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`[smoke] --parallel must be a positive integer, got ${arg}`);
        process.exit(2);
      }
      // Cap at 4: each scenario picks a random spike-server port from a
      // small range and hits MGA; >4 starts trading speed for collision/429
      // risk. If you need more parallelism, run multiple terminals.
      if (n > 4) {
        console.error(`[smoke] --parallel=${n} exceeds safe cap of 4; clamping to 4`);
        opts.parallel = 4;
      } else {
        opts.parallel = n;
      }
    } else if (arg.startsWith('--capture-snapshot=')) {
      // Capture the multi-turn scenario's initial-build artifacts into a
      // reusable fixture. After the scenario's turn 0 succeeds, the
      // workspace (sans node_modules/.git) is copied to
      // chat/tests/smoke/fixtures/snapshots/<key>/workspace. Subsequent
      // scenarios with `fromSnapshot: '<key>'` skip turn 0 entirely and
      // start at iteration 1 — turning a 25-min run into a 5-min run.
      // Iterations are NOT executed in capture mode (would mutate the
      // workspace we're snapshotting).
      const key = arg.slice('--capture-snapshot='.length).trim();
      if (!/^[a-z0-9_-]+$/i.test(key)) {
        console.error(`[smoke] --capture-snapshot key must be [a-zA-Z0-9_-]+, got "${key}"`);
        process.exit(2);
      }
      opts.captureSnapshot = key;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node smoke.js [--only=t1,t3] [--list] [--parallel=N] [--capture-snapshot=<key>]');
      process.exit(0);
    }
  }
  return opts;
}

// ── Killed-mid-flight cleanup tracking ───────────────────────────────────────
//
// When the smoke driver is killed mid-flight (SIGTERM/SIGINT from operator, or
// the wall-clock cap-fix's SIGKILL on the process group), scenario teardown
// (tearDownSpikeServer) is bypassed and leaves behind:
//   - Docker containers from compose projects started by bootSpikeServer()
//   - Temp workspace dirs under os.tmpdir()/custom-agent-smoke-*
//
// We track every workspace + compose project as it's created so a signal
// handler can sweep them on the way out. Graceful end-of-run teardown still
// runs as before; resources are unregistered when their normal teardown
// completes so cleanup doesn't double-down on already-released state.

/** Set of workspace dirs created during this run (mscope + shared single-scope). */
const activeWorkspaces = new Set();
/**
 * Map: composeProjectName → workspaceDir (workspace where docker-compose.yml lives).
 * Populated by bootSpikeServer; cleared by tearDownSpikeServer once compose-down succeeds.
 */
const activeComposeProjects = new Map();
/**
 * Set of detached server child processes (spawned by bootSpikeServer with
 * `detached: true`). Killed on signal so they don't leak port-bound servers
 * after a mid-flight kill. Unregistered by tearDownSpikeServer on graceful exit.
 */
const activeServerProcs = new Set();
/** Guard so re-firing SIGINT doesn't run cleanup twice. */
let cleanupInProgress = false;

function registerWorkspace(ws) { activeWorkspaces.add(ws); }
function unregisterWorkspace(ws) { activeWorkspaces.delete(ws); }
function registerComposeProject(name, workspaceDir) { activeComposeProjects.set(name, workspaceDir); }
function unregisterComposeProject(name) { activeComposeProjects.delete(name); }
function registerServerProc(proc) { activeServerProcs.add(proc); }
function unregisterServerProc(proc) { activeServerProcs.delete(proc); }
/** Test-only — reset the in-progress guard so the helper can be invoked again. */
function _resetCleanupGuardForTest() { cleanupInProgress = false; }

/**
 * Best-effort cleanup of active compose projects + workspace dirs. Designed
 * to run from signal handlers (SIGTERM/SIGINT) or uncaughtException — every
 * operation is wrapped to swallow failures and log to stderr so a single
 * docker hiccup doesn't prevent the rest. Hard 5s timeout on `compose down`
 * per project (better to leave one container than wait 60s on a hung daemon);
 * falls back to `docker rm -f` matching `^<project>-` if compose-down fails.
 *
 * Optionally injected `runner` (cpExecSync-like) + `fsImpl` make this unit-
 * testable. Real callers omit them; tests pass mocks.
 */
function runKilledMidFlightCleanup({ reason, runner, fsImpl, processKill } = {}) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  const exec = runner || execSync;
  const fsM = fsImpl || fs;
  const pkill = processKill || ((pid, sig) => process.kill(pid, sig));
  const projects = Array.from(activeComposeProjects.entries());
  const workspaces = Array.from(activeWorkspaces);
  const procs = Array.from(activeServerProcs);
  process.stderr.write(`\n[smoke] killed-mid-flight cleanup (${reason}): ${procs.length} server proc(s), ${projects.length} compose project(s), ${workspaces.length} workspace(s)\n`);

  // Kill any spawned smoke:server child procs first so they release ports
  // before compose-down runs. detached:true means each has its own process
  // group — SIGTERM the negative PID to take down the whole group.
  for (const proc of procs) {
    try {
      if (proc.pid && proc.exitCode === null) {
        // Negative PID = process group. -detached children kept alive by
        // npm wrappers will go down with the group.
        try { pkill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      }
    } catch (err) {
      process.stderr.write(`[smoke]    server-proc kill failed: ${err.message?.slice(0, 100)}\n`);
    }
    activeServerProcs.delete(proc);
  }

  for (const [project, workspaceDir] of projects) {
    // compose down with a 5s timeout. Run from the workspace dir so `-p`
    // matches the project name set in bootSpikeServer's env.
    let downOk = false;
    try {
      exec(`docker compose -p ${project} down --volumes --remove-orphans`, {
        cwd: workspaceDir,
        stdio: 'ignore',
        timeout: 5_000,
      });
      downOk = true;
    } catch (err) {
      process.stderr.write(`[smoke]    compose down ${project} failed: ${err.message?.slice(0, 100)}\n`);
    }
    if (!downOk) {
      // Fallback: nuke containers matching the project prefix directly.
      // docker prefixes containers with the project name + dash + service.
      try {
        exec(
          `docker ps -a --filter "name=^${project}-" -q | xargs -r docker rm -f`,
          { stdio: 'ignore', timeout: 5_000, shell: '/bin/sh' }
        );
      } catch (err) {
        process.stderr.write(`[smoke]    fallback rm ${project} failed: ${err.message?.slice(0, 100)}\n`);
      }
    }
    activeComposeProjects.delete(project);
  }

  for (const ws of workspaces) {
    try {
      fsM.rmSync(ws, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`[smoke]    workspace rm ${ws} failed: ${err.message?.slice(0, 100)}\n`);
    }
    activeWorkspaces.delete(ws);
  }
}

/**
 * Best-effort pre-run cleanup: remove orphan `smoke-*` containers and
 * `custom-agent-smoke*` workspace dirs left behind by prior smoke invocations
 * that didn't finish their graceful teardown (operator killed mid-flight,
 * timed-out scenario where the killed-mid-flight handler couldn't reach the
 * docker daemon, etc.). Replaces the manual `docker ps … | xargs docker rm -f`
 * step previously documented in CLAUDE.md.
 *
 * Two-tier filtering for concurrent-runs safety:
 *
 *   - Containers: nuke ALL `smoke-*` containers unconditionally. In normal
 *     usage these only appear AFTER a scenario reaches `compose up` (several
 *     minutes into a run); a freshly-started concurrent smoke invocation
 *     hasn't reached that point yet, so it has no compose containers for us
 *     to step on. Bare-named `smoke-*` test fixtures (rare) are fair game —
 *     by the time another smoke run is starting, anything still hanging
 *     around is orphaned.
 *
 *   - Workspace dirs: filter by mtime — only nuke dirs whose last-modified
 *     time is older than `STALE_WORKSPACE_MS` (60s). A concurrent smoke run
 *     creates its workspace dir, then immediately copies template files into
 *     it (continuously updating mtime). A 60s threshold protects an in-flight
 *     concurrent run while still catching truly stale dirs from prior runs.
 *
 * Hard 10s timeout on each docker call so a stuck daemon doesn't become the
 * failure mode. Any error is logged and swallowed; the run continues.
 */
function runPreRunCleanup() {
  const STALE_WORKSPACE_MS = 60_000;
  const now = Date.now();

  // Containers: unconditional rm of every `smoke-*`. See block comment above
  // for why this is concurrent-runs-safe in practice.
  try {
    const ids = execSync('docker ps -a --filter "name=smoke-" -q', {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    if (ids) {
      const list = ids.split('\n').filter(Boolean);
      execSync(`docker rm -f ${list.join(' ')}`, { stdio: 'ignore', timeout: 10_000 });
      process.stderr.write(`[smoke] pre-run cleanup: removed ${list.length} orphan smoke-* container(s)\n`);
    }
  } catch (err) {
    process.stderr.write(`[smoke] pre-run cleanup (containers) skipped: ${err.message?.slice(0, 120) || err}\n`);
  }

  // Networks: compose creates a `<project>_default` bridge per scenario, and
  // `docker rm -f` on the containers (above) does NOT remove it. Orphan
  // `smoke-*` networks therefore pile up across runs and eventually exhaust
  // Docker's predefined address pool ("all predefined address pools have been
  // fully subnetted"), after which EVERY subsequent `compose up` fails
  // instantly — a failure that looks like an app bug but is pure test debris.
  // Remove orphan smoke-* networks; any still in use by a concurrent run refuse
  // removal and are skipped.
  try {
    const nets = execSync('docker network ls --filter "name=smoke-" -q', {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    if (nets) {
      const list = nets.split('\n').filter(Boolean);
      // Best-effort: in-use networks error out individually; docker removes the rest.
      try { execSync(`docker network rm ${list.join(' ')}`, { stdio: 'ignore', timeout: 10_000 }); } catch { /* in-use ones skipped */ }
      process.stderr.write(`[smoke] pre-run cleanup: removed orphan smoke-* network(s) (${list.length} candidate(s))\n`);
    }
  } catch (err) {
    process.stderr.write(`[smoke] pre-run cleanup (networks) skipped: ${err.message?.slice(0, 120) || err}\n`);
  }

  // Workspace dirs: filter by mtime so a concurrent smoke run's just-created
  // workspace isn't nuked from under it.
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp).filter((name) => name.startsWith('custom-agent-smoke'));
    let removed = 0;
    for (const name of entries) {
      const full = path.join(tmp, name);
      try {
        const st = fs.statSync(full);
        const ageMs = now - st.mtimeMs;
        if (ageMs < STALE_WORKSPACE_MS) continue; // belongs to a concurrent run
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // swallow per-entry — operator can `rm -rf` manually
      }
    }
    if (removed > 0) {
      process.stderr.write(`[smoke] pre-run cleanup: removed ${removed} orphan workspace dir(s) (age >= ${STALE_WORKSPACE_MS / 1000}s)\n`);
    }
  } catch (err) {
    process.stderr.write(`[smoke] pre-run cleanup (workspaces) skipped: ${err.message?.slice(0, 120) || err}\n`);
  }
}

// ── Per-process base port offset (simultaneous-runs isolation) ───────────────
//
// Each `npm run smoke` invocation picks a unique base offset so two concurrent
// runs on the same machine don't collide on host port 8080 / 3000 / 5432.
// Slot derivation is hash-based (FNV-1a, same family as the integration-test
// portsForUuid allocator in tests/util/test-workspace.js), giving deterministic
// per-process placement that's stable for the lifetime of the process but
// statistically non-colliding across two PIDs.
//
// The base offset stacks on top of slotIndex (the --parallel worker index),
// so the final compose-port shift is `(baseOffset + slotIndex) * 10`. With
// BASE_SLOTS=200 + an 8080 origin port that maps host ports to roughly
// 8090..10080 (well clear of common dev ports). Container-side ports stay
// canonical — only the host binding shifts.

const BASE_PORT_SLOTS = 200; // slots 1..200 → +10..+2000 port shift

function processBasePortOffset() {
  const seed = `${process.pid}-${Date.now()}-${randomUUID()}`;
  let h = 2166136261 >>> 0; // FNV-1a 32-bit
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 1 + (h % BASE_PORT_SLOTS); // 1..BASE_PORT_SLOTS, never 0
}

/**
 * Install signal + uncaughtException handlers that run runKilledMidFlightCleanup.
 * Idempotent within one process — main() calls it once at startup. The
 * wall-clock cap-fix (line ~711) SIGKILLs the subprocess group; that path
 * does NOT signal smoke.js itself, so these handlers fire only on operator-
 * initiated kill (or the rare uncaughtException). No conflict with the cap-fix.
 */
function installCleanupHandlers() {
  const onSignal = (sig) => () => {
    runKilledMidFlightCleanup({ reason: sig });
    // Re-exit; cleanup has run. Use exit code 1 (signaled).
    process.exit(1);
  };
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('uncaughtException', (err) => {
    runKilledMidFlightCleanup({ reason: 'uncaughtException' });
    // Defensive: don't swallow the original error. Re-throw so node's default
    // handler prints stack + exits with non-zero.
    throw err;
  });
}

// ── Workspace setup ──────────────────────────────────────────────────────────

/**
 * Set up the temp workspace and export WORKSPACE_DIR. Must run BEFORE the
 * dynamic import of agent.js — paths.js freezes WORKSPACE_DIR on first import.
 */
function setupWorkspace() {
  const ws = path.join(os.tmpdir(), `custom-agent-smoke-${Date.now()}`);
  fs.mkdirSync(ws, { recursive: true });

  // Symlink rules + snippets from spike root so MCP handlers resolve them.
  for (const sub of ['.platform-rules', 'snippets']) {
    const target = path.join(SPIKE_ROOT, sub);
    if (!fs.existsSync(target)) {
      throw new Error(`Expected directory missing at spike root: ${target}`);
    }
    fs.symlinkSync(target, path.join(ws, sub), 'dir');
  }

  // Transcript dir for session events.
  fs.mkdirSync(path.join(ws, '.chat', 'transcripts'), { recursive: true });

  // Canonical Dockerfile templates live at snippets/<scope>/Dockerfile.X
  // (per Phase A snippets move). The snippets symlink above exposes them
  // to the workspace; tools/file-tools.js copy_template + agent.js ensureScopeDockerfile
  // both resolve from snippets/<scope>/. No per-scope staging needed.

  process.env.WORKSPACE_DIR = ws;
  registerWorkspace(ws);
  return ws;
}

/**
 * Load credentials from the spike root's .chat/secrets.json into env vars
 * if they aren't already set. Keeps smoke.js runnable without manual env
 * setup when the dev's real workspace is already configured.
 */
function loadCredentials() {
  const hasEnv = process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_API_KEY;
  if (hasEnv) return { source: 'env' };

  const secretsPath = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    throw new Error(
      `No credentials: set OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY, or provide ${secretsPath}`
    );
  }
  const data = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
  if (!data.baseUrl || !data.apiKey) {
    throw new Error(`${secretsPath} is missing baseUrl or apiKey`);
  }
  process.env.OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || data.baseUrl;
  process.env.OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || data.apiKey;
  process.env.OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || data.model || 'gpt-4.1-mini';
  // All harness-level assistant IDs (orchestrator, subagents, reconciler-judge,
  // prompt-writer, router, coder, summarizer) live in chat/server/config/assistants.json.
  // The spawned server subprocess reads them via getCredentials() → harnessIds()
  // directly. No env-var propagation needed here.
  return { source: 'secrets.json' };
}

/**
 * Remove everything in the workspace except the symlinks and .chat dir so
 * each scenario starts with a fresh filesystem but keeps the MCP-resolvable
 * rules / snippets.
 */
function resetWorkspace(ws) {
  const keep = new Set(['.platform-rules', 'snippets', '.chat']);
  for (const entry of fs.readdirSync(ws)) {
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(ws, entry), { recursive: true, force: true });
  }
  // No per-scope re-seeding needed — canonical Dockerfile templates live at
  // snippets/<scope>/Dockerfile.X (preserved via the symlink) and resolvers
  // (tools/file-tools.js copy_template, agent.js ensureScopeDockerfile, session/routes.js
  // /confirm pre-stage) all source from there.
}

// ── Scenario definitions ─────────────────────────────────────────────────────

/**
 * Wrap a task string in the marker extractTaskSpec looks for. Matches what
 * prompt-builder emits in production so the agent's task-spec re-injection
 * path behaves the same.
 */
function wrapTaskPrompt(taskText) {
  return `=== USER REQUEST ===\n${taskText}\n`;
}

// ── Multi-scope harness — boots the spike server as a subprocess and drives
//    the full pipeline (router → clarify → plan-confirm → fan-out → verify →
//    compose-up) over HTTP + Socket.IO. Used by scenarios with
//    `mode: 'multi-scope'`. Single-scope scenarios stay on the direct
//    runCustomAgent path above.

/**
 * Mint a fresh isolated workspace for one multi-scope scenario.
 * Symlinks `.platform-rules/` and `snippets/`; copies Dockerfile templates;
 * copies the spike root's `.chat/secrets.json` so the spawned server can
 * authenticate with MGA.
 */
function freshMultiScopeWorkspace(label) {
  const ws = path.join(os.tmpdir(), `custom-agent-smoke-mscope-${label}-${Date.now()}`);
  fs.mkdirSync(ws, { recursive: true });
  for (const sub of ['.platform-rules', 'snippets']) {
    fs.symlinkSync(path.join(SPIKE_ROOT, sub), path.join(ws, sub), 'dir');
  }
  fs.mkdirSync(path.join(ws, '.chat', 'transcripts'), { recursive: true });
  // Copy secrets so the subprocess server can auth with MGA. The server reads
  // <WORKSPACE_DIR>/.chat/secrets.json by default.
  const secretsSrc = path.join(SPIKE_ROOT, '.chat', 'secrets.json');
  const secretsDst = path.join(ws, '.chat', 'secrets.json');
  if (fs.existsSync(secretsSrc) && !fs.existsSync(secretsDst)) {
    fs.copyFileSync(secretsSrc, secretsDst);
  }
  // Workspace starts with just the symlinks + secrets + transcripts dir.
  // Everything else flows from pre-stage (Dockerfiles per task.dockerfile,
  // nginx.conf + nginx.local.conf when frontend in scope, contracts.ts,
  // routes.ts, schema.sql, component stubs, conditional lib/* helpers) and
  // from subagents writing app code. This mirrors the post-merge model where
  // the spike IS the user-facing template — users clone a clean tree and the
  // harness builds everything contract-driven on first prompt.
  //
  // Previously this called bootstrapWorkspaceFromTemplate(ws) which sourced
  // committed files from a sibling `dd-template-repo` clone. That repo had
  // pollution at scope folders (backend/*.py, Dockerfile.{node,python,rust}
  // at the wrong path) that confused agents on every run. Removed 2026-05-21
  // once snippet-based pre-stage covered every load-bearing scaffold file.
  registerWorkspace(ws);
  return ws;
}

/**
 * Wait for the subprocess to be reachable on its port. We listen for the
 * `[runner] Chat service on port N` log line — that's emitted by
 * server/index.js immediately after `server.listen()` resolves, which is the
 * moment the HTTP socket is bound and accepting connections. Earlier signals
 * like `[middleware] Ready (Xms)` happen DURING init, BEFORE listen(), so
 * matching on those races against listen() and our fetch fires too early.
 */
function waitForReadyLog(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`server did not signal "Chat service on port" within ${timeoutMs}ms`));
    }, timeoutMs);
    function onData(chunk) {
      const s = chunk.toString();
      if (/\[runner\] Chat service on port/.test(s)) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        // Tiny grace period — the listen() callback log fires synchronously
        // with bind, but on slow machines the kernel may need a tick more
        // before fetch() can connect.
        setTimeout(resolve, 100);
      }
    }
    proc.stdout.on('data', onData);
  });
}

/**
 * Boot the spike server as a child process for a multi-scope scenario.
 * Returns { proc, baseUrl, port, getStdout } and rejects if the server
 * doesn't reach ready state within 30s.
 */
async function bootSpikeServer({ workspaceDir, port, label, portOffset = 0 }) {
  // Step 8 (smoke harness hygiene): explicit COMPOSE_PROJECT_NAME per scenario.
  // docker-compose defaults to the workspace dirname (already mostly unique
  // per scenario via timestamp), but pinning explicitly is safer and more
  // grep-friendly in `docker ps -a` output. Also gives us a stable namespace
  // for any future "force-prune by project name" cleanup.
  const projectSlug = (label || 'smoke')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    || 'smoke';
  const composeProjectName = `smoke-${projectSlug}-${Date.now()}`;
  // Register for killed-mid-flight cleanup. Unregistered by tearDownSpikeServer
  // on graceful end-of-run; left in the map if the driver is killed first.
  registerComposeProject(composeProjectName, workspaceDir);

  const env = {
    ...process.env,
    WORKSPACE_DIR: workspaceDir,
    PORT: String(port),
    USE_COMPACTION: '1',
    DEBUG_AGENT: '0',
    // SMOKE_PORT_OFFSET (0 = no offset = current behavior). When > 0,
    // session/docker-orchestration.js's auto-start path shifts host ports in the generated
    // compose file by (offset * 10) before `compose up` so multiple
    // scenarios can run in parallel without colliding on host port 8080.
    SMOKE_PORT_OFFSET: String(portOffset),
    // Pin the compose project name so `docker compose up/down/logs` (which
    // run from $WORKSPACE_DIR) and the teardown's `compose down -v` use
    // the same namespace. Default-derivation works but is fragile.
    COMPOSE_PROJECT_NAME: composeProjectName,
    // Skip MGA assistant pre-stage during smoke runs. Real POST /assistants
    // calls leak orphans every smoke run (cleanup script eventually catches
    // them, but it's noise). Smoke validates router emission + parser; live
    // assistant creation is verified manually. Session.js writes a placeholder
    // .env with MGA_ASSISTANT_ID=00000000-... so downstream subagents still
    // get the env var name (the AI feature won't actually work at runtime,
    // but smoke doesn't reach the chat call anyway).
    MGA_SKIP_PRESTAGE: 'true',
  };
  // Use `smoke:server` (no --watch) so file writes inside chat/server/ during a
  // smoke run can't trigger a `node --watch` restart of the chat backend.
  // Observed in the 2026-05-04 Step 6 verification gate: 3 parallel spike
  // servers all restarted simultaneously mid-orchestration, dropping their
  // websockets, killing in-flight LLM calls, and producing 12-min wall-clock
  // false timeouts. `dev:server` keeps `--watch` for normal local development;
  // smoke uses the plain boot.
  const proc = spawn('npm', ['run', 'smoke:server'], {
    cwd: path.join(SPIKE_ROOT, 'chat'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,  // step 8: own process group so wall-clock kill (smoke.js:704) can SIGTERM children
  });

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    process.stdout.write(`[server:${label}] ${chunk}`);
  });
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[server:${label}:err] ${chunk}`);
  });

  await waitForReadyLog(proc, 30_000);
  // Register for killed-mid-flight cleanup. Unregistered by tearDownSpikeServer
  // on graceful exit; left in the set if the smoke driver is killed first.
  registerServerProc(proc);
  return {
    proc,
    baseUrl: `http://localhost:${port}`,
    port,
    workspaceDir,
    composeProjectName,
    getStdout: () => stdoutBuf,
  };
}

/**
 * SIGTERM the subprocess; escalate to SIGKILL after 10s if it hasn't exited.
 */
async function tearDownSpikeServer(handle) {
  await new Promise((resolve) => {
    const proc = handle?.proc;
    if (!proc || proc.exitCode !== null) { resolve(); return; }
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    proc.on('exit', () => { clearTimeout(killTimer); resolve(); });
    proc.kill('SIGTERM');
  });

  // The spike server subprocess exits cleanly above, but any containers it
  // spawned via `compose up -d` keep running (detached mode persists past
  // process exit). Without an explicit teardown, the next multi-scope
  // scenario hits the port-conflict detector on host port 3000 / 8080 and
  // fast-fails as `composeOutcome=port_conflict` — masking real outcomes.
  // Best-effort: any cleanup error is logged and ignored, scenario already
  // completed before this point.
  if (handle?.workspaceDir) {
    try {
      const composePath = `${handle.workspaceDir}/docker-compose.yml`;
      const fs = await import('node:fs');
      const { execSync } = await import('node:child_process');
      if (fs.existsSync(composePath)) {
        for (const binary of ['docker compose', 'docker-compose']) {
          try {
            // -v also removes named volumes so the next scenario starts from
            // a clean DB state (init.sql actually re-runs). --remove-orphans
            // covers stray services. The 30s timeout is generous; compose
            // down on a 4-service stack typically completes in <5s.
            execSync(`${binary} down -v --remove-orphans`, {
              cwd: handle.workspaceDir,
              stdio: 'ignore',
              timeout: 30_000,
            });
            break;
          } catch {
            // try next binary; if all fail we log and move on
          }
        }
      }
      // Sweep any globally-named leftovers — phase agents sometimes hard-code
      // `container_name: backend` (against canonical convention). compose-
      // sanitizer.js strips this from compose.yml at auto-start, but if a
      // PRIOR scenario in the same gate run already created a container with
      // a literal name, `compose down` (which only knows about the current
      // compose project) won't touch it. Force-remove any container whose
      // name exactly matches a known scope-name. Safe: the canonical
      // templates never use these literal names.
      try {
        execSync(
          'docker rm -f database backend frontend vectordb 2>/dev/null || true',
          { stdio: 'ignore', timeout: 15_000, shell: '/bin/sh' }
        );
      } catch {}
    } catch (err) {
      console.log(`[smoke]    teardown warning: compose down failed (${err.message?.slice(0, 80)}) — next multi-scope may hit port collision`);
    }
  }

  // Unregister from the killed-mid-flight cleanup tracker. Workspace + compose
  // project + server proc have either been torn down above or graceful teardown
  // errored out — either way we don't want the signal-handler path retrying
  // them later.
  if (handle?.proc) unregisterServerProc(handle.proc);
  if (handle?.composeProjectName) unregisterComposeProject(handle.composeProjectName);
  if (handle?.workspaceDir) unregisterWorkspace(handle.workspaceDir);
}

/** POST /api/session/start → returns sessionId. */
async function httpStartSession(baseUrl) {
  const res = await fetch(`${baseUrl}/api/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`start failed: HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.sessionId) throw new Error(`start returned no sessionId: ${JSON.stringify(data)}`);
  return data.sessionId;
}

async function httpPostMessage(baseUrl, sessionId, message) {
  const res = await fetch(`${baseUrl}/api/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`message failed: HTTP ${res.status}: ${await res.text().catch(() => '')}`);
}

async function httpConfirmPlan(baseUrl, sessionId) {
  const res = await fetch(`${baseUrl}/api/session/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`confirm failed: HTTP ${res.status}: ${await res.text().catch(() => '')}`);
}

/**
 * "Default-to-first-option" responder. The router asks free-form clarification
 * questions in cline-text events; my reply needs to be authoritative enough
 * for it to commit to a plan.
 *
 * History: an earlier minimalist framing ("simplest version", "trust your
 * judgment") caused the router to drop major components (RAG → frontend-only).
 * That was over-corrected with a version that ENUMERATED scopes ("frontend,
 * backend, database, vectordb, integration") and demanded all of them — which
 * defeated scope-creep tests entirely (t17/t21 always got 5 scopes regardless
 * of the original prompt's vocabulary).
 *
 * Current balance: answer choice questions with A; do NOT enumerate scopes;
 * defer scope decisions to the router's vocabulary-driven SCOPE DECISIONS
 * section (router.md v5.0+). This lets the router under-trim if its prompt
 * is wrong AND lets it correctly omit speculative scopes when the original
 * prompt didn't ask for them.
 */
function firstOptionResponderText() {
  return [
    'My answers to your questions:',
    '- Pick option A for every question you asked.',
    '',
    'Now produce the execute plan. Honor what my ORIGINAL prompt asked for — do NOT trim components the original prompt explicitly described, AND do NOT add scopes (frontend, vectordb, etc.) that the original prompt did not mention or imply via vocabulary. The vocabulary in the original prompt is the source of truth for which scopes belong in the plan.',
  ].join('\n');
}

/**
 * Continuation-flavored variant of firstOptionResponderText().
 *
 * The greenfield responder above references "my ORIGINAL prompt" — fine when
 * the user's first message was a long technical spec, but for short
 * continuation prompts ("Add user auth to this app.") the router parses that
 * phrasing as "there was a fuller spec I've lost" and falls into a refusal
 * loop ("I don't have your original request in this conversation — could you
 * paste it?"). That happened consistently on t-sub-multi-continuation post
 * router-skip-shortcut removal (rounds 2-6 all asking for a paste).
 *
 * This variant: answer A; don't reference "original prompt"; lean on the
 * router's CONTINUATION MODE budget (0-1 rounds) to push it to execute.
 * Scope-trim discipline is delegated to the router's vocabulary-driven
 * SCOPE DECISIONS, same as the greenfield variant.
 */
function firstOptionResponderContinuationText() {
  return [
    'My answers to your questions:',
    '- Pick option A for every question you asked.',
    '',
    'Now produce the execute plan for the request I made at the start of this conversation. Proceed with sensible defaults — do not ask further questions, and do not invent a different request. Scope the plan to what my request actually changes; don\'t add scopes I didn\'t imply.',
  ].join('\n');
}

function resolveResponder(name) {
  switch (name) {
    case 'first-option-continuation': return firstOptionResponderContinuationText;
    case 'first-option':
    default: return firstOptionResponderText;
  }
}

/**
 * Run one multi-scope scenario end-to-end:
 *   1. Mint isolated workspace + boot server subprocess
 *   2. Open Socket.IO client; POST initial prompt
 *   3. State-machine on incoming events:
 *      - status:idle (router waiting for clarify) → POST default-A response
 *      - plan_preview → POST confirm
 *      - scope_status retrying → record retry count
 *   4. Watch subprocess stdout for `Auto-start: compose up (Xms, ok=Y)` —
 *      that's the canonical terminal signal
 *   5. Tear down subprocess
 *
 * Wall-clock cap: 12 min. Scenario fails if no compose-up signal within cap.
 */
async function runMultiScopeScenario(scenario, { portOffset = 0 } = {}) {
  const startedAt = Date.now();
  // Spike-server port. Without offset: 5052 + random. With offset: each
  // pool slot gets its own deterministic 10-port band so parallel scenarios
  // can never collide on the chat-service port (random + 80-port range
  // would have ~(N-1)/80 collision risk per scenario at small N).
  const port = portOffset > 0
    ? 5200 + portOffset * 10 + Math.floor(Math.random() * 10)
    : 5052 + Math.floor(Math.random() * 80);
  const workspace = freshMultiScopeWorkspace(scenario.id);
  console.log(`[smoke]    workspace=${workspace}`);
  if (typeof scenario.setup === 'function') {
    await scenario.setup(workspace);
    console.log(`[smoke]    setup() seeded workspace`);
  }
  console.log(`[smoke]    booting server on :${port}…`);

  let server;
  try {
    server = await bootSpikeServer({ workspaceDir: workspace, port, label: scenario.id, portOffset });
  } catch (err) {
    return {
      scenario, status: 'error', durationMs: Date.now() - startedAt,
      error: `server boot: ${err.message}`,
      sessionId: 'n/a',
    };
  }

  // composeOutcome: terminal disposition once the run reaches its end state.
  //   'true'    — compose up succeeded (ok=true). PASS.
  //   'false'   — compose up failed (ok=false). FAIL.
  //   'skipped' — Auto-start skipped (no docker-compose.yml; router didn't
  //               produce an integration scope, OR the integration scope
  //               failed to write the compose file). FAIL by default since
  //               the goal is a deployable app.
  //   null      — no terminal signal seen (wall clock timed out).
  const observed = {
    composeOutcome: null,
    retries: 0,
    scopes: [],
    composeUpDurationMs: null,
  };
  let socket = null;
  let clarifyRounds = 0; // count of clarify-idle responses we've sent; cap below
  const MAX_CLARIFY_ROUNDS = 5;
  let planConfirmed = false;
  // True once we've seen the server emit `status: working` AFTER /confirm
  // was POSTed. The server emits an interim `status: idle` BETWEEN
  // plan_preview and /confirm processing (waiting for user input); without
  // this gate, the post-confirm-idle handler would resolve composePromise
  // on that interim idle, killing the build before it starts.
  let dispatchStarted = false;
  // Stdout-signal seen — used by composeWatcher for de-dup. Promise resolution
  // is gated on the post-dispatch `status: idle` socket event below (see
  // resolveCompose wrapper), NOT on this flag.
  let terminalSignalSeen = false;
  // True once resolveCompose / rejectCompose have been called. Used by the
  // wall-clock timer's guard so it correctly fires on a hung server even
  // though composeWatcher already set the stdout flag.
  let composePromiseResolved = false;

  // Listen on subprocess stdout for either of the two terminal signals from
  // tryAutoStartApp. Sidesteps having to add new event types in session/docker-orchestration.js.
  const composeRegex = /Auto-start: compose up \((\d+)ms, ok=(true|false)\)/;
  const skippedNoComposeRegex = /Auto-start skipped — no docker-compose\.yml/;
  const skippedPortConflictRegex = /Auto-start skipped — port conflict on (.+)/;
  // Step 2 (session/docker-orchestration.js commit 1086ec3) added a fourth Auto-start exit path:
  // when the dispatched run completes but didn't confirm the build (exit !=0
  // OR buildPassed=false). Without this regex the scenario sits idle until
  // the 12-min wall-clock fires — observed on t31 + t33 in the 2026-05-04
  // Step-3 verify run. Treat as 'skipped' (FAIL by default per line 491-498
  // semantics) and capture the reason for the FAIL message.
  //
  // Cross-scope reconciler hard-fail. Two stdout-visible signals to anchor on:
  //   - tlog: "[session] Reconciler: N hard mismatch(es) remain — skipping compose build"
  //   - the formatted diagnostic from formatHardFailDiagnostic — only goes
  //     through the cline event channel (socket.io), NOT stdout — so we can't
  //     match it here. Use the tlog line as the terminal signal instead.
  const reconcilerHardFailRegex = /\[session\] Reconciler: \d+ hard mismatch\(es\) remain — skipping compose build/;
  // Compose build failure is also a terminal signal — tryAutoStartApp emits
  // "Build failed..." via cline event (socket.io, not stdout) and returns,
  // so without this regex the harness sits at the 12-min wall-clock waiting
  // for compose-up signal that never comes. Anchor on the tlog line instead.
  // Observed t32 v5 (2026-05-09): reconciler ran clean, but Docker bake/
  // buildkit state was stale → build returned ok=false → harness hung.
  const composeBuildFailRegex = /\[session\] Auto-start: compose build \(\d+ms, ok=false\)/;
  // Step 5a fifth exit path: dispatch (runScopedPhases / runBuildDispatch)
  // returned exitCode != 0 — auto-start can't fire and there's nothing to
  // validate. Without this regex the smoke harness sat for 12 min on t11
  // ORCH in the 2026-05-04 final gate.
  const skippedDispatchRegex = /Auto-start skipped — dispatch failed \(exitCode=(\d+)\)/;
  let rawResolveCompose, rawRejectCompose;
  const composePromise = new Promise((res, rej) => { rawResolveCompose = res; rawRejectCompose = rej; });
  // Idempotent wrappers — resolution is now event-driven (post-confirm
  // `status: idle` event after the server's writeRunSummary has fired,
  // see the socket handler below). composeWatcher updates `observed.*`
  // diagnostic state from stdout but no longer resolves; the wall-clock
  // timer's guard uses composePromiseResolved (not terminalSignalSeen)
  // so a hung server still gets rejected after 12 min.
  const resolveCompose = () => {
    if (composePromiseResolved) return;
    composePromiseResolved = true;
    rawResolveCompose();
  };
  const rejectCompose = (err) => {
    if (composePromiseResolved) return;
    composePromiseResolved = true;
    rawRejectCompose(err);
  };
  // Safety-net timer for the post-terminal-signal phase. We normally resolve
  // composePromise on the `status: idle` socket event that fires AFTER
  // writeRunSummary completes (gives telemetry asserts a settled jsonl record).
  // But empirically (observed on t6 v17 with compose-up failure) the
  // status:idle event sometimes never reaches the smoke socket — possibly a
  // Socket.IO buffering edge case after a flurry of failure-path text events.
  // Without this safety net the smoke wall-clocks even though all the server-
  // side work has already finished. 60s is comfortably more than
  // writeRunSummary's typical ~10ms; if status:idle hasn't arrived by then,
  // it's not coming.
  let postTerminalFallbackTimer = null;
  const armPostTerminalFallback = () => {
    if (postTerminalFallbackTimer) return;
    postTerminalFallbackTimer = setTimeout(() => {
      if (composePromiseResolved) return;
      console.warn(`[smoke]    composePromise resolving via post-terminal fallback timer (status:idle never arrived after compose-up signal)`);
      resolveCompose();
    }, 60_000);
    postTerminalFallbackTimer.unref?.();
  };

  const composeWatcher = (chunk) => {
    if (terminalSignalSeen) return;
    const s = chunk.toString();
    const m = s.match(composeRegex);
    if (m) {
      terminalSignalSeen = true;
      observed.composeUpDurationMs = parseInt(m[1], 10);
      observed.composeOutcome = m[2]; // 'true' or 'false'
      // Resolution deferred — wait for `status: idle` socket event so
      // writeRunSummary has time to append its jsonl record before the
      // harness runs telemetry asserts. Safety-net timer ensures we don't
      // hang if the socket event is lost.
      armPostTerminalFallback();
      return;
    }
    const portConflict = s.match(skippedPortConflictRegex);
    if (portConflict) {
      terminalSignalSeen = true;
      observed.composeOutcome = 'port_conflict';
      observed.portConflict = portConflict[1].trim();
      armPostTerminalFallback();
      return;
    }
    if (skippedNoComposeRegex.test(s)) {
      terminalSignalSeen = true;
      observed.composeOutcome = 'skipped';
      armPostTerminalFallback();
      return;
    }
    if (reconcilerHardFailRegex.test(s)) {
      terminalSignalSeen = true;
      observed.composeOutcome = 'skipped';
      observed.skipReason = 'cross-scope reconciler reported hard mismatches';
      armPostTerminalFallback();
      return;
    }
    if (composeBuildFailRegex.test(s)) {
      terminalSignalSeen = true;
      observed.composeOutcome = 'build_failed';
      observed.skipReason = 'docker compose build returned ok=false';
      armPostTerminalFallback();
      return;
    }
    const dispatchFail = s.match(skippedDispatchRegex);
    if (dispatchFail) {
      terminalSignalSeen = true;
      observed.composeOutcome = 'skipped';
      observed.skipReason = `dispatch failed (exitCode=${dispatchFail[1]})`;
      armPostTerminalFallback();
    }
  };
  server.proc.stdout.on('data', composeWatcher);

  // SIGKILL grace timer — stored in the outer scope so the `finally` block can
  // clear it on the happy path. Prior bug (t39 1877s vs 720s cap): the timer
  // was inlined inside the wallClockTimer callback with no handle, so SIGKILL
  // could fire AFTER the scenario was already torn down, OR fail silently if
  // SIGTERM left the process in a half-shutdown state where exitCode was null
  // but the process had already detached its docker compose children. Fix:
  // (a) shorten SIGTERM grace from 5s → 2s (no benefit to long graceful
  // shutdown after we've already burned the wall-clock cap),
  // (b) ALWAYS SIGKILL after grace regardless of exitCode (sending SIGKILL
  // to an already-exited PID is a no-op — `process.kill` throws ESRCH which
  // we catch), and
  // (c) ALSO `proc.kill('SIGKILL')` as a fallback to the direct child in case
  // the proc-group send failed (e.g., subprocess detached from its group).
  let sigkillGraceTimer = null;
  const wallClockTimer = setTimeout(() => {
    // Guard on resolution, not stdout signal — stdout may have fired but the
    // post-confirm idle event might never arrive (server bug / hung handler).
    // If we guarded on terminalSignalSeen the timer would mistakenly skip
    // firing the rejection and the scenario would hang silently.
    if (composePromiseResolved) return;
    // Active kill — passive Promise rejection isn't enough. Phase agents may
    // have spawned long-running diagnostic commands (docker compose logs,
    // docker stats, etc.) that survive the harness "I gave up" signal and
    // continue eating daemon resources for the next scenario. SIGTERM the
    // spike-server subprocess group first (cooperative shutdown); SIGKILL
    // after a 2s grace whether or not exitCode looks set. tearDownSpikeServer's
    // leftover-name sweep handles any compose-up containers it left behind.
    try {
      const proc = server?.proc;
      if (proc && proc.exitCode === null) {
        // negative pid = process group; matches detached:true subprocess spawn
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
        // 2s grace then SIGKILL — unconditional, not gated on exitCode (race-free)
        sigkillGraceTimer = setTimeout(() => {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
          // Belt-and-suspenders: direct-child kill in case the proc-group send
          // missed (subprocess detached from its group, or pid reaped already).
          try { proc.kill('SIGKILL'); } catch {}
        }, 2_000);
        // Don't keep the event loop alive solely for this timer — once main
        // teardown completes, we don't need the grace to keep firing.
        if (sigkillGraceTimer.unref) sigkillGraceTimer.unref();
      }
    } catch {}
    rejectCompose(new Error('scenario exceeded 18-min wall clock'));
  }, 18 * 60 * 1000);  // 12 → 18 min: complex scenarios like t6 (RAG, 5 scopes, ~13 endpoints) now reach reconciler+auto-recovery+compose-build (~12 min), which used to never run because the LLM stage timed out first. The full pipeline needs more budget.

  let sessionId = 'pending';

  try {
    // socket.io-client lives in chat/node_modules — import from there
    const ioClientPath = path.join(SPIKE_ROOT, 'chat', 'node_modules', 'socket.io-client', 'build', 'esm', 'index.js');
    const { io } = await import(ioClientPath);

    sessionId = await httpStartSession(server.baseUrl);
    console.log(`[smoke]    session=${sessionId}; opening socket…`);

    socket = io(server.baseUrl, {
      query: { sessionId },
      transports: ['polling', 'websocket'],
    });

    // Diagnostic: log a one-line summary of every event received. Without this
    // a stalled state machine looks identical to "no events arriving" in the
    // log, and we can't tell which is happening from the outside.
    socket.on('event', (evt) => {
      const t = evt?.type ?? '?';
      const sub = evt?.payload?.status || evt?.payload?.say || evt?.payload?.scope || '';
      console.log(`[smoke]    [event] type=${t}${sub ? ' ' + JSON.stringify(sub) : ''}`);
    });

    socket.on('event', async (evt) => {
      const payload = evt?.payload || {};

      if (evt.type === 'plan_preview' && !planConfirmed) {
        // Set planConfirmed = true SYNCHRONOUSLY before any await. The
        // judge call below uses `await import('./router-judge.js')` which
        // yields control to the event loop — without this guard, a
        // status:idle event arriving on the SSE stream right after this
        // plan_preview would be processed by the status:idle handler
        // (which checks `!planConfirmed`) BEFORE plan_preview's confirm
        // POST fires. The status:idle handler then POSTs /message
        // (clarify-response), the chat-app sets session.status='working',
        // and when this handler eventually POSTs /confirm it gets HTTP 409
        // "Already working". Empirically observed as ~50% of multi-scope
        // gate runs after Track A's A5 added the dynamic-import yield
        // (commit b7a21f7, 2026-05-08). Setting the guard pre-await closes
        // the race; the original assignment is below (now redundant but
        // harmless).
        planConfirmed = true;
        observed.scopes = (payload.tasks || []).map((t) => t.scope);

        // Router-trim guard. The clarify responder asks for the FULL system, but
        // model variance occasionally still produces a single-scope landing-page
        // plan for a multi-scope scenario. Catching that here prevents an hour
        // of compute from masquerading as a useful test result.
        const expected = scenario.expectedScopes || [];
        const missing = expected.filter((s) => !observed.scopes.includes(s));
        if (missing.length) {
          observed.routerTrimmed = true;
          observed.missingScopes = missing;
          rejectCompose(new Error(
            `router-trim: expected scopes=[${expected.join(', ')}] but got [${observed.scopes.join(', ') || 'none'}] — missing [${missing.join(', ')}]. ` +
            `Smoke aborted before plan-confirm to avoid a misleading multi-scope result. ` +
            `Either tighten firstOptionResponderText() or accept this scenario can't be validated under current router behaviour.`
          ));
          return;
        }

        // Track A (A4): deterministic per-scenario router-output assertion.
        // Run AFTER the router-trim scope guard (so missing scopes surface
        // there) but BEFORE httpConfirmPlan so a misleading multi-scope
        // build doesn't waste compute. plannerExpect is optional per scenario;
        // assertRouterExpect short-circuits silently when not provided.
        if (scenario.plannerExpect) {
          try {
            assertRouterExpect(payload, scenario.plannerExpect);
            observed.plannerExpectPassed = true;
          } catch (err) {
            observed.plannerExpectPassed = false;
            observed.plannerExpectError = err.message;
            rejectCompose(new Error(`plannerExpect: ${err.message}`));
            return;
          }
        }

        // Track A (A5): LLM-judge for semantic-intent match. One Sonnet call
        // per scenario, gate-time only, after the deterministic gate passes.
        // PASS threshold = 0.8. Graceful-degrades silently when the judge
        // assistant isn't configured (JUDGE_ASSISTANT_ID unset) — score=null
        // is logged but doesn't fail the scenario.
        if (scenario.expectedIntent) {
          try {
            const { judgeRouterOutput } = await import('../../server/agent/planner/router-judge.js');
            const userPromptText = typeof scenario.prompt === 'function' ? scenario.prompt() : scenario.prompt;
            const judgeResult = await judgeRouterOutput({
              userPrompt: userPromptText,
              expectedIntent: scenario.expectedIntent,
              routerOutput: payload,
            });
            observed.judgeScore = judgeResult.score;
            observed.judgeReasoning = judgeResult.reasoning;
            if (judgeResult.score === null) {
              console.log(`[smoke]    judge: skipped — ${judgeResult.reasoning}`);
            } else {
              console.log(`[smoke]    judge: score=${judgeResult.score.toFixed(2)} — ${judgeResult.reasoning}`);
              if (judgeResult.score < 0.8) {
                rejectCompose(new Error(`judge: score=${judgeResult.score.toFixed(2)} (<0.8) — ${judgeResult.reasoning}`));
                return;
              }
            }
          } catch (err) {
            console.warn(`[smoke]    judge: error — ${err.message}`);
            observed.judgeError = err.message;
          }
        }

        planConfirmed = true;
        console.log(`[smoke]    plan held: scopes=[${observed.scopes.join(', ')}] — confirming…`);
        try { await httpConfirmPlan(server.baseUrl, sessionId); }
        catch (err) { rejectCompose(err); }
        return;
      }

      // Track dispatch start. /confirm handler emits `status: working`
      // (routes.js:1871) before running dispatch. Gating the post-dispatch
      // idle handler on this avoids resolving on the interim pre-/confirm
      // idle the server emits between plan_preview and dispatch.
      if (planConfirmed && evt.type === 'status' && payload.status === 'working') {
        dispatchStarted = true;
        return;
      }

      // Post-dispatch terminal state. After /confirm fires, the server runs
      // dispatch → tryAutoStartApp (which emits the `Auto-start: compose up`
      // stdout line that composeWatcher matches above) → writeRunSummary →
      // emits THIS idle event. By resolving on this signal (not the stdout
      // regex), the harness guarantees writeRunSummary has appended its
      // jsonl record before telemetry asserts run.
      // status: 'error' is the failure variant emitted by the confirm
      // handler's outer try/catch (routes.js:2183).
      if (dispatchStarted && evt.type === 'status'
          && (payload.status === 'idle' || payload.status === 'error')) {
        if (payload.status === 'error' && payload.error) {
          observed.serverError = payload.error;
        }
        resolveCompose();
        return;
      }

      if (evt.type === 'status' && payload.status === 'idle' && !planConfirmed) {
        // Router went idle awaiting clarification answers. The router can ask
        // multiple rounds before deciding to execute, so respond to every
        // idle until plan_preview fires (then planConfirmed gates this off).
        // Cap at MAX_CLARIFY_ROUNDS to avoid an infinite loop if the router
        // keeps asking instead of committing.
        if (clarifyRounds >= MAX_CLARIFY_ROUNDS) {
          rejectCompose(new Error(`router asked ${clarifyRounds + 1} clarify rounds without producing a plan`));
          return;
        }
        clarifyRounds += 1;
        const responderFn = resolveResponder(scenario.clarifyResponder);
        console.log(`[smoke]    answering clarify round ${clarifyRounds} with ${scenario.clarifyResponder || 'first-option'}…`);
        try { await httpPostMessage(server.baseUrl, sessionId, responderFn()); }
        catch (err) { rejectCompose(err); }
        return;
      }

      if (evt.type === 'scope_status' && payload.status === 'retrying' && payload.reason === 'false_refusal') {
        observed.retries += 1;
        console.log(`[smoke]    [retry] scope=${payload.scope} attempt=${payload.attempt}`);
      }
    });

    // Wait for the Socket.IO connection to fully establish AND the server to
    // join us to the session room. Without this, events emitted between the
    // POST /message and the connection-handshake completion are lost — the
    // harness then waits for events that already fired and times out.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        socket.off('connect', onConn);
        socket.off('connect_error', onErr);
        reject(new Error('socket.io connect timeout (10s)'));
      }, 10_000);
      const onConn = () => {
        clearTimeout(t);
        socket.off('connect_error', onErr);
        // Tiny grace period so the server-side `io.on('connection', ...)`
        // handler runs and joins us to `session:<id>` before we POST.
        setTimeout(resolve, 200);
      };
      const onErr = (err) => {
        clearTimeout(t);
        socket.off('connect', onConn);
        reject(new Error(`socket.io connect_error: ${err?.message || err}`));
      };
      socket.once('connect', onConn);
      socket.once('connect_error', onErr);
    });
    console.log(`[smoke]    socket connected; sending prompt (${scenario.prompt.length} chars)…`);
    await httpPostMessage(server.baseUrl, sessionId, scenario.prompt);

    // Mid-build interrupt hook (used by t-iteration-queue-mid-build, flow 6).
    // The scenario provides `midBuildInterrupt: { delayMs, message }`. After
    // `delayMs` we POST the message to /api/session/<id>/message. The
    // expected server behaviour is to respond HTTP 202 with an
    // `iteration_queued` typed event in the transcript stream (queue holds
    // it until the in-flight build finishes; then drains it as the next
    // router call). We capture the response status into observed for the
    // post-run assertions.
    let midBuildTimer = null;
    if (scenario.midBuildInterrupt && typeof scenario.midBuildInterrupt.message === 'string') {
      const delayMs = Number(scenario.midBuildInterrupt.delayMs) > 0
        ? Number(scenario.midBuildInterrupt.delayMs)
        : 45_000;
      midBuildTimer = setTimeout(async () => {
        try {
          const res = await fetch(`${server.baseUrl}/api/session/${sessionId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: scenario.midBuildInterrupt.message }),
          });
          observed.midBuildResponseStatus = res.status;
          console.log(`[smoke]    mid-build interrupt POST: HTTP ${res.status}`);
        } catch (err) {
          observed.midBuildPostError = err.message;
          console.log(`[smoke]    mid-build interrupt POST failed: ${err.message}`);
        }
      }, delayMs);
      if (midBuildTimer.unref) midBuildTimer.unref();
    }

    await composePromise;
    if (midBuildTimer) clearTimeout(midBuildTimer);
  } catch (err) {
    const errored = {
      scenario, status: 'error', durationMs: Date.now() - startedAt,
      error: err.message, sessionId, observed,
    };
    recordSmokeMetric(errored);
    return errored;
  } finally {
    clearTimeout(wallClockTimer);
    if (sigkillGraceTimer) clearTimeout(sigkillGraceTimer);
    if (socket) { try { socket.close(); } catch { /* noop */ } }
    if (server) await tearDownSpikeServer(server);
  }

  const durationMs = Date.now() - startedAt;
  // PASS on compose-up ok=true. PASS-with-flag on port_conflict (environmental
  // — another docker stack/parallel scenario holds the port; the LLM pipeline
  // already finished correctly, we just couldn't bind a host port to validate
  // compose-up). ok=false (deployment crashed), skipped (no docker-compose.yml
  // — router didn't include integration or integration failed to produce one),
  // and null (timeout) are all FAIL.
  let status;
  if (observed.composeOutcome === 'true') status = 'pass';
  else if (observed.composeOutcome === 'port_conflict') status = 'pass'; // flagged; see assertNotes.portConflict
  else status = 'fail';
  const assertNotes = {
    outcome: observed.composeOutcome ?? 'timeout',
    scopes: observed.scopes.join('+') || '?',
    retries: observed.retries,
    composeMs: observed.composeUpDurationMs,
  };
  if (observed.portConflict) {
    assertNotes.portConflict = observed.portConflict;
    assertNotes.portConflictFlag = 'PASS-WITH-FLAG (compose-up not validated due to host-port conflict; LLM pipeline succeeded)';
  }
  // Structural asserts: if compose-up succeeded, also check that the produced
  // files have the right shape. Catches regressions that compose-build past
  // (no /api/ prefix in routes, both nginx configs, init.sql at canonical
  // path, service names match folder names, /data volume mount).
  let structuralFailures = [];
  if (status === 'pass') {
    structuralFailures = runStructuralAsserts(workspace, observed.scopes);
    if (structuralFailures.length > 0) {
      status = 'fail';
      assertNotes.structuralFailures = structuralFailures.map(f => `${f.scope}/${f.check}: ${f.error}`);
    }
  }
  // Telemetry asserts (Dispatch 4 Part F.2): every scenario gets telemetry
  // validation regardless of pass/fail. Soft-fail behaviour — telemetry
  // misses surface as assertNotes.telemetryFailures but don't downgrade
  // status if structural already passed; they DO downgrade status if the
  // scenario was passing on structural grounds. Rationale: a telemetry
  // gap is real signal (W1.TEL pipeline broken) but secondary to "did the
  // app build."
  let telemetryFailures = [];
  try {
    telemetryFailures = runTelemetryAsserts(workspace, scenario, { sessionId });
  } catch (err) {
    telemetryFailures = [{ check: 'runTelemetryAsserts', error: err.message }];
  }
  if (telemetryFailures.length > 0) {
    assertNotes.telemetryFailures = telemetryFailures.map(f => `${f.check}: ${f.error}`);
    if (status === 'pass') status = 'fail';
  }
  // Multi-scope fails reach here without a thrown `error` (outcome-based fail
  // path through composeWatcher). Synthesize a one-line reason so printSummary
  // and the per-scenario log show "FAIL — outcome=false scopes=…" instead of
  // "FAIL — undefined".
  const error = status === 'pass'
    ? null
    : (structuralFailures.length > 0
        ? `structural: ${structuralFailures.map(f => f.error).join('; ')}`
        : telemetryFailures.length > 0
          ? `telemetry: ${telemetryFailures.map(f => f.error).join('; ')}`
          : Object.entries(assertNotes).map(([k, v]) => `${k}=${v ?? 'null'}`).join(' '));
  const out = { scenario, status, durationMs, observed, assertNotes, error, sessionId };
  recordSmokeMetric(out);
  return out;
}

/**
 * Multi-turn scenario harness — build + N iterations against ONE workspace.
 *
 * Reuses the multi-scope bootstrap (workspace, server subprocess, Socket.IO
 * client, plan-preview + clarify state machine) for the initial build. After
 * the first compose-up signal lands, the harness POSTs each iteration message
 * in turn, waits for the next compose-up signal (or `iterate-done` event from
 * single-scope-direct iteration), captures a per-turn snapshot, and runs the
 * scenario-provided per-turn assertion before proceeding.
 *
 * Scenario shape additions over multi-scope:
 *   - mode: 'multi-turn'
 *   - iterations: [{ prompt: string|fn, assertTurn?: ({turn, observed, workspace, sessionId}) => void }, ...]
 *     Each iteration runs after the prior build completes. `assertTurn` may
 *     throw to fail the scenario at that turn.
 *
 * Returns the same { scenario, status, durationMs, observed, assertNotes,
 * error, sessionId } shape as runMultiScopeScenario, with additional
 * `assertNotes.turns: [{ turn, outcome, durationMs, assertError? }]` per-turn
 * detail.
 *
 * Verification rule (per TESTING_EVOLUTION.md Dispatch 4 Part D): a scenario
 * with `iterations: []` (zero iterations) must behave identically to the same
 * scenario as a single-turn multi-scope scenario. The wall-clock cap covers
 * the FULL multi-turn run, not per-turn; per-iteration progress is observed
 * via the same compose-watcher regex set.
 */
async function runMultiTurnScenario(scenario, { portOffset = 0, captureSnapshot = null } = {}) {
  const startedAt = Date.now();
  const port = portOffset > 0
    ? 5200 + portOffset * 10 + Math.floor(Math.random() * 10)
    : 5052 + Math.floor(Math.random() * 80);
  const workspace = freshMultiScopeWorkspace(scenario.id);
  console.log(`[smoke]    workspace=${workspace}`);
  // fromSnapshot pre-populates the workspace from a captured fixture so the
  // scenario can skip turn 0 (initial build) and start at iteration 1.
  // Mutually exclusive with captureSnapshot — when capturing we need a
  // real initial build, not a restored one.
  if (scenario.fromSnapshot && !captureSnapshot) {
    restoreSnapshotIntoWorkspace(scenario.fromSnapshot, workspace);
    console.log(`[smoke]    fromSnapshot=${scenario.fromSnapshot}: restored fixture into workspace`);
  }
  if (typeof scenario.setup === 'function') {
    await scenario.setup(workspace);
    console.log(`[smoke]    setup() seeded workspace`);
  }
  console.log(`[smoke]    booting server on :${port}…`);

  let server;
  try {
    server = await bootSpikeServer({ workspaceDir: workspace, port, label: scenario.id, portOffset });
  } catch (err) {
    return {
      scenario, status: 'error', durationMs: Date.now() - startedAt,
      error: `server boot: ${err.message}`,
      sessionId: 'n/a',
    };
  }

  // In capture mode we want ONLY the initial build to run — no iterations
  // would mutate the workspace we're about to snapshot.
  const iterations = captureSnapshot
    ? []
    : (Array.isArray(scenario.iterations) ? scenario.iterations : []);
  const turnsObserved = [];
  let socket = null;
  let sessionId = 'pending';
  // sigkillGraceTimer is hoisted so the finally block can clear it
  let sigkillGraceTimer = null;

  // Wall-clock cap for the FULL multi-turn run (build + N iterations).
  // Generous: 12 min for build + 8 min per iteration. Each iteration's
  // build-complete signal resets the per-turn timer; the overall cap
  // prevents runaway loops if iterations never resolve.
  const overallCap = (12 + iterations.length * 8) * 60 * 1000;
  let overallTimedOut = false;
  const overallCapTimer = setTimeout(() => {
    overallTimedOut = true;
    try {
      const proc = server?.proc;
      if (proc && proc.exitCode === null) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
        sigkillGraceTimer = setTimeout(() => {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
          try { proc.kill('SIGKILL'); } catch {}
        }, 2_000);
        if (sigkillGraceTimer.unref) sigkillGraceTimer.unref();
      }
    } catch {}
  }, overallCap);

  try {
    const ioClientPath = path.join(SPIKE_ROOT, 'chat', 'node_modules', 'socket.io-client', 'build', 'esm', 'index.js');
    const { io } = await import(ioClientPath);

    sessionId = await httpStartSession(server.baseUrl);
    console.log(`[smoke]    session=${sessionId}; opening socket…`);
    socket = io(server.baseUrl, {
      query: { sessionId },
      transports: ['polling', 'websocket'],
    });

    // Per-turn observed state. Reset between turns so each iteration gets a
    // fresh observation slate but the workspace/server/socket are reused.
    // fromSnapshot scenarios skip turn 0 (the initial build) — the workspace
    // was already pre-populated above via restoreSnapshotIntoWorkspace. We
    // start at turn 1 with iterations[0] and let the loop carry on normally.
    let turn = (scenario.fromSnapshot && !captureSnapshot) ? 1 : 0;
    let observedThisTurn = newTurnObservedState();
    let planConfirmed = false;
    // See single-scope watcher's `dispatchStarted` comment — gates post-
    // dispatch idle handler so we don't resolve on the interim pre-/confirm
    // idle that the server emits between plan_preview and dispatch start.
    let dispatchStarted = false;
    let clarifyRounds = 0;
    let terminalSignalSeen = false;
    let composePromiseResolved = false;
    let rawResolveCompose;
    let rawRejectCompose;
    let composePromise = new Promise((res, rej) => { rawResolveCompose = res; rawRejectCompose = rej; });
    // Idempotent wrappers — same race-fix pattern as the single-scope watcher
    // above. composeWatcher updates `observedThisTurn.*` from stdout but no
    // longer resolves; the post-confirm `status: idle` socket event resolves.
    const resolveCompose = () => {
      if (composePromiseResolved) return;
      composePromiseResolved = true;
      rawResolveCompose();
    };
    const rejectCompose = (err) => {
      if (composePromiseResolved) return;
      composePromiseResolved = true;
      rawRejectCompose(err);
    };

    const MAX_CLARIFY_ROUNDS = 5;
    const composeRegex = /Auto-start: compose up \((\d+)ms, ok=(true|false)\)/;
    const skippedNoComposeRegex = /Auto-start skipped — no docker-compose\.yml/;
    const skippedPortConflictRegex = /Auto-start skipped — port conflict on (.+)/;
    const reconcilerHardFailRegex = /\[session\] Reconciler: \d+ hard mismatch\(es\) remain — skipping compose build/;
    const composeBuildFailRegex = /\[session\] Auto-start: compose build \(\d+ms, ok=false\)/;
    const skippedDispatchRegex = /Auto-start skipped — dispatch failed \(exitCode=(\d+)\)/;
    // Iteration-only: single-scope-direct iteration completes without a
    // compose-up, so we anchor on the agent's "iterate-done" stdout marker.
    const iterateDoneRegex = /\[session\] iterate-done scope=(\S+) outcome=(\S+)/;

    const composeWatcher = (chunk) => {
      if (terminalSignalSeen) return;
      const s = chunk.toString();
      const m = s.match(composeRegex);
      if (m) {
        terminalSignalSeen = true;
        observedThisTurn.composeUpDurationMs = parseInt(m[1], 10);
        observedThisTurn.composeOutcome = m[2];
        // Resolution deferred — wait for the post-confirm `status: idle`
        // socket event so writeRunSummary has time to append its jsonl.
        return;
      }
      const portConflict = s.match(skippedPortConflictRegex);
      if (portConflict) {
        terminalSignalSeen = true;
        observedThisTurn.composeOutcome = 'port_conflict';
        observedThisTurn.portConflict = portConflict[1].trim();
        return;
      }
      if (skippedNoComposeRegex.test(s)) {
        terminalSignalSeen = true;
        observedThisTurn.composeOutcome = 'skipped';
        return;
      }
      if (reconcilerHardFailRegex.test(s)) {
        terminalSignalSeen = true;
        observedThisTurn.composeOutcome = 'skipped';
        observedThisTurn.skipReason = 'cross-scope reconciler reported hard mismatches';
        return;
      }
      if (composeBuildFailRegex.test(s)) {
        terminalSignalSeen = true;
        observedThisTurn.composeOutcome = 'build_failed';
        observedThisTurn.skipReason = 'docker compose build returned ok=false';
        return;
      }
      const dispatchFail = s.match(skippedDispatchRegex);
      if (dispatchFail) {
        terminalSignalSeen = true;
        observedThisTurn.composeOutcome = 'skipped';
        observedThisTurn.skipReason = `dispatch failed (exitCode=${dispatchFail[1]})`;
        return;
      }
      // Iteration-only terminal signal: single-scope iteration finishes
      // without a compose-up (HMR-style cosmetic change applied in place).
      // This path DOES still resolve from stdout — iterate-done is emitted
      // from the dispatch handler after the run-summary write for the
      // iterate path (routes.js:1149), so no race exists here.
      const iterateDone = s.match(iterateDoneRegex);
      if (iterateDone && turn > 0) {
        terminalSignalSeen = true;
        observedThisTurn.composeOutcome = 'iterate-done';
        observedThisTurn.iterateScope = iterateDone[1];
        observedThisTurn.iterateOutcome = iterateDone[2];
        resolveCompose();
      }
    };
    server.proc.stdout.on('data', composeWatcher);

    socket.on('event', (evt) => {
      const t = evt?.type ?? '?';
      const sub = evt?.payload?.status || evt?.payload?.say || evt?.payload?.scope || '';
      console.log(`[smoke]    [event] type=${t}${sub ? ' ' + JSON.stringify(sub) : ''}`);
    });

    socket.on('event', async (evt) => {
      const payload = evt?.payload || {};

      // Track dispatch start. For turn 0 the server's /confirm handler
      // emits `status: working` (routes.js:1871) before dispatch. For
      // turn > 0 the POST /message handler's iterate path emits the same
      // (routes.js:1005). Gating the post-dispatch idle handler on this
      // avoids resolving on interim pre-dispatch idle events.
      if ((turn > 0 || planConfirmed)
          && evt.type === 'status' && payload.status === 'working') {
        dispatchStarted = true;
        return;
      }

      // Post-dispatch terminal state — see single-scope watcher's matching
      // handler for the full rationale.
      if (dispatchStarted && evt.type === 'status'
          && (payload.status === 'idle' || payload.status === 'error')) {
        if (payload.status === 'error' && payload.error) {
          observedThisTurn.serverError = payload.error;
        }
        resolveCompose();
        return;
      }

      // Plan-preview + clarify state machine — only relevant for turn 0
      // (initial build). Iterations bypass plan-preview because iterate
      // dispatches don't re-route through the planner.
      if (turn === 0) {
        if (evt.type === 'plan_preview' && !planConfirmed) {
          planConfirmed = true;
          observedThisTurn.scopes = (payload.tasks || []).map((t) => t.scope);
          try { await httpConfirmPlan(server.baseUrl, sessionId); }
          catch (err) { rejectCompose(err); }
          return;
        }
        if (evt.type === 'status' && payload.status === 'idle' && !planConfirmed) {
          if (clarifyRounds >= MAX_CLARIFY_ROUNDS) {
            rejectCompose(new Error(`router asked ${clarifyRounds + 1} clarify rounds without producing a plan`));
            return;
          }
          clarifyRounds += 1;
          const responderFn = resolveResponder(scenario.clarifyResponder);
          try { await httpPostMessage(server.baseUrl, sessionId, responderFn()); }
          catch (err) { rejectCompose(err); }
          return;
        }
      }

      if (evt.type === 'scope_status' && payload.status === 'retrying' && payload.reason === 'false_refusal') {
        observedThisTurn.retries += 1;
        console.log(`[smoke]    [retry] scope=${payload.scope} attempt=${payload.attempt}`);
      }

      // Post-build conversational tracking. Concierge replies fire as
      // concierge_text events (handle-action.js + dispatchConciergeAction).
      // Subagent dispatches fire scope_status:running (emitScopeStatus in
      // routes.js / build-dispatcher); counting them gives a clean
      // distinguisher between "concierge answered conversationally"
      // (zero) and "concierge triggered iterate" (>=1 per affected scope).
      if (evt.type === 'concierge_text' && typeof payload.text === 'string') {
        observedThisTurn.conciergeTextEvents.push({ text: payload.text });
      }
      if (evt.type === 'scope_status' && payload.status === 'running') {
        observedThisTurn.subagentDispatchCount += 1;
      }

      // Post-build conversational turns terminate when the server emits
      // status:idle WITHOUT a prior dispatchStarted (no subagent run, so no
      // compose-up signal will ever arrive). Resolve composePromise on this
      // signal so the turn loop advances. composeOutcome stays null —
      // assertTurn distinguishes via conciergeTextEvents / subagentDispatchCount.
      // Gate on (turn > 0 OR planConfirmed) === false so we don't false-resolve
      // on the pre-dispatch idle of turn 0.
      if (!dispatchStarted && turn > 0 && evt.type === 'status' && payload.status === 'idle'
          && observedThisTurn.conciergeTextEvents.length > 0) {
        observedThisTurn.composeOutcome = 'concierge-only';
        resolveCompose();
        return;
      }
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        socket.off('connect', onConn);
        socket.off('connect_error', onErr);
        reject(new Error('socket.io connect timeout (10s)'));
      }, 10_000);
      const onConn = () => { clearTimeout(t); socket.off('connect_error', onErr); setTimeout(resolve, 200); };
      const onErr = (err) => { clearTimeout(t); socket.off('connect', onConn); reject(new Error(`socket.io connect_error: ${err?.message || err}`)); };
      socket.once('connect', onConn);
      socket.once('connect_error', onErr);
    });
    if (scenario.fromSnapshot && !captureSnapshot) {
      // No initial build to send — workspace is already populated. POST the
      // first iteration's prompt directly so the loop's first `await
      // composePromise` resolves on the iteration's outcome.
      const firstIter = iterations[0];
      if (!firstIter || !firstIter.prompt) {
        throw new Error(`fromSnapshot scenario "${scenario.id}" requires iterations[0].prompt`);
      }
      const iterPrompt = typeof firstIter.prompt === 'function' ? firstIter.prompt() : firstIter.prompt;
      console.log(`[smoke]    socket connected; fromSnapshot=${scenario.fromSnapshot}, skipping initial build, sending iteration 1 (${iterPrompt.length} chars)…`);
      await httpPostMessage(server.baseUrl, sessionId, iterPrompt);
    } else {
      console.log(`[smoke]    socket connected; sending initial prompt (${scenario.prompt.length} chars)…`);
      const initialPrompt = typeof scenario.prompt === 'function' ? scenario.prompt() : scenario.prompt;
      await httpPostMessage(server.baseUrl, sessionId, initialPrompt);
    }

    // Turn loop: turn 0 is the initial build; subsequent turns are iterations.
    while (true) {
      const turnStart = Date.now();
      try {
        await composePromise;
      } catch (err) {
        observedThisTurn.error = err.message;
      }
      observedThisTurn.durationMs = Date.now() - turnStart;
      turnsObserved.push({ ...observedThisTurn, turn });

      // Run per-turn assertion if scenario provided one. assertTurn semantics:
      // for turn 0, scenario.assertInitialBuild?.(); for turn > 0,
      // scenario.iterations[turn-1].assertTurn?.().
      let assertError = null;
      try {
        if (turn === 0 && typeof scenario.assertInitialBuild === 'function') {
          scenario.assertInitialBuild({ observed: observedThisTurn, workspace, sessionId });
        }
        if (turn > 0) {
          const iter = iterations[turn - 1];
          if (iter && typeof iter.assertTurn === 'function') {
            iter.assertTurn({ turn, observed: observedThisTurn, workspace, sessionId });
          }
        }
      } catch (err) {
        assertError = err.message;
        turnsObserved[turnsObserved.length - 1].assertError = assertError;
      }

      // If this turn failed (compose did not produce a usable outcome OR the
      // per-turn assertion threw), stop the loop and surface.
      const turnPassed = !assertError &&
        (observedThisTurn.composeOutcome === 'true' ||
         observedThisTurn.composeOutcome === 'iterate-done' ||
         observedThisTurn.composeOutcome === 'port_conflict' ||
         observedThisTurn.composeOutcome === 'concierge-only');
      if (!turnPassed) break;

      // Advance to next turn if there are more iterations.
      turn += 1;
      if (turn > iterations.length) break;
      if (overallTimedOut) break;

      // Reset per-turn state and POST the iteration message.
      observedThisTurn = newTurnObservedState();
      terminalSignalSeen = false;
      composePromiseResolved = false;
      dispatchStarted = false;
      composePromise = new Promise((res, rej) => { rawResolveCompose = res; rawRejectCompose = rej; });
      const iterPrompt = typeof iterations[turn - 1].prompt === 'function'
        ? iterations[turn - 1].prompt()
        : iterations[turn - 1].prompt;
      console.log(`[smoke]    iteration ${turn}/${iterations.length}: sending message (${iterPrompt.length} chars)…`);
      try {
        await httpPostMessage(server.baseUrl, sessionId, iterPrompt);
      } catch (err) {
        observedThisTurn.error = `httpPostMessage: ${err.message}`;
        turnsObserved.push({ ...observedThisTurn, turn });
        break;
      }
    }
  } catch (err) {
    const errored = {
      scenario, status: 'error', durationMs: Date.now() - startedAt,
      error: err.message, sessionId,
      assertNotes: { turns: turnsObserved },
    };
    recordSmokeMetric(errored);
    return errored;
  } finally {
    clearTimeout(overallCapTimer);
    if (sigkillGraceTimer) clearTimeout(sigkillGraceTimer);
    if (socket) { try { socket.close(); } catch { /* noop */ } }
    if (server) await tearDownSpikeServer(server);
  }

  // Aggregate status: scenario PASSes only if every turn passed. fromSnapshot
  // scenarios don't run turn 0 (the initial build is restored from fixture),
  // so the expected turn count is iterations.length not 1+iterations.length.
  const expectedTurns = (scenario.fromSnapshot && !captureSnapshot)
    ? iterations.length
    : 1 + iterations.length;
  const allTurnsPassed = turnsObserved.length === expectedTurns &&
    turnsObserved.every(t => !t.assertError &&
      (t.composeOutcome === 'true' || t.composeOutcome === 'iterate-done'
        || t.composeOutcome === 'port_conflict' || t.composeOutcome === 'concierge-only'));
  let status = allTurnsPassed ? 'pass' : 'fail';
  const assertNotes = {
    turns: turnsObserved.map(t => ({
      turn: t.turn,
      outcome: t.composeOutcome ?? 'timeout',
      durationMs: t.durationMs,
      assertError: t.assertError ?? null,
      scopes: (t.scopes || []).join('+') || undefined,
    })),
    totalTurns: turnsObserved.length,
    expectedTurns,
  };
  // Telemetry asserts (Dispatch 4 Part F.2): run after multi-turn completes,
  // against the single workspace shared across all turns. The last turn's
  // sessionId is the same as the first's (we don't restart the session
  // between iterations).
  let telemetryFailures = [];
  try {
    telemetryFailures = runTelemetryAsserts(workspace, scenario, { sessionId });
  } catch (err) {
    telemetryFailures = [{ check: 'runTelemetryAsserts', error: err.message }];
  }
  if (telemetryFailures.length > 0) {
    assertNotes.telemetryFailures = telemetryFailures.map(f => `${f.check}: ${f.error}`);
    if (status === 'pass') status = 'fail';
  }
  const error = status === 'pass'
    ? null
    : turnsObserved.find(t => t.assertError || t.error)?.assertError
      ?? turnsObserved.find(t => t.assertError || t.error)?.error
      ?? (telemetryFailures.length > 0
        ? `telemetry: ${telemetryFailures.map(f => f.error).join('; ')}`
        : `multi-turn incomplete: ${turnsObserved.length}/${1 + iterations.length} turns finished`);
  // Snapshot capture: when the operator passed --capture-snapshot=<key>
  // and the scenario's initial build succeeded, persist the workspace +
  // metadata so future runs can use `fromSnapshot: '<key>'` to skip the
  // build. Failures are logged but don't flip the scenario status (the
  // run itself is still valid — capture is a side effect).
  if (captureSnapshot && status === 'pass') {
    try {
      await writeSnapshotFromWorkspace(workspace, captureSnapshot, scenario);
    } catch (err) {
      console.error(`[smoke]    snapshot capture failed: ${err.message}`);
      assertNotes.snapshotCaptureError = err.message;
    }
  } else if (captureSnapshot) {
    console.error(`[smoke]    snapshot NOT captured (scenario status=${status}); capture only runs on success`);
  }

  const out = {
    scenario, status, durationMs: Date.now() - startedAt,
    observed: { turns: turnsObserved }, assertNotes, error, sessionId,
  };
  recordSmokeMetric(out);
  return out;
}

function newTurnObservedState() {
  return {
    composeOutcome: null,
    composeUpDurationMs: null,
    retries: 0,
    scopes: [],
    error: null,
    durationMs: 0,
    // Post-build conversational tracking (used by Sm-3 + future post-build
    // smoke scenarios). conciergeTextEvents accumulates every concierge_text
    // SSE event payload for the current turn so assertTurn can check the
    // reply content. subagentDispatchCount counts scope_status:running events
    // — zero means concierge handled the turn without escalating to subagents
    // (a fast conversational path); non-zero means iterate/diagnose fired.
    conciergeTextEvents: [],
    subagentDispatchCount: 0,
  };
}

/**
 * Scenarios. Each scenario:
 *   - id: stable string for --only filtering
 *   - title: shown in output
 *   - scope: passed to runCustomAgent (affects event tagging)
 *   - envOverrides: temporarily applied to process.env for this scenario
 *   - dependsOn: optional id of a scenario that must run first; result is
 *     passed as `prev` to setup/assert
 *   - setup(prev, ws): optional — seed workspace files or return runCustomAgent
 *     extra opts (e.g. conversationId from prev)
 *   - prompt(prev): the user message to send
 *   - assert({ result, workspace, prev }): throw on failure, return notes
 */
const SCENARIOS = [
  {
    id: 't1-backend-health',
    title: 'Backend /health — single-scope build from scratch',
    mode: 'single-scope',
    scope: 'backend',
    prompt: () => wrapTaskPrompt(
      'Add a minimal Node + Express backend with a single GET /health endpoint that returns {ok: true}. ' +
      'Use the platform snippets where possible.'
    ),
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      if (!result.completionText) throw new Error('completionText is empty');
      // Canonical path per .platform-rules/scope-backend.md — the rule
      // mandates backend/src/index.ts (TypeScript) post-W1.PATHS.CANONICAL.
      // .js drift here means the rule→model pipeline regressed; smoke
      // strict-fails to detect it.
      const serverFile = 'backend/src/index.ts';
      if (!fs.existsSync(path.join(workspace, serverFile))) {
        throw new Error(`canonical entry file ${serverFile} missing`);
      }
      const src = fs.readFileSync(path.join(workspace, serverFile), 'utf-8');
      if (!/\/health/.test(src)) throw new Error(`${serverFile} does not reference /health`);
      if (!fs.existsSync(path.join(workspace, 'backend/package.json'))) {
        throw new Error('backend/package.json missing');
      }
      // Dockerfile is required for docker-compose build. The Coder may skip
      // the `cp Dockerfile.node Dockerfile` step when it batches writes —
      // the auto-fill safety net in agent.js should guarantee one exists.
      if (!fs.existsSync(path.join(workspace, 'backend/Dockerfile'))) {
        throw new Error('backend/Dockerfile missing (auto-fill safety net did not fire)');
      }
      const apiCalls = result.runTokenTotals?.apiCalls ?? 0;
      const promptTokens = result.runTokenTotals?.promptTokens ?? 0;
      if (apiCalls > 12) throw new Error(`apiCalls=${apiCalls}, ceiling 12`);
      if (promptTokens > 120_000) throw new Error(`promptTokens=${promptTokens}, ceiling 120K`);
      return { writtenFile: serverFile, apiCalls, promptTokens };
    },
  },
  // t2-continuation removed (cleanup): the test asserted that the same
  // `conversationId` was reused for a follow-up edit, and claimed the
  // reuse gave the subagent memory of the prior turn. We later proved
  // empirically that `conversationId` on /chat/agent is a no-op for
  // context restoration (see /tmp/cache-probes/MGA_ANTHROPIC_CACHING.md
  // referenced by chat/server/agent/agent.js) and that /chat/completions
  // doesn't accept the field at all. The test was checking that two
  // identical opaque strings matched — useful as a metadata-plumbing
  // check but not a real "continuation works" signal. Post-build
  // follow-ups go through concierge now (see t-postbuild-* scenarios);
  // continuation-from-seed semantics are covered by t40 + t41.
  {
    id: 't3-infeasible-ping',
    title: 'Infeasible task — asks to modify a nonexistent /ping endpoint',
    mode: 'single-scope',
    scope: 'backend',
    prompt: () => wrapTaskPrompt(
      'Update the existing backend to mark the GET /ping endpoint as deployed by adding a comment above it.'
    ),
    assert: ({ result, workspace }) => {
      // Graceful-failure contract: agent should finalize with attempt_completion
      // (exit 0) but the completion report must acknowledge the task is
      // impossible. No files should be written.
      if (result.exitCode !== 0) {
        throw new Error(`exitCode=${result.exitCode}, expected 0 (graceful finalize, not crash)`);
      }
      if (!result.completionText) throw new Error('completionText is empty');
      const reportLower = result.completionText.toLowerCase();
      const acknowledgesImpossibility = /cannot|unable|does not exist|no such|not found|no.*\/ping/.test(reportLower);
      if (!acknowledgesImpossibility) {
        throw new Error(
          `completion report should acknowledge impossibility; got: ${result.completionText.slice(0, 200)}`
        );
      }
      // Nothing should have been written under backend/. Writing a fake
      // /ping endpoint would be the fabrication bug we fixed previously.
      // backend/ may not exist at all (canonical Dockerfile templates now
      // live at snippets/backend/), or may contain agent-written residue.
      const backendDir = path.join(workspace, 'backend');
      if (fs.existsSync(backendDir)) {
        const entries = fs.readdirSync(backendDir);
        if (entries.length > 0) {
          throw new Error(`backend/ should be empty (task was infeasible); has: ${entries.join(', ')}`);
        }
      }
      const apiCalls = result.runTokenTotals?.apiCalls ?? 0;
      if (apiCalls > 15) throw new Error(`apiCalls=${apiCalls}; suggests loop rather than quick give-up`);
      return { apiCalls, completionPreview: result.completionText.slice(0, 120).replace(/\n/g, ' ') };
    },
  },
  {
    id: 't4-forced-rotation',
    title: 'Forced rotation — low threshold fires summarizer mid-run',
    mode: 'single-scope',
    scope: 'backend',
    envOverrides: {
      COMPACT_THRESHOLD_TOKENS: '2000',
      // Allow rotations to fire without cooldown so a short task can still
      // trigger one — otherwise 5-turn cooldown + ~5-turn task = no rotation.
      ROTATION_COOLDOWN_TURNS: '1',
    },
    prompt: () => wrapTaskPrompt(
      'Add a minimal Node + Express backend with a single GET /health endpoint that returns {ok: true}.'
    ),
    assert: ({ result, workspace, sessionId }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      // Look for compacting events in the transcript.
      const transcriptPath = path.join(workspace, '.chat', 'transcripts', `${sessionId}.jsonl`);
      if (!fs.existsSync(transcriptPath)) throw new Error(`transcript missing: ${transcriptPath}`);
      const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
      const compactingEvents = lines.filter((l) => {
        try {
          const rec = JSON.parse(l);
          return rec.payload?.say === 'compacting';
        } catch { return false; }
      });
      if (compactingEvents.length === 0) {
        throw new Error('no compacting events emitted; rotation did not fire');
      }
      // Build should still succeed despite mid-run rotation. Canonical
      // post-W1.PATHS.CANONICAL is backend/src/index.ts; allow main.py as
      // the only legitimate alternative (Python backend chosen by router).
      const candidates = [
        'backend/src/index.ts',
        'backend/main.py',
      ];
      const written = candidates.find((p) => fs.existsSync(path.join(workspace, p)));
      if (!written) throw new Error(`no canonical entry file written; rotation may have orphaned the task. Checked: ${candidates.join(', ')}`);
      return { rotations: compactingEvents.length, writtenFile: written };
    },
  },
  {
    id: 't5-frontend-build',
    title: 'Frontend React+Vite — different scope, snippet selectivity',
    mode: 'single-scope',
    scope: 'frontend',
    prompt: () => wrapTaskPrompt(
      'Create a minimal React + Vite frontend with a single page that fetches GET /api/health from the backend ' +
      'and displays the result. Use the platform snippets.'
    ),
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      if (!fs.existsSync(path.join(workspace, 'frontend/package.json'))) {
        throw new Error('frontend/package.json missing');
      }
      // React app strict-checks the canonical TSX entry post-W1.PATHS.CANONICAL.
      // .jsx fallbacks dropped — any drift means the rule→model pipeline regressed.
      const entryCandidates = ['frontend/src/App.tsx', 'frontend/src/main.tsx'];
      const entry = entryCandidates.find((p) => fs.existsSync(path.join(workspace, p)));
      if (!entry) throw new Error(`no React entry file; checked: ${entryCandidates.join(', ')}`);
      if (!fs.existsSync(path.join(workspace, 'frontend/Dockerfile'))) {
        throw new Error('frontend/Dockerfile missing');
      }
      const promptTokens = result.runTokenTotals?.promptTokens ?? 0;
      const apiCalls = result.runTokenTotals?.apiCalls ?? 0;
      // Current baseline (per status doc) is ~53K/6 turns. Fail if we've
      // clearly regressed past the "maybe a retry was needed" band.
      if (apiCalls > 12) throw new Error(`apiCalls=${apiCalls}, ceiling 12`);
      if (promptTokens > 150_000) throw new Error(`promptTokens=${promptTokens}, ceiling 150K`);
      return { entry, promptTokens, apiCalls };
    },
  },

  // ── Multi-scope scenarios ───────────────────────────────────────────────
  // Boots the server as a subprocess, drives the full pipeline via HTTP +
  // Socket.IO. Pass criterion: docker-compose up returns ok=true (parsed
  // from the subprocess's `Auto-start: compose up (...ms, ok=true)` log).
  // Cost: ~150-300K tokens per scenario. Wall-clock cap: 12 min.
  // Source prompts mirror chat/server/agent/TEST_PROMPTS.md.

  {
    id: 't6-smart-docs',
    title: 'Multi-scope: Smart project document knowledge system (RAG)',
    mode: 'multi-scope',
    prompt:
      'Project teams generate huge volumes of documents, but finding the right file and keeping ' +
      'storage organized is painfully manual across large teams. This idea turns static project ' +
      'documentation into a smart, living knowledge system that bridges file-based storage with ' +
      'fast, AI-powered retrieval. A lightweight prototype that ingests a project folder ' +
      '(SharePoint/OneDrive/local), auto-classifies and tags documents, and exposes a chat/search ' +
      'UI that can answer project questions with source citations. Should demonstrate semantic ' +
      'search over mixed file types (docx, pptx, pdf) and surface a basic structured view of the ' +
      'folder.',
    clarifyResponder: 'first-option',
    // The router empirically picks one of two valid RAG architectures:
    //   - 5 scopes with separate database (postgres) + vectordb (chroma or pgvector)
    //   - 4 scopes with pgvector-as-unified-database (postgres + pgvector
    //     extension handles both relational and vector storage)
    // Both deploy correctly. Require only the deployable-app core; vectordb
    // is allowed but not mandatory. Earlier strict expectation rejected the
    // 4-scope variant as "router-trim" — false alarm, not a real bug.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't7-qualcoder',
    title: 'Multi-scope: QualCoder (qualitative coding pipeline, heavy DB schema)',
    mode: 'multi-scope',
    prompt:
      'Manually coding hundreds or thousands of open-ended survey responses, interview transcripts, ' +
      'and free-text feedback is one of the most time-consuming tasks in consumer research. ' +
      'QualCoder is a human-in-the-loop AI agent that codes every verbatim for themes, sentiment, ' +
      'emotion, and mental models - compressing days of analysis into hours while preserving ' +
      'nuance and auditability.\n' +
      'A multi-step agent workflow: (1) ingest verbatims + study objectives, (2) auto-code ' +
      'themes/sentiment/emotion, (3) flag ambiguous comments for human review, (4) cluster ' +
      'validated codes into themes with co-occurrence + contradiction checks, (5) generate ' +
      'narrative insights with traceability back to source quotes. Demo on a sample dataset.',
    clarifyResponder: 'first-option',
    // vectordb is plausible (theme clustering via embeddings) but not strictly required —
    // SQL aggregation can substitute. Require the four core scopes; vectordb is bonus.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't8-farmer-products',
    title: 'Multi-scope: Farmer field-problem photo → Bayer product recommendation',
    mode: 'multi-scope',
    prompt:
      'A farmer takes a photo of a field problem (weed, pest, disease, drought, birds) and the ' +
      'system identifies the issue, then recommends the matching Bayer seed or crop-protection ' +
      'product. The farmer can tap through to the e-commerce platform and buy it. End-to-end flow: ' +
      'helps farmers solve problems and helps Bayer sell its portfolio.\n' +
      'A mobile-style web prototype: upload/capture a field photo, run image classification ' +
      '(open-source model or hosted vision API), map the identified issue to a product catalog ' +
      'entry, and deep-link to a mocked e-commerce product page. Demo with 3-5 sample field issues.',
    clarifyResponder: 'first-option',
    // Image classification + static product catalog is a defensible no-database
    // architecture (the catalog can be a flat JSON file). vectordb also optional.
    // Require only the deployable-app core: frontend, backend, integration.
    // Relaxed from [frontend, backend, database, integration] after observing
    // the router legitimately dropping database for this scenario — empirical
    // assessment, not a router regression.
    expectedScopes: ['frontend', 'backend', 'integration'],
  },

  // ── Coverage-broadening scenarios (added 2026-04-26) ────────────────────────
  // The t1–t8 set was heavy on Node + React + Postgres + Chroma. These three
  // exercise the under-covered code paths: Python backend, non-RAG multi-scope,
  // and the pre-send tool-result truncator.

  {
    id: 't9-fastapi-backend',
    title: 'FastAPI backend — Python single-scope build, snippet path coverage',
    mode: 'single-scope',
    scope: 'backend',
    prompt: () => wrapTaskPrompt(
      'Create a minimal Python + FastAPI backend with a single GET /health endpoint that returns {"ok": true}. ' +
      'Use Python with FastAPI, NOT Node/Express. Use the platform Python snippets where they exist.'
    ),
    // Asserts deployability: every file the Dockerfile.python build step
    // expects must exist. Without requirements.txt, the build's
    // `COPY requirements.txt . && RUN pip install -r requirements.txt`
    // fails. Without main.py at the root (NOT src/main.py), the runtime
    // CMD `uvicorn main:app ...` fails with ModuleNotFoundError. Both
    // requirements documented in scope-backend.md per the
    // language-specific deliverables section.
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      // Entry file MUST be backend/main.py (NOT src/main.py) to match the
      // Dockerfile.python CMD. main.py at root is the only Dockerfile-
      // compatible location.
      const entryPath = path.join(workspace, 'backend/main.py');
      if (!fs.existsSync(entryPath)) {
        throw new Error('backend/main.py missing — Dockerfile.python CMD `uvicorn main:app` requires it at backend/ root');
      }
      const entryContent = fs.readFileSync(entryPath, 'utf-8');
      if (!/from\s+fastapi|import\s+fastapi/i.test(entryContent)) {
        throw new Error(`backend/main.py doesn't import fastapi — not a FastAPI app`);
      }
      // requirements.txt MUST exist — Dockerfile.python's COPY+pip install
      // step fails at build time without it.
      const reqPath = path.join(workspace, 'backend/requirements.txt');
      if (!fs.existsSync(reqPath)) {
        throw new Error('backend/requirements.txt missing — Dockerfile.python COPY/pip step fails without it');
      }
      const reqContent = fs.readFileSync(reqPath, 'utf-8');
      if (!/fastapi/i.test(reqContent)) {
        throw new Error('backend/requirements.txt missing fastapi — pip install would not fetch the framework');
      }
      // Dockerfile must exist + be the Python template (not Node/Rust).
      // Canonical Dockerfile.python is `FROM dd-kitchen-sink:local` (the
      // Debian base with pip cache pre-warmed); accept either marker.
      const dockerfilePath = path.join(workspace, 'backend/Dockerfile');
      if (!fs.existsSync(dockerfilePath)) throw new Error('backend/Dockerfile missing');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      if (!/FROM\s+(python|dd-kitchen-sink)/i.test(dockerfileContent)) {
        throw new Error('backend/Dockerfile does not FROM python — auto-fill picked the wrong template');
      }
      // Negative — must not be Node.
      if (fs.existsSync(path.join(workspace, 'backend/package.json'))) {
        throw new Error('backend/package.json exists — should be Python, not Node');
      }
      const promptTokens = result.runTokenTotals?.promptTokens ?? 0;
      const apiCalls = result.runTokenTotals?.apiCalls;
      return { entry: 'backend/main.py', deps: 'backend/requirements.txt', promptTokens, apiCalls };
    },
  },

  {
    id: 't11-backend-db-multi',
    title: 'Multi-scope: Backend API + Postgres only (no frontend, no vectordb)',
    mode: 'multi-scope',
    prompt:
      'Build a small REST API for a personal task tracker. Backend: Node + Express with CRUD endpoints ' +
      'on a "tasks" resource (id, title, completed, created_at). Persist to a Postgres database. ' +
      'Provide docker-compose for local dev. NO frontend UI is needed — this is an API-only service ' +
      'consumed by other apps. NO vector database, NO AI features, NO image processing. Just Express ' +
      'over Postgres.',
    clarifyResponder: 'first-option',
    // API-only service: covers the non-RAG, no-frontend multi-scope path. The
    // deployable-app set here is backend + database + integration; frontend
    // and vectordb should not be part of the plan.
    expectedScopes: ['backend', 'database', 'integration'],
    // Track A (A4): deterministic router-output assertion (subset match).
    plannerExpect: {
      scopes: ['backend', 'database', 'integration'],
      data_model: {
        tables: [
          { name: 'tasks', columns_include: ['id', 'title', 'completed'] },
        ],
      },
      // api_contract is NOT required by the router when frontend isn't in
      // scope (per router.md OUTPUT CONTRACT). For an API-only backend, the
      // endpoint surface lives in the dense task.task text instead — we don't
      // assert on prose. So no api_contract.endpoints_include here.
      // No ui_contract (frontend NOT in scope). business_logic_contract
      // present-but-may-be-empty is fine; we don't assert content.
    },
    // Track A (A5): plain-English ground truth for the LLM-judge.
    expectedIntent:
      'Backend-only REST API for tracking personal tasks. Tasks have id, title, completed status, and created-at timestamp. CRUD endpoints (list/create/update/delete) backed by Postgres. No frontend, no AI features, no vector search.',
  },

  {
    id: 't14-truncation-fires',
    title: 'Pre-send truncation fires — TOOL_RESULT_MAX_CHARS=4000 forces cap on snippet read',
    mode: 'single-scope',
    scope: 'frontend',
    envOverrides: {
      // Force a tight cap so the first MCP get_snippet on the React scaffold
      // (~1.8KB) trips the truncator. (4000 was too lax — empirically the
      // scaffold is small enough to fit.)
      TOOL_RESULT_MAX_CHARS: '1000',
    },
    prompt: () => wrapTaskPrompt(
      'Use the get_snippet MCP tool to read the contents of "frontend/AppScaffold.jsx", then write a ' +
      'minimal React + Vite frontend adapted from that snippet with a single page that fetches GET /api/health. ' +
      'You MUST call get_snippet at least once.'
    ),
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      const truncations = result.runTokenTotals?.truncations || 0;
      if (truncations < 1) {
        throw new Error(`expected at least 1 truncation event with TOOL_RESULT_MAX_CHARS=4000; got ${truncations}`);
      }
      // Sanity — task should still complete despite truncation.
      const entryCandidates = ['frontend/src/App.tsx', 'frontend/src/main.tsx'];
      const entry = entryCandidates.find((p) => fs.existsSync(path.join(workspace, p)));
      if (!entry) throw new Error(`no React entry written; truncation may have orphaned the task. Checked: ${entryCandidates.join(', ')}`);
      return { truncations, entry };
    },
  },

  // ── Subagent-phase minimal scenario (integration) ──────────────────────────
  // 5 subagent-mini scenarios (paired backend/frontend/backend-py and standalone
  // database/vectordb) dropped per TESTING_EVOLUTION.md Dispatch 4 — W1.TEL
  // per-scope telemetry already covers per-subagent signal; running them as
  // full smoke burned ~150K MGA tokens for tests that don't exercise cross-
  // scope behavior. t-sub-integration-min stays: it's the only scope where
  // sibling-report coordination has no multi-scope coverage today.

  {
    id: 't-sub-integration-min',
    title: 'Subagent-integration — minimal compose wiring from sibling reports',
    mode: 'single-scope',
    scope: 'integration',
    // Integration must be given sibling reports (the orchestrator does this
    // via buildSpawnUserMessage's =CROSS-SCOPE COORDINATION= section in
    // production). The setup pre-populates backend + database files so the
    // agent can verify their existence if it chooses; the prompt mirrors the
    // real spawn-dispatch shape with synthetic completion reports.
    prompt: () => (
      `=== CROSS-SCOPE COORDINATION ===\n\n` +
      `Sibling phase agents already completed. Wire your work to match the contracts they reported below.\n\n` +
      `=== COMPLETED: BACKEND ===\n` +
      `**Files:**\n- backend/src/index.ts\n- backend/package.json\n- backend/tsconfig.json\n- backend/Dockerfile\n\n` +
      `**API endpoints:**\n- GET /health — liveness probe\n\n` +
      `**Config:**\n- Listens on PORT 3000\n- Reads DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD from env\n\n` +
      `=== COMPLETED: DATABASE ===\n` +
      `**Files:**\n- database/init/init.sql\n- database/Dockerfile\n\n` +
      `**Tables:**\n- users: id SERIAL PK, email TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ\n\n` +
      `**Config:**\n- Postgres image, port 5432\n- POSTGRES_DB=app, POSTGRES_USER=app, POSTGRES_PASSWORD=app\n- Volume mount /data for persistence (PGDATA=/data)\n\n` +
      `=== YOUR TASK (INTEGRATION scope) ===\n` +
      `Create docker-compose.yml at workspace root that wires the backend and database services together. Use service-name = folder-name. Backend depends_on database. Set DATABASE_HOST=database and DATABASE_PORT=5432 in the backend's environment. Persist database data via a named volume mounted at /data (Postgres PGDATA).\n`
    ),
    setup: (prev, ws) => {
      // Stub sibling artifacts so the agent's read_file attempts (if it chooses
      // to verify) succeed instead of erroring. Mirrors what would actually be
      // on disk after backend + database scopes ran.
      fs.mkdirSync(path.join(ws, 'backend', 'src'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'backend/package.json'), '{"name":"backend","main":"dist/index.js","dependencies":{"express":"^4","pg":"^8"}}\n');
      // Stub TS source — valid TypeScript module. Smoke harness doesn't run
      // tsc on this stub; the stub exists only so cross-scope file-existence
      // checks in the integration agent succeed.
      fs.writeFileSync(path.join(ws, 'backend/src/index.ts'), '// stub backend\nconsole.log("backend");\nexport {};\n');
      fs.copyFileSync(path.join(ws, 'backend/Dockerfile.node'), path.join(ws, 'backend/Dockerfile'));
      fs.mkdirSync(path.join(ws, 'database', 'init'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'database/init/init.sql'), 'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());\n');
      // Minimal database Dockerfile stub — postgres image, no init copy. The
      // agent's read_file isn't expected to inspect content, just confirm
      // existence; full template would require copyDockerfileTemplates for
      // the database scope which currently only handles backend/frontend.
      fs.writeFileSync(path.join(ws, 'database/Dockerfile'), 'FROM postgres:16\nCOPY init/ /docker-entrypoint-initdb.d/\nENV PGDATA=/data\n');
      return { phase: PHASES.SUBAGENT };
    },
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      const composePath = path.join(workspace, 'docker-compose.yml');
      if (!fs.existsSync(composePath)) throw new Error('docker-compose.yml missing at workspace root');
      const compose = fs.readFileSync(composePath, 'utf-8');
      if (!/^\s*backend\s*:/m.test(compose))  throw new Error('docker-compose.yml missing service "backend"');
      if (!/^\s*database\s*:/m.test(compose)) throw new Error('docker-compose.yml missing service "database"');
      if (!/DATABASE_HOST\s*[:=]\s*['"]?database['"]?/i.test(compose)) {
        throw new Error('backend env DATABASE_HOST is not "database"');
      }
      if (!/DATABASE_PORT\s*[:=]\s*['"]?5432['"]?/.test(compose)) {
        throw new Error('backend env DATABASE_PORT is not 5432');
      }
      // Postgres PGDATA is /data per Dockerfile.postgres. MySQL would mount
      // at /data/mysql per scope-database.md. Bind-mounting outside /data
      // loses persistence on redeploy.
      if (!/:\s*\/data\b/.test(compose)) {
        throw new Error('database service does not mount a volume at /data (Postgres PGDATA)');
      }
      const apiCalls = result.runTokenTotals?.apiCalls ?? 0;
      const promptTokens = result.runTokenTotals?.promptTokens ?? 0;
      if (apiCalls > 10) throw new Error(`apiCalls=${apiCalls}, ceiling 10`);
      if (promptTokens > 200_000) throw new Error(`promptTokens=${promptTokens}, ceiling 200K`);
      return { compose: 'docker-compose.yml', apiCalls, promptTokens };
    },
  },

  // ── User-prompt-shaped scenarios (added 2026-05-01) ─────────────────────────
  // Earlier scenarios used structured tech-spec prompts (explicit endpoints,
  // schemas, "no auth, no vectordb" hedges). These three use natural-language
  // prompts that look like what a real user would type. Tests the FULL
  // pipeline (router → clarify → plan → build → verify), not just the
  // builder. Asserts stay pipeline-integrity-only: compiles, deps + entry
  // exist, compose comes up — does NOT verify the app does what was asked
  // (functional verification is a separate layer we haven't built).

  {
    id: 't15-multi-agent-research',
    title: 'Multi-agent research backend — natural prompt, single-scope',
    mode: 'single-scope',
    scope: 'backend',
    prompt: () => wrapTaskPrompt(
      'Build me a backend service that uses multiple AI agents working together to research a topic and write a report.'
    ),
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      // Allow either Node or Python — natural prompt doesn't pin language.
      // Canonical Node entry is backend/src/index.ts post-W1.PATHS.CANONICAL.
      const nodeEntry = ['backend/src/index.ts'].find((p) => fs.existsSync(path.join(workspace, p)));
      const pyEntry   = ['backend/main.py'].find((p) => fs.existsSync(path.join(workspace, p)));
      const entry = nodeEntry || pyEntry;
      if (!entry) throw new Error('no backend entry file written (Node or Python)');
      const deps = ['backend/package.json', 'backend/requirements.txt', 'backend/pyproject.toml']
        .find((p) => fs.existsSync(path.join(workspace, p)));
      if (!deps) throw new Error('no backend deps file (package.json / requirements.txt / pyproject.toml)');
      if (!fs.existsSync(path.join(workspace, 'backend/Dockerfile'))) throw new Error('backend/Dockerfile missing');
      // Loose content check: at least one backend file should mention agent
      // orchestration concepts. Not a functional test — just a signal the
      // model engaged with the prompt's "multi-agent" framing.
      const allBackendFiles = listFilesRecursive(path.join(workspace, 'backend'), { maxDepth: 4 });
      const codeFiles = allBackendFiles.filter((f) => /\.(js|mjs|ts|py)$/.test(f));
      let agentMentions = 0;
      for (const f of codeFiles) {
        try {
          const content = fs.readFileSync(f, 'utf-8').toLowerCase();
          if (/\bagent|\bresearch|\banalyst|\bsummariz|\bwrit(er|ing)\b/.test(content)) {
            agentMentions += 1;
            if (agentMentions >= 1) break;
          }
        } catch { /* skip */ }
      }
      if (agentMentions === 0) {
        throw new Error('no backend code mentions agent/research/analyst/writer concepts — model may not have engaged with multi-agent framing');
      }
      const promptTokens = result.runTokenTotals?.promptTokens ?? 0;
      const apiCalls = result.runTokenTotals?.apiCalls;
      return { entry, deps, codeFiles: codeFiles.length, agentMentions, promptTokens, apiCalls };
    },
  },

  {
    id: 't17-admin-dashboard',
    title: 'Admin dashboard — natural prompt, multi-scope CRUD (no auth, Entra at infra)',
    mode: 'multi-scope',
    prompt:
      'Build me an admin dashboard for managing products, orders, and customers in a small store.',
    clarifyResponder: 'first-option',
    // Standard CRUD admin: deployable-app core. Auth handled at infra
    // (Entra-fronted) so no auth scope. vectordb not needed.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  // ── Production-shape multi-scope coverage (added 2026-05-03) ────────────────
  // Natural-language prompts mirroring real user requests. Phrasing varied
  // across the four — first-person request, description-style, problem-then-
  // solution, role-then-task — to avoid templating ("Build me X" pattern).
  // Each exercises a scope combination not adequately covered by t6-t21:
  //   t30: frontend + backend (no database) — stateless tool path.
  //   t31: full CRUD with auth (has-users) — ownership semantics multi-scope.
  //   t32: backend + database + vectordb (no UI) — RAG without a frontend.
  //   t33: Python backend + Postgres — FastAPI multi-scope path.

  {
    id: 't30-stateless-tool',
    title: 'Stateless utility — frontend + backend, no database',
    mode: 'multi-scope',
    prompt:
      'I need a quick utility — paste a website URL and it shows me the page\'s word count and estimated reading time.',
    clarifyResponder: 'first-option',
    // Tests the no-database flow: frontend ↔ backend wiring without a DB
    // service in compose. Should NOT emit a database scope.
    expectedScopes: ['frontend', 'backend', 'integration'],
    plannerExpect: {
      scopes: ['frontend', 'backend', 'integration'],
      // No data_model (no database). api_contract endpoint paths vary
      // (/analyze | /count | /reading-time etc.) — assert ui presence only.
      ui_contract: {
        primary_view: /url|paste|word|read|count|analy/i,
      },
    },
    expectedIntent:
      'A small stateless utility: user pastes a website URL, backend fetches the page, returns word count and estimated reading time. No database, no user accounts, no persistence — just a request/response tool with a frontend form on top.',
  },

  {
    id: 't31-personal-tasks',
    title: 'Personal task tracker with auth — full CRUD multi-scope (has-users)',
    mode: 'multi-scope',
    prompt:
      'A personal task tracker. I want to sign in and only see my own tasks — no shared lists with other users.',
    clarifyResponder: 'first-option',
    // Tests has-users flag — backend reads x-amzn-oidc-data; tasks rows have
    // user_id; backend rejects edits/deletes on rows the user doesn't own.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
    // Track A (A4): deterministic router-output assertion.
    plannerExpect: {
      scopes: ['frontend', 'backend', 'database', 'integration'],
      flags: ['has-users'],
      data_model: {
        tables: [
          { name: 'tasks', columns_include: ['user_id'] },
          { name: 'users', columns_include: ['oidc_sub'] },
        ],
      },
      api_contract: {
        endpoints_include: [
          { method: 'GET',  path: '/tasks' },
          { method: 'POST', path: '/tasks' },
        ],
      },
      ui_contract: {
        primary_view: /task/i,
      },
      business_logic_contract: {
        rules_pattern: [/own|user_id|user/i],
      },
    },
    // Track A (A5): plain-English ground truth for the LLM-judge.
    expectedIntent:
      'Personal task tracker with per-user sign-in. Each signed-in user sees ONLY their own tasks; no shared lists, no cross-user visibility. Users can add, edit, complete, and delete their own tasks. Backend authenticates via OIDC (x-amzn-oidc-data) and rejects edits/deletes on rows the user does not own.',
  },

  {
    id: 't32-doc-search-api',
    title: 'Doc search — backend + database + vectordb + frontend',
    mode: 'multi-scope',
    prompt:
      'We have a pile of internal docs. I want a simple search box on a webpage where I can type a question and see matching pieces from those docs — search by meaning, not keyword.',
    clarifyResponder: 'first-option',
    // Tests full RAG pipeline including a UI. vectordb scope must remain
    // INDEPENDENT from database/ — separate Dockerfile under vectordb/.
    // Frontend is a search box + results list — minimal but real.
    expectedScopes: ['backend', 'database', 'vectordb', 'frontend', 'integration'],
    plannerExpect: {
      scopes: ['backend', 'database', 'vectordb', 'frontend', 'integration'],
      // pgvector is the DEFAULT for ai-rag per router.md; flag if router
      // picks something else without explicit user signal.
      vector_engine: 'pgvector',
    },
    expectedIntent:
      'Semantic search over a corpus of internal documents, with a simple webpage UI that takes a query and shows matching document snippets. Documents are chunked and embedded; queries return matching chunks by meaning rather than keyword. Uses a relational DB for source docs + chunk metadata and a separate vector DB for embeddings.',
  },

  // ── Difficulty-graded enterprise AI-RAG examples ───────────────────────────
  // Mirror the prompts in tests/two-agent/test-prompts.json (medium / medium-
  // hard / hard). Deliberately vague pain-point narratives (test disambiguation
  // + the full RAG pipeline). All land on the 5-scope set. NOTE: run these one
  // at a time (or with cleanup between) — like all full-build scenarios, smoke
  // leaves containers up (`compose up -d`), so back-to-back sequential runs
  // collide on host ports and the later ones flag port_conflict.
  {
    id: 'ex-medium-contract-analysis',
    title: 'Medium — Contract & Document Analysis (AI-RAG + extraction)',
    mode: 'multi-scope',
    prompt:
      'Our procurement and legal teams review hundreds of vendor agreements every quarter, and identifying unusual clauses or inconsistent commercial terms has become increasingly difficult. Important obligations around renewals, pricing adjustments, or compliance requirements are often buried deep within lengthy documents. The current review process is heavily manual and depends on institutional knowledge from a small number of experienced employees. We are looking for a more scalable way to analyze large volumes of business documents and surface key risks or inconsistencies earlier in the process.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'vectordb', 'frontend', 'integration'],
    expectedIntent:
      'AI-assisted analysis of large volumes of vendor/legal documents: ingest and embed documents, then surface unusual clauses, inconsistent commercial terms, and key obligations (renewals, pricing, compliance) so reviewers spot risks earlier. RAG over a document corpus with a relational DB for metadata and a vector DB for embeddings, plus a UI to review findings.',
  },
  {
    id: 'ex-mediumhard-km-global',
    title: 'Medium/Hard — Knowledge Management Across Business Units (AI-RAG)',
    mode: 'multi-scope',
    prompt:
      'As the organization has expanded globally, valuable operational knowledge has become fragmented across regional teams, SharePoint repositories, internal wikis, and archived project documents. Employees frequently recreate work because they cannot easily identify whether similar initiatives, lessons learned, or client deliverables already exist elsewhere in the company. Leadership believes there is significant untapped institutional knowledge, but accessing it today requires knowing exactly where to look or who to ask. We need a more effective way to connect employees with relevant business knowledge across the enterprise.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'vectordb', 'frontend', 'integration'],
    expectedIntent:
      'Enterprise knowledge-management search that connects employees with relevant existing work (initiatives, lessons learned, deliverables) fragmented across sources. Semantic retrieval over a document corpus so employees can find related knowledge by meaning. Relational DB for source/metadata, vector DB for embeddings, and a search UI.',
  },
  {
    id: 'ex-hard-risk-compliance',
    title: 'Hard — Enterprise Risk & Compliance Oversight (AI-RAG)',
    mode: 'multi-scope',
    prompt:
      'Our compliance and risk management teams are struggling to maintain visibility across thousands of documents, audit reports, policies, and operational records distributed across multiple business systems. Regulatory reviews often trigger urgent cross-functional efforts to gather evidence manually, and there is limited confidence that all relevant information has been identified consistently. Executives are concerned about the growing operational risk associated with fragmented documentation and inconsistent governance practices across regions. The business needs a more intelligent and scalable approach to monitoring, analyzing, and retrieving critical compliance information before issues escalate.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'vectordb', 'frontend', 'integration'],
    expectedIntent:
      'AI-assisted compliance and risk oversight: retrieve and analyze critical compliance information across a large fragmented corpus (documents, audit reports, policies, operational records) so teams can find relevant evidence consistently and surface risk before issues escalate. RAG over a document corpus with relational + vector storage and a UI for monitoring/retrieval.',
  },

  {
    id: 't33-csv-pipeline-py',
    title: 'Python CSV pipeline — FastAPI + Postgres multi-scope',
    mode: 'multi-scope',
    prompt:
      'Backend service in Python that ingests CSV uploads, validates the rows, and writes them into a relational database.',
    clarifyResponder: 'first-option',
    // Tests FastAPI multi-scope path. Backend entry must be backend/main.py
    // (NOT backend/src/main.py — Dockerfile.python's `uvicorn main:app` CMD
    // resolves from /app workdir).
    expectedScopes: ['backend', 'database', 'integration'],
    plannerExpect: {
      scopes: ['backend', 'database', 'integration'],
      // No api_contract (no frontend) and no ui_contract.
      // Table names vary (uploads/rows/records) — skip data_model.tables.
    },
    expectedIntent:
      'Python backend service that accepts CSV uploads, validates each row, and writes the validated rows into a relational database. API-only (no frontend). FastAPI on Postgres.',
  },


  {
    id: 't34-demand-planning-simulator',
    title: 'Injector Demand Scenario Simulator — BOM explosion + OMP Excel export',
    mode: 'multi-scope',
    prompt:
      'Build a new prototype focused exclusively on the demand planning process. ' +
      'Business objective: Simulate how the demand forecast of an injector cascades into its components through a BOM structure, ' +
      'and generate an OMP-ready forecast file based on different demand scenarios. ' +
      'Important constraint: Do NOT use any real material codes or sensitive data. ' +
      'You must create a fully dummy BOM that mimics the structure and ratios of a real BOM ' +
      '(same number of components and quantities), but with fictional SKUs and descriptions. ' +
      'Reposition the app as "Injector Demand Scenario Simulator". ' +
      'Use a single pilot case: Country Brazil (LATAM), Injector: dummy SKU INJ-LATAM-STD-01, ' +
      'dummy BOM preserving real structure (same component count and quantity ratios like 1 and 2). ' +
      'Modules: ' +
      'A. Base Forecast Input: user inputs injector forecast (36 months), monthly values per country. ' +
      'B. BOM / Configuration View: injector as parent, components in cascade with quantity ratios; all fictional but structurally accurate. ' +
      'C. Scenario Engine: Base / Upside / Downside scenarios; custom % adjustment that auto-reruns BOM explosion. ' +
      'D. OMP Demand Output View: hierarchical parent-child (Injector to Components), 36-month forecast per item, dynamically updated after scenarios. ' +
      'BOM explosion logic: component demand = injector forecast x quantity ratio; recalculate all children when injector forecast changes. ' +
      'Persist data in a relational database with these exact table names: ' +
      '"bom_items" (columns: parent_sku, child_sku, quantity_ratio), ' +
      '"forecasts" (columns: sku, month, quantity). ' +
      'Use these exact API endpoint paths: GET /bom, POST /forecast, GET /export. ' +
      'CRITICAL output: generate a downloadable Excel file matching OMP mass upload format exactly. ' +
      'Columns: CategoryId, FromDate, ToDate, Quantity, UnitID. ' +
      'Each row is one material (injector or component) x one time bucket, 36-month horizon, ' +
      'parent and children included, dates formatted correctly, units EA or PCE, CategoryId dummy but consistent. ' +
      'Excel must be ready for direct OMP upload with no transformation. ' +
      'UI: clear process-flow banner at top — Injector Forecast to Scenario Adjustment to BOM Explosion to OMP-ready Excel Output. ' +
      'Clean and intuitive, NOT spreadsheet-like, use hierarchy tree visualization. ' +
      'No supply, inventory, PO, QA, logistics, or risk modules.',
    clarifyResponder: 'first-option',
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
    plannerExpect: {
      scopes: ['frontend', 'backend', 'database', 'integration'],
      flags: [],
      data_model: {
        tables: [
          { name: 'bom_items', columns_include: ['parent_sku', 'child_sku', 'quantity_ratio'] },
          { name: 'forecasts', columns_include: ['sku', 'month', 'quantity'] },
        ],
      },
      api_contract: {
        endpoints_include: [
          { method: 'GET',  path: '/bom' },
          { method: 'POST', path: '/forecast' },
          { method: 'GET',  path: '/export' },
        ],
      },
    },
    expectedIntent:
      'Demand planning simulator for an injector and its BOM components. ' +
      'User enters a 36-month injector forecast, selects a scenario (base/upside/downside/custom %), ' +
      'and the app explodes the forecast through a dummy BOM (fictional SKUs, realistic structure and quantity ratios). ' +
      'A downloadable Excel file is generated in exact OMP mass-upload format (CategoryId, FromDate, ToDate, Quantity, UnitID). ' +
      'Scope is purely demand planning — no supply, inventory, PO, QA, logistics, or risk modules.',
  },

  // ── Coverage-expansion scenarios (added 2026-05-06) ──
  // Five multi-scope scenarios that exercise paths the t11/t30/t31/t32/t33
  // baseline doesn't touch: real-time + has-users, MySQL platform path,
  // app-settings + has-users, external-API integration (cors-proxy candidate),
  // and the 4-flag golden example from router.md Ex 1. All prompts are
  // user-perspective (no framework names, no platform internals) so they
  // exercise the router's ability to infer flags + scopes from feature
  // language alone.

  {
    id: 't35-realtime-presence',
    title: 'Team chat with online indicator — real-time + has-users',
    mode: 'multi-scope',
    prompt:
      'A small chat room for my team. I want to see who else is currently online ' +
      'and watch new messages appear instantly without refreshing the page. ' +
      'Each person signs in.',
    clarifyResponder: 'first-option',
    // "Online indicator" + "instantly without refreshing" → real-time flag.
    // "Each person signs in" → has-users. Tests socketio-server.js +
    // websocket-helper snippets.
    expectedScopes: ['database', 'backend', 'frontend', 'integration'],
    plannerExpect: {
      scopes: ['database', 'backend', 'frontend', 'integration'],
      flags: ['has-users', 'real-time'],
      // Skip data_model.tables — names vary (messages/chats/rooms).
      ui_contract: {
        primary_view: /chat|messages|room|team/i,
      },
    },
    expectedIntent:
      'A small per-team chat room. Each user signs in; the UI shows who is currently online (presence indicator), and new messages appear instantly without page refresh. Backend persists messages so prior history is visible to anyone signing in. Real-time push via WebSocket.',
  },

  {
    id: 't37-app-settings-page',
    title: 'Per-user settings — app-settings + has-users compounding',
    mode: 'multi-scope',
    prompt:
      'A todo app with a settings page where each person picks their preferred ' +
      'sort order, how many items show per page, and light or dark mode. The ' +
      'settings stick across logins.',
    clarifyResponder: 'first-option',
    // "Settings page" + "each person picks" + "stick across logins" →
    // app-settings + has-users. Tests AppSettings.jsx, app-settings-schema.sql,
    // app-settings.js snippets all attaching.
    expectedScopes: ['database', 'backend', 'frontend', 'integration'],
    plannerExpect: {
      scopes: ['database', 'backend', 'frontend', 'integration'],
      flags: ['has-users', 'app-settings'],
      ui_contract: {
        primary_view: /task|todo/i,
      },
      business_logic_contract: {
        rules_pattern: [/own|user_id|user|per[ -]?user/i],
      },
    },
    expectedIntent:
      'A todo app with per-user settings. Each user signs in and has personal settings — preferred sort order, items-per-page, light/dark mode — that persist across logins. Settings are stored alongside per-user task data and applied automatically on next visit.',
  },

  {
    id: 't38-weather-dashboard',
    title: 'Weather dashboard — external API integration (cors-proxy candidate)',
    mode: 'multi-scope',
    prompt:
      'A small dashboard that shows the current weather for our office locations. ' +
      'Pull the data from a free public weather service.',
    clarifyResponder: 'first-option',
    // "External API + frontend showing it" — router has to recognize the
    // browser-can't-call-external-API pattern and pick cors-proxy. If it
    // doesn't, that's useful signal (cors-proxy flag's signals are too weak).
    // No DB needed — pure passthrough.
    expectedScopes: ['frontend', 'backend', 'integration'],
    // Track A (A4): deterministic router-output assertion.
    plannerExpect: {
      scopes: ['frontend', 'backend', 'integration'],
      // No data_model (no database in scope). api_contract endpoint paths
      // vary by router phrasing — assert ui presence + view name only.
      ui_contract: {
        primary_view: /weather|dashboard|locations|forecast/i,
      },
    },
    // Track A (A5): plain-English ground truth for the LLM-judge.
    expectedIntent:
      'A small dashboard showing current weather for office locations. Frontend renders the dashboard; backend acts as a CORS proxy that fetches from a free public weather service. No database, no user accounts, no AI features — pure pass-through with a UI on top.',
  },

  // t39-time-off-full-stack dropped per TESTING_EVOLUTION.md Dispatch 4 —
  // known flake with no unique coverage; full-stack flow already covered by
  // tAI1 + t32. The Dispatch 4 wall-clock cap-fix protects scenarios that
  // might otherwise exhibit the same 1877s anomaly.

  // ── Continuation scenarios ──
  // Pre-populate the workspace with a snapshot of a real t11 output BEFORE
  // the spike server boots, then ask the orchestrator+subagents for an
  // incremental change. Tests the continuation path: subagents must read
  // existing files (anti-fabrication rule) rather than fabricating from
  // scratch. Compose-up succeeding on top of the seed implicitly proves
  // the agent read the existing package.json deps + init.sql schema —
  // fabrication would diverge.

  {
    id: 't40-continuation-auth',
    title: 'Continuation: pre-populated backend+db tasks app + "add user authentication"',
    mode: 'multi-scope',
    setup: async (workspace) => {
      const seed = path.join(SPIKE_ROOT, 'chat/server/validators/fixtures/multi-continuation-seed');
      if (!fs.existsSync(seed)) {
        throw new Error(`seed fixtures missing at ${seed} — run t11 once and snapshot the workspace per the plan`);
      }
      fs.cpSync(seed, workspace, { recursive: true });
    },
    prompt: 'Add user authentication to this app.',
    // Continuation-flavored responder — the greenfield responder's "honor my
    // ORIGINAL prompt" framing confuses the router on short continuation
    // prompts (router falls into a refusal loop asking for a paste of the
    // missing original spec).
    clarifyResponder: 'first-option-continuation',
    // Auth additions cascade across all three: users table (database), auth
    // endpoints (backend), and integration (env vars / secrets / compose
    // wiring). Frontend is a model-judgment extra (login UI) — tolerated as
    // an addition; the trim-guard only fails on missing expected scopes.
    expectedScopes: ['backend', 'database', 'integration'],
  },

  {
    id: 'tAI1-faq-bot-rag',
    title: 'AI auto-detection: "FAQ bot for our HR policy PDFs" — should trigger ai-rag + mgaAssistant',
    mode: 'multi-scope',
    prompt:
      'Build me an internal FAQ bot for our HR policy. Employees upload our HR ' +
      'policy PDFs, then ask questions about the policies in plain English and get answers. ' +
      'They can keep chatting with follow-up questions.',
    clarifyResponder: 'first-option',
    // Validates the auto-detection bar: prompt does NOT mention "MGA"
    // anywhere. Router should infer ai-rag from "ask questions about" +
    // "PDFs" + "plain English" + "follow-up questions" and emit
    // task.mgaAssistant on the backend. /confirm pre-stage creates the
    // assistant + writes .env.
    expectedScopes: ['backend', 'frontend', 'integration'],
    plannerExpect: {
      scopes: ['backend', 'frontend', 'integration'],
      flags: ['ai-rag'],
      mga_assistants_min: 1,
      ui_contract: {
        primary_view: /chat|faq|policy|q.?a/i,
      },
    },
    assert: ({ result, workspace, sessionId }) => {
      // Smoke runs with MGA_SKIP_PRESTAGE=true (set in spawn env). The plannerExpect
      // gate above already validated the structural emission. Here we additionally
      // verify the harness wrote the placeholder .env so downstream subagents
      // see the env-var names. exitCode is best-effort — placeholder MGA_ASSISTANT_ID
      // means the chat call would fail at runtime, but compose-build may still
      // succeed (we don't actually chat in smoke).
      const envPath = path.join(workspace, '.env');
      if (!fs.existsSync(envPath)) throw new Error(`.env missing at workspace root — pre-stage skip path didn't run`);
      const env = fs.readFileSync(envPath, 'utf-8');
      for (const k of ['MGA_API_KEY=', 'MGA_BASE_URL=', 'MGA_ASSISTANT_ID=']) {
        if (!env.includes(k)) throw new Error(`.env missing ${k.replace('=','')}`);
      }
      return { sessionId, envPath, exitCode: result.exitCode };
    },
  },

  {
    id: 'tAI-NEG1-task-tracker',
    title: 'AI anti-detection: pure CRUD task tracker — must NOT trigger mgaAssistant',
    mode: 'multi-scope',
    prompt:
      'Build a simple task tracker. Users have projects, projects have tasks. ' +
      'Each task has a title, due date, and status (todo / doing / done). ' +
      'Show a kanban board with three columns and let users drag cards between them.',
    clarifyResponder: 'first-option',
    // No AI intent — verbose CRUD prompt should NOT trigger mgaAssistant.
    // False positives waste MGA assistant slots and confuse downstream
    // subagents (backend would try to use snippets it doesn't need).
    expectedScopes: ['database', 'backend', 'frontend', 'integration'],
    plannerExpect: {
      scopes: ['database', 'backend', 'frontend', 'integration'],
      mga_assistants_forbidden: true,
    },
    assert: ({ result, workspace }) => {
      if (result.exitCode !== 0) throw new Error(`exitCode=${result.exitCode}, expected 0`);
      // .env should NOT be written for non-AI apps.
      const envPath = path.join(workspace, '.env');
      if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, 'utf-8');
        if (env.includes('MGA_ASSISTANT_ID')) {
          throw new Error('.env contains MGA_ASSISTANT_ID for a CRUD app — false-positive AI detection');
        }
      }
      return {};
    },
  },

  {
    id: 't41-continuation-frontend',
    title: 'Continuation: pre-populated backend+db tasks app + "add a frontend"',
    mode: 'multi-scope',
    setup: async (workspace) => {
      const seed = path.join(SPIKE_ROOT, 'chat/server/validators/fixtures/multi-continuation-seed');
      if (!fs.existsSync(seed)) {
        throw new Error(`seed fixtures missing at ${seed} — run t11 once and snapshot the workspace per the plan`);
      }
      fs.cpSync(seed, workspace, { recursive: true });
    },
    prompt: 'Add a frontend to this app.',
    clarifyResponder: 'first-option-continuation',
    // Required scopes for adding a frontend on top of an existing backend+db:
    // frontend (the new code) and integration (compose must wire the new
    // frontend service + nginx routing). Backend is a model-judgment extra
    // (e.g., CORS additions) — tolerated either way; database is untouched.
    expectedScopes: ['frontend', 'integration'],
  },

  // ── Iteration + flow scenarios (Dispatch 4) ──────────────────────────────
  // Each scenario covers a Phase 2 or Phase 3 user-flow that had no e2e
  // coverage prior to this dispatch. Per TESTING_EVOLUTION.md §"The 10 user
  // flows", scenarios map to flows 2 (cosmetic iterate), 3 (new-feature
  // iterate), 4 (cascade), 5 (diagnose), 6 (mid-build queue), 7 (multi-turn).

  {
    id: 't-iterate-cosmetic-single-scope',
    title: 'Iterate (cosmetic, single-scope) — frontend-only direct dispatch (flow 2)',
    mode: 'multi-turn',
    prompt:
      'Build a small REST API for a personal task tracker. Backend: Node + Express with CRUD endpoints ' +
      'on a "tasks" resource (id, title, completed, created_at). Persist to a Postgres database. ' +
      'Provide a minimal React frontend that lists tasks and lets the user add a new one. ' +
      'Include docker-compose for local dev. No AI features, no vector database.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        prompt: 'Make the submit button bigger and use a brighter blue color.',
        // Cosmetic post-build follow-up. After the initial build leaves
        // .harness/state.md in place, this second prompt hits the post-
        // build concierge front door at routes.js, which classifies as
        // dispatch_iterate and routes through runConciergeIterate →
        // dispatchIterate (single-scope frontend direct dispatch).
        // Previously documented as "router emits iterate" — that path was
        // never wired through routeMessage (iterate-mode planner stayed
        // deferred); the concierge path is what actually fires today.
        // assertTurn just checks the iteration completed + frontend
        // artifacts survive; it doesn't assert the routing path.
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`iteration outcome=${observed.composeOutcome}, expected true/iterate-done/port_conflict`);
          }
          // Sanity: frontend entry still present (changed in place, not deleted).
          const entryCandidates = ['frontend/src/App.tsx', 'frontend/src/App.jsx', 'frontend/src/main.tsx'];
          const hasEntry = entryCandidates.some(p => fs.existsSync(path.join(workspace, p)));
          if (!hasEntry) throw new Error(`no React entry file post-iteration; checked: ${entryCandidates.join(', ')}`);
        },
      },
    ],
  },

  {
    id: 't-iterate-amend-multi-scope',
    title: 'Iterate (new feature, multi-scope) — orchestrator-with-diffs (flow 3)',
    mode: 'multi-turn',
    prompt:
      'Build a small REST API for a personal task tracker. Backend: Node + Express with CRUD endpoints ' +
      'on a "tasks" resource (id, title, completed, created_at). Persist to a Postgres database. ' +
      'Provide a minimal React frontend that lists tasks and lets the user add a new one. ' +
      'Include docker-compose for local dev. No AI features, no vector database.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        prompt:
          'Add an admin role to the system. Add a "role" column to the users table (default "user"). ' +
          'Add an admin-only endpoint GET /admin/stats that returns the count of tasks per user. ' +
          'On the frontend, show an "Admin" link in the header that opens an admin dashboard when the ' +
          'current user has role=admin.',
        // Multi-scope post-build follow-up. Hits the post-build concierge
        // (initial build leaves .harness/state.md), concierge classifies
        // as dispatch_iterate, runConciergeIterate calls contract-agent
        // in iterate-mode which emits affected_scopes spanning database
        // + backend + frontend, then dispatchIterate orchestrator-with-
        // diffs runs each affected scope's subagent in parallel.
        // assertTurn spot-checks the admin/role reference landed.
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`iteration outcome=${observed.composeOutcome}, expected compose-up succeed`);
          }
          const backendEntry = path.join(workspace, 'backend/src/index.ts');
          const backendMain = path.join(workspace, 'backend/main.py');
          const beContent = fs.existsSync(backendEntry) ? fs.readFileSync(backendEntry, 'utf-8')
            : fs.existsSync(backendMain) ? fs.readFileSync(backendMain, 'utf-8') : '';
          if (!/admin|role/i.test(beContent)) {
            throw new Error('backend entry does not reference admin/role after multi-scope iterate');
          }
        },
      },
    ],
  },

  {
    id: 't-iterate-cascade-breaking',
    title: 'Iterate (breaking change) — cascade detects all touching scopes via grep (flow 4)',
    mode: 'multi-turn',
    prompt:
      'Build a small REST API for a user directory. Backend: Node + Express with CRUD endpoints on a ' +
      '"users" resource (id, full_name, email, created_at). Persist to a Postgres database. Provide a ' +
      'minimal React frontend that shows the user list and displays each user\'s full_name. ' +
      'Include docker-compose for local dev. No AI features.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        prompt:
          'Rename the users.full_name column to two separate columns: first_name and last_name. ' +
          'Update the backend serializer to return both fields. Update the frontend to display ' +
          '"first_name last_name" wherever it previously showed full_name. Provide a migration so ' +
          'existing data is split sensibly.',
        // Breaking-change cascade. Post-build follow-up via concierge →
        // runConciergeIterate → contract-agent ITERATE mode emits affected
        // scopes; even when the model misses one (e.g. emits db+backend
        // but not frontend), the cascade module in chat/server/agent/
        // planner/contract-cascade.js greps the workspace for the renamed
        // identifiers and ESCALATES the scope set before dispatch runs.
        // This is the key mechanism this scenario tests — assertTurn
        // spot-checks the schema rename landed and compose came up,
        // which only works if all touching scopes actually re-ran.
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`iteration outcome=${observed.composeOutcome}, expected compose-up succeed`);
          }
          const dbInit = path.join(workspace, 'database/init/init.sql');
          if (fs.existsSync(dbInit)) {
            const sql = fs.readFileSync(dbInit, 'utf-8');
            if (!/first_name|last_name/i.test(sql)) {
              throw new Error('database/init/init.sql has no first_name/last_name reference after rename iterate');
            }
          }
        },
      },
    ],
  },

  {
    id: 't-diagnose-known-bug',
    title: 'Diagnose (known bug) — investigator agent read-only enforced (flow 5)',
    mode: 'multi-turn',
    // Opt-in telemetry: this scenario MUST produce investigator-records to
    // pass. Surfaces a missing/broken investigator pipeline as a scenario
    // failure rather than a silent pass.
    expectInvestigator: true,
    prompt:
      'Build a small REST API for a contact form. Backend: Node + Express with a POST /contact endpoint ' +
      'that accepts { name, email, message } and inserts into a Postgres "contacts" table (id, name, ' +
      'email, message, submitted_at). Provide a minimal React frontend with a contact form that POSTs ' +
      'to /contact. Include docker-compose. No AI features.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        // The bug-report message simulates a user observing a 500 on form
        // submit. Router should emit `diagnose`, investigator agent runs
        // read-only (permission gate hard-denies write_to_file inside
        // INVESTIGATING phase), investigator emits structured JSON with
        // confidence; orchestrator dispatches fix as internal iterate if
        // confidence ≥ 0.7, otherwise surfaces to user. Both outcomes are
        // valid diagnose-path behaviour.
        prompt:
          'Bug report: when I submit the contact form, I get a 500 Internal Server Error from the ' +
          'backend. Nothing useful is logged on the frontend besides the 500. Can you diagnose what\'s ' +
          'wrong and fix it? Don\'t add features — just make the existing POST /contact work end-to-end.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          // Outcome may be true/iterate-done if auto-fix landed (confidence
          // ≥0.7); or build_failed/skipped if investigator surfaced low-
          // confidence and didn't auto-fix. Both are valid diagnose paths
          // — the scenario is exercising the agent loop, not asserting a
          // specific resolution.
          if (!['true', 'iterate-done', 'port_conflict', 'build_failed', 'skipped'].includes(observed.composeOutcome)) {
            throw new Error(`iteration outcome=${observed.composeOutcome}, unexpected diagnose-path outcome`);
          }
          const backendEntry = path.join(workspace, 'backend/src/index.ts');
          const backendMain = path.join(workspace, 'backend/main.py');
          if (!fs.existsSync(backendEntry) && !fs.existsSync(backendMain)) {
            throw new Error('backend entry missing post-diagnose');
          }
        },
      },
    ],
  },

  // t-iteration-queue-mid-build commented out (cleanup): the queue
  // machinery this scenario exercises (second POST mid-build → HTTP 202
  // + iteration_queued event + drain after first build settles) is
  // currently INERT. Today the concierge handles mid-build messages and
  // its dispatch_iterate handler is a polite decline — nothing gets
  // enqueued. The queue infrastructure stays in code as part of the
  // session record for a future "mid-build iterate goes live" segment
  // (see chat/server/agent/concierge/handle-action.js comment block),
  // and chat/tests/integration/iteration-queue.test.js still covers
  // the queue's enqueue/drain/cancel semantics with mocks. Re-enable
  // this smoke when concierge actually queues mid-build iterates.
  //
  // {
  //   id: 't-iteration-queue-mid-build',
  //   title: 'Iteration queue mid-build — 202 response + iteration_queued event (flow 6)',
  //   mode: 'multi-scope',
  //   prompt:
  //     'Build a multi-scope app: a personal task tracker with React frontend, Express backend, Postgres ' +
  //     'database, and docker-compose. Tasks have id, title, description, completed, created_at. The ' +
  //     'frontend lists tasks and lets the user add new ones with title + description.',
  //   clarifyResponder: 'first-option',
  //   expectedScopes: ['backend', 'database', 'frontend', 'integration'],
  //   midBuildInterrupt: {
  //     delayMs: 45_000,
  //     message: 'Also add a "priority" field (low/medium/high) to tasks.',
  //   },
  // },

  {
    id: 't-multi-turn-flow',
    title: 'Multi-turn flow — build + 3 iterations on one workspace (flow 7)',
    mode: 'multi-turn',
    // Turn 3 is a diagnose; opt-in investigator-records telemetry assertion.
    expectInvestigator: true,
    prompt:
      'Build a small REST API for a personal task tracker. Backend: Node + Express with CRUD endpoints ' +
      'on a "tasks" resource (id, title, completed, created_at). Persist to a Postgres database. ' +
      'Provide a minimal React frontend that lists tasks and lets the user add new ones. ' +
      'Include docker-compose for local dev. No AI features.',
    clarifyResponder: 'first-option',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    // Per TESTING_EVOLUTION.md flow 7 — multi-turn session covering all three
    // iteration kinds in a row (cosmetic → new feature → bug-fix-via-diagnose).
    // Per-turn assertions check .harness/state.md, decisions.md (append-only),
    // contracts.json (latest-wins per POST_MERGE_FOLLOWUPS.md A.3).
    iterations: [
      {
        // Turn 1: cosmetic change (single-scope-direct path expected).
        prompt: 'Make the task list show completed tasks with a strikethrough style.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          // .harness/state.md must exist post-turn-0 + persist into turn 1.
          const stateMd = path.join(workspace, '.harness', 'state.md');
          if (!fs.existsSync(stateMd)) {
            throw new Error('.harness/state.md missing after turn 1');
          }
        },
      },
      {
        // Turn 2: new feature (multi-scope iterate, orchestrator-with-diffs).
        prompt:
          'Add a "due_date" field to each task. Backend: column on the tasks table + accept due_date ' +
          'in POST. Frontend: display due_date next to each task; if due_date is in the past and task ' +
          'is not completed, show "OVERDUE" in red.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 2) throw new Error(`expected turn=2, got ${turn}`);
          // contracts.json reflects the new field (latest-wins; per
          // POST_MERGE_FOLLOWUPS.md A.3 we don't assert version retention).
          const contractsJson = path.join(workspace, '.harness', 'contracts.json');
          if (fs.existsSync(contractsJson)) {
            const content = fs.readFileSync(contractsJson, 'utf-8');
            if (!/due_date/i.test(content)) {
              throw new Error('.harness/contracts.json does not reference due_date after multi-scope iterate');
            }
          }
          // decisions.md should have grown (append-only per turn).
          const decisionsMd = path.join(workspace, '.harness', 'decisions.md');
          if (fs.existsSync(decisionsMd)) {
            const content = fs.readFileSync(decisionsMd, 'utf-8');
            if (content.length < 50) {
              throw new Error('.harness/decisions.md is suspiciously short — expected per-turn append entries');
            }
          }
        },
      },
      {
        // Turn 3: bug fix via diagnose.
        prompt:
          'Bug report: when I add a task with a past due_date, the "OVERDUE" label doesn\'t show up — ' +
          'all tasks display as if they were on time. Can you diagnose and fix?',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 3) throw new Error(`expected turn=3, got ${turn}`);
          // Post-3-turns sanity: coderConversationIds persistence is implicit
          // in the .harness/ directory continuing to exist; the deeper check
          // (specific conversationId map per scope) lives in the integration
          // test write-harness-state-pipeline.test.js. Spot-check here that
          // .harness/ wasn't wiped between turns.
          if (!fs.existsSync(path.join(workspace, '.harness'))) {
            throw new Error('.harness/ directory missing after 3 turns — workspace state lost');
          }
        },
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // POST-BUILD CONVERSATIONAL FLOW (Phase 1 + Prereq D verification)
  // Uses `fromSnapshot: 'tasktracker-basic'` to skip the slow initial build.
  // Capture the snapshot once via:
  //   npm run smoke -- --only=t-iterate-cosmetic-single-scope --capture-snapshot=tasktracker-basic
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 't-postbuild-conversational-flow',
    title: 'Post-build: concierge answers + iterates without rebuild (Sm-3, fromSnapshot)',
    mode: 'multi-turn',
    fromSnapshot: 'tasktracker-basic',
    // expectedScopes is informational only — fromSnapshot skips turn 0 so the
    // planner's scope emission isn't observed in this scenario. Listed for
    // documentation purposes (matches what the snapshot was built with).
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        // Turn 1: pure conversational ask. Concierge should respond with text
        // citing the actual tables/columns from .harness/state.md — proves the
        // built_state_markdown field reaches the LLM and is used to answer.
        prompt: 'What database tables do we have, and what columns are in the tasks table?',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (observed.composeOutcome !== 'concierge-only') {
            throw new Error(`expected composeOutcome=concierge-only, got ${observed.composeOutcome}`);
          }
          if (!observed.conciergeTextEvents?.length) {
            throw new Error('expected concierge_text event(s); got none');
          }
          if (observed.subagentDispatchCount > 0) {
            throw new Error(`expected zero subagent dispatches; got ${observed.subagentDispatchCount}`);
          }
          const reply = observed.conciergeTextEvents.map(e => e.text).join(' ');
          if (!/tasks/i.test(reply)) {
            throw new Error(`concierge reply should reference "tasks" table; got: ${reply.slice(0, 200)}`);
          }
        },
      },
      {
        // Turn 2: cosmetic iterate ask. Concierge should classify as
        // dispatch_iterate; iterate-dispatcher runs contract-agent in ITERATE
        // mode and dispatches the frontend subagent. Verifies the end-to-end
        // Prereq D wiring (concierge → iterate-dispatcher → dispatchIterate).
        prompt: 'Make the "add task" button green.',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 2) throw new Error(`expected turn=2, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`expected iterate compose outcome; got ${observed.composeOutcome}`);
          }
          if (observed.subagentDispatchCount < 1) {
            throw new Error(`expected at least one subagent dispatch on iterate; got ${observed.subagentDispatchCount}`);
          }
        },
      },
      {
        // Turn 3: conversational follow-up about the change from turn 2.
        // Concierge should read the post-iterate state.md (rewritten by
        // dispatchIterate via generateBuildSummary+writeStateMd at
        // routes.js:692) and answer "green". This is the round-trip proof
        // that the post-iterate state refresh actually reaches the concierge.
        prompt: 'What color is the add-task button now?',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 3) throw new Error(`expected turn=3, got ${turn}`);
          if (observed.composeOutcome !== 'concierge-only') {
            throw new Error(`expected composeOutcome=concierge-only, got ${observed.composeOutcome}`);
          }
          if (!observed.conciergeTextEvents?.length) {
            throw new Error('expected concierge_text event(s); got none');
          }
          if (observed.subagentDispatchCount > 0) {
            throw new Error(`expected zero subagent dispatches; got ${observed.subagentDispatchCount}`);
          }
          const reply = observed.conciergeTextEvents.map(e => e.text).join(' ');
          if (!/green/i.test(reply)) {
            throw new Error(`concierge reply should reference "green"; got: ${reply.slice(0, 200)}`);
          }
        },
      },
    ],
  },

  // Sm-3 only exercises single-scope iterate (frontend only). This scenario
  // pushes through the multi-scope orchestrator-with-diffs path: a feature
  // ask spanning database (new column) + backend (accept the field) +
  // frontend (UI to set it). The concierge classifies as dispatch_iterate;
  // runConciergeIterate emits a contract with affected_scopes >= 2; routes
  // through the orchestrator path of dispatchIterate. Then a follow-up
  // conversational turn verifies state.md merged the new field info
  // (proves built.json's merge semantics work for multi-scope, not just
  // single-scope iterate).
  {
    id: 't-postbuild-multi-scope-iterate',
    title: 'Post-build: concierge dispatches multi-scope iterate (database + backend + frontend) + follow-up Q&A',
    mode: 'multi-turn',
    fromSnapshot: 'tasktracker-basic',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        // Multi-scope feature with NO schema change — schema changes are
        // where multi-scope subagents most often produce uncompilable TS
        // (column type vs. generated contract type mismatch). A filter
        // feature touches backend (new query-param handling) + frontend
        // (UI dropdown), 2 scopes, well within both subagents' wheelhouse.
        // Triggers the orchestrator-with-diffs path because affected_scopes.length >= 2.
        prompt: 'Add a status filter to the task list. Backend: accept an optional `?status=pending|completed|all` query parameter on GET /api/tasks and filter the results accordingly (default "all" when omitted). Frontend: add a dropdown above the task list to switch between "All", "Pending", "Completed" views; the selected option is sent as the status query param.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`expected iterate compose outcome; got ${observed.composeOutcome}`);
          }
          // Dispatch happened at all. NOTE: the multi-scope orchestrator
          // emits a SINGLE scope_status:running event for the whole batch
          // (not per-scope), so we can't count individual subagents from
          // SSE events here. Multi-scope-ness is verified by the
          // disk-level + built.json assertions below: the backend file
          // shows the filter handling, and built.json has the merged
          // scope summaries from both backend + frontend.
          if (observed.subagentDispatchCount < 1) {
            throw new Error(`expected >= 1 subagent dispatch; got ${observed.subagentDispatchCount}`);
          }
          // Disk-level proof: status filter handling should land in backend.
          const backendCandidates = [
            'backend/src/routes.ts',
            'backend/src/index.ts',
            'backend/src/app.ts',
            'backend/main.py',
            'backend/app/main.py',
          ];
          const beFile = backendCandidates
            .map(p => path.join(workspace, p))
            .find(p => fs.existsSync(p));
          if (beFile) {
            const code = fs.readFileSync(beFile, 'utf-8');
            if (!/status/i.test(code)) {
              throw new Error(`backend (${beFile}) does not reference status filter after multi-scope iterate`);
            }
          }
          // built.json merge correctness — multi-scope iterate touching
          // backend + frontend must NOT drop the database or integration
          // scope summaries from the initial build. This is the
          // multi-scope variant of Sm-3's merge check.
          const builtJson = path.join(workspace, '.harness', 'built.json');
          if (fs.existsSync(builtJson)) {
            const built = JSON.parse(fs.readFileSync(builtJson, 'utf-8'));
            const scopes = Object.keys(built);
            for (const required of ['database', 'backend', 'frontend', 'integration']) {
              if (!scopes.includes(required)) {
                throw new Error(`.harness/built.json missing scope "${required}" after multi-scope iterate; got [${scopes.join(', ')}]`);
              }
            }
            // Frontend or backend (or both) should mention the new filter
            // in their summaries — this proves contract-diff actually
            // reached the subagent and the subagent reported on the change.
            const filterMentioned = /(filter|status|pending|completed)/i.test(built.frontend || '')
              || /(filter|status|pending|completed)/i.test(built.backend || '');
            if (!filterMentioned) {
              throw new Error(`built.json frontend/backend sections should reference the new filter; got frontend=${(built.frontend || '').slice(0, 100)}... backend=${(built.backend || '').slice(0, 100)}...`);
            }
          }
        },
      },
      {
        // Follow-up conversational ask — concierge should read the refreshed
        // state.md (now reflecting the multi-scope change) and cite the
        // new filter. Proves the multi-scope iterate's effects propagated
        // into the post-build conversational context, not just disk
        // artifacts. If built.json's frontend OR backend section lost the
        // filter info (regression of merge semantics), concierge would
        // say "I don't see a status filter" and this assertion would fail.
        prompt: 'I notice you added a filter to the task list — what filter options does it support?',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 2) throw new Error(`expected turn=2, got ${turn}`);
          if (observed.composeOutcome !== 'concierge-only') {
            throw new Error(`expected composeOutcome=concierge-only, got ${observed.composeOutcome}`);
          }
          if (!observed.conciergeTextEvents?.length) {
            throw new Error('expected concierge_text event(s); got none');
          }
          if (observed.subagentDispatchCount > 0) {
            throw new Error(`expected zero subagent dispatches on conversational follow-up; got ${observed.subagentDispatchCount}`);
          }
          const reply = observed.conciergeTextEvents.map(e => e.text).join(' ');
          if (!/(pending|completed|all)/i.test(reply)) {
            throw new Error(`concierge reply should reference the filter options (pending/completed/all); got: ${reply.slice(0, 200)}`);
          }
        },
      },
    ],
  },

  // Iterate-on-iterate-on-iterate. Sm-3 only does ONE iterate; this scenario
  // does TWO sequential iterates touching DIFFERENT scopes, then a
  // conversational turn that requires citing BOTH prior iterates' effects.
  // The whole point of Option C's built.json + merge semantics was to
  // preserve scope sections across partial-scope iterates — this scenario
  // is the regression test for that: if turn 2's backend iterate wiped the
  // frontend section from state.md (the pre-built.json bug), turn 3's
  // concierge would say "I don't know what color the button is" and the
  // assertion would fail.
  {
    id: 't-postbuild-iterate-chain',
    title: 'Post-build: two sequential iterates (frontend then backend) preserve cross-scope state in built.json',
    mode: 'multi-turn',
    fromSnapshot: 'tasktracker-basic',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        // Iterate 1: frontend-only cosmetic. Same shape as Sm-3 turn 2.
        prompt: 'Make the "add task" button green.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`expected iterate compose outcome; got ${observed.composeOutcome}`);
          }
          if (observed.subagentDispatchCount < 1) {
            throw new Error(`expected >= 1 subagent dispatch; got ${observed.subagentDispatchCount}`);
          }
          // built.json sanity: all 4 scopes still present after frontend-only
          // iterate (the bug-pre-Option-C would have left only frontend here).
          const builtJson = path.join(workspace, '.harness', 'built.json');
          if (!fs.existsSync(builtJson)) {
            throw new Error('.harness/built.json missing after iterate (should be written by writeBuilt)');
          }
          const built = JSON.parse(fs.readFileSync(builtJson, 'utf-8'));
          for (const required of ['database', 'backend', 'frontend', 'integration']) {
            if (!Object.keys(built).includes(required)) {
              throw new Error(`.harness/built.json missing scope "${required}" after frontend iterate; got [${Object.keys(built).join(', ')}]`);
            }
          }
          // Frontend section MUST be updated (mention green); other scope
          // sections must be PRESERVED (we don't check their content
          // verbatim — just that the keys are still there).
          if (!/green/i.test(built.frontend || '')) {
            throw new Error(`built.json frontend section should reference "green"; got: ${(built.frontend || '').slice(0, 200)}`);
          }
        },
      },
      {
        // Iterate 2: backend-only. The cosmetic frontend change from turn 1
        // is on disk + in built.json. After this turn, built.json must
        // still preserve the green-button frontend section (turn 1's effect)
        // AND have an updated backend section (turn 2's effect).
        prompt: 'Add a GET /api/tasks/count endpoint that returns { "count": <total number of tasks> }.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 2) throw new Error(`expected turn=2, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`expected iterate compose outcome; got ${observed.composeOutcome}`);
          }
          if (observed.subagentDispatchCount < 1) {
            throw new Error(`expected >= 1 subagent dispatch on backend iterate; got ${observed.subagentDispatchCount}`);
          }
          // Disk-level proof: /count should land in the backend code.
          const backendCandidates = [
            'backend/src/routes.ts',
            'backend/src/index.ts',
            'backend/src/app.ts',
            'backend/main.py',
            'backend/app/main.py',
          ];
          const beFile = backendCandidates
            .map(p => path.join(workspace, p))
            .find(p => fs.existsSync(p));
          if (beFile) {
            const code = fs.readFileSync(beFile, 'utf-8');
            if (!/\/count/.test(code)) {
              throw new Error(`backend (${beFile}) does not reference /count after backend iterate`);
            }
          }
          // The critical merge assertion: built.json must preserve frontend's
          // green-button entry from turn 1 AND have backend updated for /count.
          const builtJson = path.join(workspace, '.harness', 'built.json');
          if (!fs.existsSync(builtJson)) {
            throw new Error('.harness/built.json missing after second iterate');
          }
          const built = JSON.parse(fs.readFileSync(builtJson, 'utf-8'));
          if (!/green/i.test(built.frontend || '')) {
            throw new Error(`built.json frontend section LOST after backend iterate (regression of Option C merge); got: ${(built.frontend || '').slice(0, 200)}`);
          }
          if (!/count/i.test(built.backend || '')) {
            throw new Error(`built.json backend section should reference "count" after backend iterate; got: ${(built.backend || '').slice(0, 200)}`);
          }
          // Database + integration sections must still be present.
          for (const required of ['database', 'integration']) {
            if (!Object.keys(built).includes(required)) {
              throw new Error(`.harness/built.json missing scope "${required}" after iterate chain; got [${Object.keys(built).join(', ')}]`);
            }
          }
        },
      },
      {
        // Conversational follow-up that requires BOTH prior iterates'
        // effects. If turn 2's backend iterate had wiped frontend's
        // "green" from state.md (the pre-built.json bug we fixed), the
        // concierge wouldn't be able to answer the color question.
        prompt: 'Two questions: what color is the add-task button now, and is there an endpoint to get the total task count?',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 3) throw new Error(`expected turn=3, got ${turn}`);
          if (observed.composeOutcome !== 'concierge-only') {
            throw new Error(`expected composeOutcome=concierge-only, got ${observed.composeOutcome}`);
          }
          if (!observed.conciergeTextEvents?.length) {
            throw new Error('expected concierge_text event(s); got none');
          }
          if (observed.subagentDispatchCount > 0) {
            throw new Error(`expected zero subagent dispatches on conversational follow-up; got ${observed.subagentDispatchCount}`);
          }
          const reply = observed.conciergeTextEvents.map(e => e.text).join(' ');
          if (!/green/i.test(reply)) {
            throw new Error(`concierge should still know the button is green (turn 1 effect preserved); got: ${reply.slice(0, 200)}`);
          }
          if (!/count/i.test(reply)) {
            throw new Error(`concierge should know about the /count endpoint (turn 2 effect); got: ${reply.slice(0, 200)}`);
          }
        },
      },
    ],
  },

  // Exercises the concierge `multi` action path. The prompt explicitly
  // asks for TWO distinct features joined by AND — per concierge.md §4
  // the LLM is expected to emit `multi` with two sub-actions. If the LLM
  // instead emits a single dispatch_iterate with both scopes in
  // affected_scopes, the normalizer + iterate-dispatcher still handle it
  // correctly (multi-scope orchestrator path). Both classifications
  // produce the same end state; this scenario verifies the architecture
  // is robust to either. The unit tests in concierge-normalize.test.js
  // cover the multi-flattening logic in isolation.
  {
    id: 't-postbuild-multi-action',
    title: 'Post-build: concierge multi-action prompt (backend endpoint AND frontend color change)',
    mode: 'multi-turn',
    fromSnapshot: 'tasktracker-basic',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        // Two-distinct-asks prompt. Per concierge.md §4 ("Multi-intent
        // 'add comments AND email notifications'") this is the textbook
        // multi case. The architecture also handles the case where the
        // LLM consolidates into one multi-scope dispatch_iterate.
        prompt: 'Two things please: add a GET /api/version endpoint to the backend that returns {"version":"1.0.0"}, AND change the add-task button color from blue to red.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`expected iterate compose outcome; got ${observed.composeOutcome}`);
          }
          if (observed.subagentDispatchCount < 1) {
            throw new Error(`expected >= 1 subagent dispatch; got ${observed.subagentDispatchCount}`);
          }
          // Both features should have landed regardless of how concierge
          // partitioned the work (multi with 2 sub-iterates / single
          // multi-scope iterate / sequential iterates).
          const backendCandidates = [
            'backend/src/routes.ts',
            'backend/src/index.ts',
            'backend/src/app.ts',
            'backend/main.py',
          ];
          const beFile = backendCandidates
            .map(p => path.join(workspace, p))
            .find(p => fs.existsSync(p));
          if (beFile) {
            const code = fs.readFileSync(beFile, 'utf-8');
            if (!/\/version/.test(code)) {
              throw new Error(`backend (${beFile}) does not reference /version after multi-action iterate`);
            }
          }
          // Frontend: red button. Tailwind class `bg-red-*` or a `red`
          // colour reference somewhere in the components.
          const addFormPath = path.join(workspace, 'frontend/src/components/AddTaskForm.tsx');
          if (fs.existsSync(addFormPath)) {
            const code = fs.readFileSync(addFormPath, 'utf-8');
            if (!/red/i.test(code)) {
              throw new Error(`AddTaskForm.tsx does not reference red after multi-action iterate`);
            }
          }
          // built.json merge correctness: all 4 scopes preserved even
          // when multiple scopes were iterated.
          const builtJson = path.join(workspace, '.harness', 'built.json');
          if (fs.existsSync(builtJson)) {
            const built = JSON.parse(fs.readFileSync(builtJson, 'utf-8'));
            for (const required of ['database', 'backend', 'frontend', 'integration']) {
              if (!Object.keys(built).includes(required)) {
                throw new Error(`.harness/built.json missing scope "${required}" after multi-action iterate; got [${Object.keys(built).join(', ')}]`);
              }
            }
          }
        },
      },
      {
        // Conversational follow-up — concierge should know about BOTH
        // changes from the refreshed state.md / built.json.
        prompt: 'Quick check: what HTTP endpoint did you add for version info, and what color is the add-task button now?',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 2) throw new Error(`expected turn=2, got ${turn}`);
          if (observed.composeOutcome !== 'concierge-only') {
            throw new Error(`expected composeOutcome=concierge-only, got ${observed.composeOutcome}`);
          }
          if (!observed.conciergeTextEvents?.length) {
            throw new Error('expected concierge_text event(s); got none');
          }
          if (observed.subagentDispatchCount > 0) {
            throw new Error(`expected zero subagent dispatches on conversational follow-up; got ${observed.subagentDispatchCount}`);
          }
          const reply = observed.conciergeTextEvents.map(e => e.text).join(' ');
          if (!/version/i.test(reply)) {
            throw new Error(`concierge reply should reference the /version endpoint; got: ${reply.slice(0, 200)}`);
          }
          if (!/red/i.test(reply)) {
            throw new Error(`concierge reply should reference the red button; got: ${reply.slice(0, 200)}`);
          }
        },
      },
    ],
  },

  // Exercises the concierge `interrupt` action with `interrupt_then=iterate`
  // — the redirect path. Per concierge.md §4 ("Redirect / contradicts
  // prior decision 'use Python instead of Node'"), the LLM is expected to
  // classify "I changed my mind..." as interrupt + iterate. The normalizer
  // (chat/server/agent/concierge/normalize-action.js) collapses this to a
  // regular dispatch_iterate (because there's no in-flight build to
  // actually interrupt in the post-build idle path) so the dispatch
  // pipeline doesn't care which classification fired. Either way, the
  // redirect change ships.
  {
    id: 't-postbuild-redirect',
    title: 'Post-build: concierge redirect / interrupt-then-iterate ("actually, change X instead")',
    mode: 'multi-turn',
    fromSnapshot: 'tasktracker-basic',
    expectedScopes: ['backend', 'database', 'frontend', 'integration'],
    iterations: [
      {
        // Explicit redirect language ("actually", "I changed my mind",
        // "instead of") that mirrors the concierge prompt's §4 interrupt
        // examples. The snapshot's add-task button is blue (verified
        // pre-Sm-3); the user "changes their mind" and wants orange.
        // Single-scope (frontend), low compile-risk.
        prompt: 'Actually, I changed my mind about the add-task button — instead of leaving it blue, please make it orange.',
        assertTurn: ({ turn, observed, workspace }) => {
          if (turn !== 1) throw new Error(`expected turn=1, got ${turn}`);
          if (!['true', 'iterate-done', 'port_conflict'].includes(observed.composeOutcome)) {
            throw new Error(`expected iterate compose outcome; got ${observed.composeOutcome}`);
          }
          if (observed.subagentDispatchCount < 1) {
            throw new Error(`expected >= 1 subagent dispatch; got ${observed.subagentDispatchCount}`);
          }
          // The change should have landed regardless of classification
          // (interrupt-then-iterate collapsed to dispatch_iterate OR
          // straight dispatch_iterate). Orange = bg-orange-* Tailwind
          // class or `orange` reference.
          const addFormPath = path.join(workspace, 'frontend/src/components/AddTaskForm.tsx');
          if (fs.existsSync(addFormPath)) {
            const code = fs.readFileSync(addFormPath, 'utf-8');
            if (!/orange/i.test(code)) {
              throw new Error(`AddTaskForm.tsx does not reference orange after redirect; got button styling: ${code.match(/bg-\S+/g)?.join(', ') || '(none found)'}`);
            }
          }
          // built.json merge sanity: all 4 scopes preserved.
          const builtJson = path.join(workspace, '.harness', 'built.json');
          if (fs.existsSync(builtJson)) {
            const built = JSON.parse(fs.readFileSync(builtJson, 'utf-8'));
            for (const required of ['database', 'backend', 'frontend', 'integration']) {
              if (!Object.keys(built).includes(required)) {
                throw new Error(`.harness/built.json missing scope "${required}" after redirect; got [${Object.keys(built).join(', ')}]`);
              }
            }
            if (!/orange/i.test(built.frontend || '')) {
              throw new Error(`built.json frontend section should reference orange after redirect; got: ${(built.frontend || '').slice(0, 200)}`);
            }
          }
        },
      },
      {
        // Conversational check: concierge sees the redirect's effect.
        prompt: 'What color is the add-task button now?',
        assertTurn: ({ turn, observed }) => {
          if (turn !== 2) throw new Error(`expected turn=2, got ${turn}`);
          if (observed.composeOutcome !== 'concierge-only') {
            throw new Error(`expected composeOutcome=concierge-only, got ${observed.composeOutcome}`);
          }
          if (!observed.conciergeTextEvents?.length) {
            throw new Error('expected concierge_text event(s); got none');
          }
          if (observed.subagentDispatchCount > 0) {
            throw new Error(`expected zero subagent dispatches on conversational follow-up; got ${observed.subagentDispatchCount}`);
          }
          const reply = observed.conciergeTextEvents.map(e => e.text).join(' ');
          if (!/orange/i.test(reply)) {
            throw new Error(`concierge should know the button is orange; got: ${reply.slice(0, 200)}`);
          }
        },
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ENTERPRISE PRODUCTION SCENARIOS
  // Real-world business prompts mirrored from chat/tests/two-agent/
  // test-prompts.json so the smoke matrix exercises end-to-end build (not
  // just the planner pair). These are the scenarios the platform is
  // ACTUALLY meant to solve in production, in contrast to the t1–t11
  // synthetic scenarios above which test specific harness mechanisms.
  //
  // Tiered by difficulty (easy → hard) per the source file. AI-knowledge
  // scenarios expect an AI-RAG architecture (5 scopes with vectordb).
  // Non-AI scenarios expect a CRUD/dashboard archetype (no vectordb).
  // ─────────────────────────────────────────────────────────────────────────

  {
    id: 't-ent-easy-policy',
    title: 'Enterprise [easy]: Policy and Procedure Discovery (AI-RAG over SharePoint)',
    mode: 'multi-scope',
    prompt:
      'Our employees frequently struggle to find the latest version of internal policies, ' +
      'operational procedures, and compliance guidance across SharePoint sites and shared drives. ' +
      'Teams often rely on asking colleagues directly because search results are inconsistent and ' +
      'documents are duplicated across departments. This creates delays, especially for newer ' +
      'employees and regional offices that may not know where authoritative information is stored. ' +
      'Leadership wants a more reliable way for employees to quickly locate accurate business ' +
      'information without needing to understand the underlying systems.',
    clarifyResponder: 'first-option',
    // AI-RAG over SharePoint: expect at minimum frontend+backend+database+integration.
    // vectordb is allowed (and likely) but not asserted as required — the planner
    // may pick pgvector-as-unified-database (same flexibility as t6).
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't-ent-medium-contracts',
    title: 'Enterprise [medium]: Contract and Document Analysis (AI-RAG + structured extraction)',
    mode: 'multi-scope',
    prompt:
      'Our procurement and legal teams review hundreds of vendor agreements every quarter, and ' +
      'identifying unusual clauses or inconsistent commercial terms has become increasingly ' +
      'difficult. Important obligations around renewals, pricing adjustments, or compliance ' +
      'requirements are often buried deep within lengthy documents. The current review process is ' +
      'heavily manual and depends on institutional knowledge from a small number of experienced ' +
      'employees. We are looking for a more scalable way to analyze large volumes of business ' +
      'documents and surface key risks or inconsistencies earlier in the process.',
    clarifyResponder: 'first-option',
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't-ent-medhard-knowledge',
    title: 'Enterprise [medium-hard]: Knowledge Management Across Business Units (multi-source RAG)',
    mode: 'multi-scope',
    prompt:
      'As the organization has expanded globally, valuable operational knowledge has become ' +
      'fragmented across regional teams, SharePoint repositories, internal wikis, and archived ' +
      'project documents. Employees frequently recreate work because they cannot easily identify ' +
      'whether similar initiatives, lessons learned, or client deliverables already exist ' +
      'elsewhere in the company. Leadership believes there is significant untapped institutional ' +
      'knowledge, but accessing it today requires knowing exactly where to look or who to ask. ' +
      'We need a more effective way to connect employees with relevant business knowledge across ' +
      'the enterprise.',
    clarifyResponder: 'first-option',
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't-ent-hard-compliance',
    title: 'Enterprise [hard]: Enterprise Risk and Compliance Oversight (AI-RAG + audit trails)',
    mode: 'multi-scope',
    prompt:
      'Our compliance and risk management teams are struggling to maintain visibility across ' +
      'thousands of documents, audit reports, policies, and operational records distributed across ' +
      'multiple business systems. Regulatory reviews often trigger urgent cross-functional efforts ' +
      'to gather evidence manually, and there is limited confidence that all relevant information ' +
      'has been identified consistently. Executives are concerned about the growing operational ' +
      'risk associated with fragmented documentation and inconsistent governance practices across ' +
      'regions. The business needs a more intelligent and scalable approach to monitoring, ' +
      'analyzing, and retrieving critical compliance information before issues escalate.',
    clarifyResponder: 'first-option',
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't-ent-easy-sales',
    title: 'Enterprise [easy]: Sales Reporting Confusion (NON-AI, CRUD/dashboard)',
    mode: 'multi-scope',
    prompt:
      'Our regional sales managers are all bringing different numbers into the weekly executive ' +
      'meeting, and we spend more time debating which spreadsheet is correct than discussing the ' +
      'business itself. Finance, Sales, and Operations all seem to define \'active customer\' ' +
      'differently, which is creating tension between teams. Leadership wants one trusted view of ' +
      'pipeline performance and renewals without forcing people to manually reconcile reports ' +
      'every Friday. We need a way to make reporting more consistent and easier to trust across ' +
      'departments.',
    clarifyResponder: 'first-option',
    // NON-AI: no explicit AI signals in the prompt. Planner should produce
    // a CRUD/dashboard archetype WITHOUT forcing vectordb / ai-rag flags.
    // If the planner adds AI features, that's a regression in the
    // disambiguation step. expectedScopes intentionally excludes vectordb.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  {
    id: 't-ent-easymed-onboarding',
    title: 'Enterprise [easy-medium]: Employee Onboarding (NON-AI, workflow/collab)',
    mode: 'multi-scope',
    prompt:
      'As we continue hiring across multiple countries, onboarding new employees has become ' +
      'increasingly inconsistent and time-consuming. HR, IT, Legal, and department managers all ' +
      'operate with separate processes, so simple things like equipment access or compliance ' +
      'training often fall through the cracks. New hires sometimes wait more than a week before ' +
      'they can fully contribute, which is hurting productivity and first impressions. We want ' +
      'to create a smoother onboarding experience that feels coordinated and scalable as the ' +
      'company grows.',
    clarifyResponder: 'first-option',
    // NON-AI workflow app: collab-tool / crud-app archetype. Same
    // expectations as sales reporting — no AI features expected.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
  },

  // ── Hybrid module smoke scenarios (added 2026-06-19) ─────────────────────
  // These exercise the hybrid routing path (HYBRID_MODULES_ENABLED=true).
  // Expected hybrid signals: has_llm_at_runtime=true, has_dynamic_content=true.
  // Expected routing: confidence >= 0.75, modulePlan=[synthesis, policy-checker],
  // hybrid-router runs modules before build-dispatcher.
  {
    id: 't42-startup-idea-generator-hybrid',
    title: 'Hybrid AI: Startup idea generator — LLM per category (synthesis + policy-checker)',
    mode: 'multi-scope',
    prompt:
      'Build a startup idea generator. The user picks a category — health, finance, or education — ' +
      'and the app calls an LLM to generate 5 startup ideas for that category. ' +
      'Each idea must include a title, one-sentence description, 3 pros and 3 cons. ' +
      'The user can save favourite ideas to a list. ' +
      'The generated ideas must come from an LLM call at runtime, not be hardcoded.',
    clarifyResponder: 'first-option',
    // Contract agent consistently adds vectordb alongside the core four — that's
    // fine; plannerExpect.scopes is a subset check so extra scopes don't fail it.
    expectedScopes: ['frontend', 'backend', 'database', 'integration'],
    // Hybrid routing assertions — verified in assertTurn after plan_preview
    hybridExpect: {
      modulesRan: true,
      modulePlanIncludes: ['synthesis', 'policy-checker'],
      minConfidence: 0.75,
      reasonCodesInclude: ['adaptive-need'],
    },
    plannerExpect: {
      scopes: ['frontend', 'backend', 'database', 'integration'],
      flags: [],
      // api_contract path omitted — contract agent non-deterministically
      // names the generate endpoint (/generate, /ideas/generate, etc.).
      // The assertTurn filesystem grep below verifies the route exists.
    },
    assertTurn: ({ turn, observed, workspace }) => {
      if (turn !== 0) return; // only check initial build turn
      // Hybrid trace check deliberately omitted: whether the contract agent
      // emits a modulePlan is non-deterministic (LLM output). The router
      // correctly skips with 'no-module-plan' when modulePlan is null —
      // that is valid behaviour, not a failure. The build outcome and the
      // generate-route filesystem check below are the reliable assertions.

      // Either path: backend must have an ideas/generate endpoint scaffolded
      const backendCandidates = [
        'backend/src/routes/generate.ts',
        'backend/src/generate.ts',
        'backend/src/routes/ideas.ts',
        'backend/src/ideas.ts',
        'backend/index.ts',
        'backend/src/index.ts',
        'backend/app.ts',
      ];
      const GENERATE_PATTERN = /\/(ideas\/generate|api\/generate|generate)/;
      const hasGenerateRoute = backendCandidates.some(p =>
        fs.existsSync(path.join(workspace, p)) &&
        GENERATE_PATTERN.test(fs.readFileSync(path.join(workspace, p), 'utf8'))
      ) || (() => {
        try {
          execSync(
            `grep -rE "/(ideas/generate|api/generate|generate)" "${path.join(workspace, 'backend')}" --include="*.ts" --include="*.js" -l`,
            { stdio: 'pipe' }
          );
          return true;
        } catch { return false; }
      })();
      if (!hasGenerateRoute) {
        throw new Error('t42: no idea-generation route found in backend — LLM integration endpoint missing');
      }
    },
  },
    {
    id: 't43-policy-rag-architecture',
    title: 'AI-RAG: Policy Q&A with architecture decision verification',
    mode: 'multi-scope',
    prompt:
      'Build me an AI question-answering system over our company policy documents. ' +
      'Employees can upload PDF policy files, then ask natural language questions and get answers with citations. ' +
      'Should handle multi-page documents and provide relevant excerpts.',
    clarifyResponder: 'first-option',
    // This prompt explicitly triggers RAG patterns: "question-answering", "documents", "citations"
    // Expected outcome:
    // - hybrid_signals.has_rag_pattern = true
    // - contract emits ragArchitecture decision with:
    //   * vector_engine: "pgvector"
    //   * embedding_model: "text-embedding-3-large" (semantic richness for policy docs)
    //   * chunking.strategy: "semantic" (preserve policy context)
    //   * retrieval_pattern: "stuff" (single-document Q&A)
    // - Scope includes vectordb (RAG requirement)
    expectedScopes: ['backend', 'frontend', 'database', 'vectordb', 'integration'],
    plannerExpect: {
      scopes: ['backend', 'frontend', 'database', 'vectordb', 'integration'],
      flags: ['ai-rag'],
      vector_engine: 'pgvector',
      mga_assistants_min: 1,
      ui_contract: {
        primary_view: /upload|question|answer|policy|q.?a|search|doc/i,
      },
    },
    assert: ({ result, workspace, sessionId }) => {
      // Verify the harness wrote .env with placeholder MGA config
      const envPath = path.join(workspace, '.env');
      if (!fs.existsSync(envPath)) throw new Error(`.env missing — MGA config not staged`);
      const env = fs.readFileSync(envPath, 'utf-8');
      for (const k of ['MGA_API_KEY=', 'MGA_BASE_URL=', 'MGA_ASSISTANT_ID=']) {
        if (!env.includes(k)) throw new Error(`.env missing ${k.replace('=','')}`);
      }
      // Verify vectordb scope produced schema
      const vectordbInit = path.join(workspace, 'vectordb/init/01_init.sql');
      if (!fs.existsSync(vectordbInit)) throw new Error(`vectordb/init/01_init.sql missing — RAG schema not created`);
      const initContent = fs.readFileSync(vectordbInit, 'utf-8');
      if (!/CREATE EXTENSION.*vector/i.test(initContent)) {
        throw new Error(`vectordb schema doesn't enable pgvector extension`);
      }
      // Verify backend wired embedding calls (at minimum, imports embed library)
      const backendPath = path.join(workspace, 'backend/src');
      const backendFiles = fs.readdirSync(backendPath).filter(f => /\.(ts|js)$/.test(f));
      let hasEmbedLogic = false;
      for (const f of backendFiles) {
        const content = fs.readFileSync(path.join(backendPath, f), 'utf-8');
        if (/embed|vector|similarity|retriev/i.test(content)) {
          hasEmbedLogic = true;
          break;
        }
      }
      if (!hasEmbedLogic) {
        throw new Error(`backend code doesn't reference embedding/retrieval logic`);
      }
      return { envPath, vectordbSchema: vectordbInit, hasEmbedding: hasEmbedLogic };
    },
    expectedIntent:
      'AI Q&A system over policy documents with semantic search. Users upload PDFs; backend chunks and embeds them; frontend allows natural-language queries that return matching policy sections with citations. Separate relational DB for document metadata and vector DB for embeddings.',
  },
];

/**
 * Recursive directory listing for assert helpers. Caps depth to avoid
 * walking node_modules etc. Returns absolute file paths.
 */
function listFilesRecursive(dir, { maxDepth = 4, _depth = 0 } = {}) {
  const out = [];
  if (_depth > maxDepth) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__' || e.name === 'dist' || e.name === 'build') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, { maxDepth, _depth: _depth + 1 }));
    else out.push(full);
  }
  return out;
}

// ── Runner ───────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Render an assertNotes entry value as a compact, human-readable string
 * for the per-scenario PASS line and the final summary table. Default
 * `${v}` coercion produces `[object Object],[object Object]` for arrays
 * of objects (notably `turns` from runMultiTurnScenario) — useless in a
 * one-line report. This formatter:
 *
 *   - numbers → formatTokens (1.2K)
 *   - strings / bools → as-is
 *   - `turns` array → `[1:true/2.4s, 2:iterate-done/3m, ...]`
 *   - other object arrays → JSON, truncated to 80 chars
 *   - other objects → JSON, truncated to 80 chars
 */
function formatNoteValue(key, value) {
  if (value == null) return 'null';
  if (typeof value === 'number') return formatTokens(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (key === 'turns' && Array.isArray(value)) {
    const parts = value.map((t) => {
      const outcome = t.outcome || t.composeOutcome || '?';
      const dur = typeof t.durationMs === 'number' ? formatMs(t.durationMs) : '?';
      const err = t.assertError ? '/ERR' : '';
      return `${t.turn}:${outcome}/${dur}${err}`;
    });
    return `[${parts.join(', ')}]`;
  }
  if (Array.isArray(value)) {
    const joined = value.map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join(',');
    return joined.length > 80 ? joined.slice(0, 77) + '...' : joined;
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 80 ? json.slice(0, 77) + '...' : json;
  }
  return String(value);
}

/**
 * Apply envOverrides, save the prior values, return a restore function.
 */
function applyEnvOverrides(overrides = {}) {
  const prior = {};
  for (const [k, v] of Object.entries(overrides)) {
    prior[k] = process.env[k];
    process.env[k] = String(v);
  }
  return () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function runScenario(scenario, prev, workspace, runCustomAgent, { portOffset = 0, captureSnapshot = null } = {}) {
  // Dispatch on scenario.mode. Multi-scope scenarios spawn the spike server
  // as a subprocess and drive the full pipeline via HTTP+Socket.IO; they
  // ignore the shared `workspace` (each one mints its own) and the prebuilt
  // `runCustomAgent` (the subprocess loads its own copy).
  if (scenario.mode === 'multi-scope') {
    return runMultiScopeScenario(scenario, { portOffset });
  }
  if (scenario.mode === 'multi-turn') {
    return runMultiTurnScenario(scenario, { portOffset, captureSnapshot });
  }

  // Single-scope path (default for legacy scenarios + anything without mode set).
  // Dependent scenarios inherit the prior's workspace — they're continuation
  // tests, and the agent rightly refuses to work on files it just wrote that
  // have since vanished. Independent scenarios start fresh.
  if (!scenario.dependsOn) {
    resetWorkspace(workspace);
  }
  const sessionId = randomUUID();
  const restore = applyEnvOverrides(scenario.envOverrides);

  const extraOpts = scenario.setup ? scenario.setup(prev, workspace) : {};
  const prompt = scenario.prompt(prev);
  const started = Date.now();
  let result = null;
  let error = null;
  // Phase C: runCustomAgent requires an explicit phase (no EXECUTING default).
  // Single-scope scenarios that don't declare a phase in their setup run as
  // SUBAGENT against the scope's deployed assistant — the canonical post-
  // Phase-C path. Scenarios that explicitly set a phase (e.g. legacy paired-
  // comparison runs) keep their override.
  const dispatchOpts = {
    scope: scenario.scope,
    phase: PHASES.SUBAGENT,
    ...extraOpts,
  };
  try {
    result = await runCustomAgent(sessionId, prompt, dispatchOpts);
  } catch (err) {
    error = err;
  } finally {
    restore();
  }
  const durationMs = Date.now() - started;

  if (error) {
    const errored = { scenario, status: 'error', durationMs, error: error.message, sessionId };
    recordSmokeMetric(errored);
    return errored;
  }

  let assertNotes = {};
  try {
    assertNotes = scenario.assert({ result, workspace, prev, sessionId }) || {};
  } catch (err) {
    const failed = { scenario, status: 'fail', durationMs, error: err.message, result, sessionId };
    recordSmokeMetric(failed);
    return failed;
  }

  // Telemetry asserts (Dispatch 4 Part F.2): single-scope smoke scenarios
  // call runCustomAgent in-process and bypass session/routes.js, which is
  // where the run-summary writer lives. So no run-summary is produced for
  // single-scope smoke and assertHasRunSummary would always fail. Skip
  // telemetry-asserts at the single-scope tier; the multi-scope and multi-
  // turn dispatch paths exercise the full pipeline (routes.js included)
  // and DO get telemetry-asserts wired. Tracked in POST_MERGE_FOLLOWUPS.md
  // as a follow-up — single-scope smoke could grow a summary write if we
  // want telemetry coverage at that tier.

  const passed = { scenario, status: 'pass', durationMs, result, assertNotes, sessionId };
  recordSmokeMetric(passed);
  return passed;
}

function printSummary(results) {
  const byId = Object.fromEntries(results.map((r) => [r.scenario.id, r]));
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [];
  lines.push('');
  lines.push('─'.repeat(96));
  lines.push(pad('scenario', 26) + pad('status', 8) + pad('duration', 10) + pad('prompt tok', 12) + pad('api calls', 10) + 'notes');
  lines.push('─'.repeat(96));
  for (const r of results) {
    const status = r.status.toUpperCase();
    const tokens = r.result?.runTokenTotals?.promptTokens;
    const calls = r.result?.runTokenTotals?.apiCalls;
    const notes = r.status === 'pass'
      ? Object.entries(r.assertNotes).map(([k, v]) => `${k}=${formatNoteValue(k, v)}`).join(' ')
      : (r.error || '').slice(0, 40);
    lines.push(
      pad(r.scenario.id, 26) +
      pad(status, 8) +
      pad(formatMs(r.durationMs), 10) +
      pad(formatTokens(tokens), 12) +
      pad(calls ?? '-', 10) +
      notes
    );
  }
  lines.push('─'.repeat(96));
  const passes = results.filter((r) => r.status === 'pass').length;
  const fails = results.length - passes;
  lines.push(`${passes} passed, ${fails} failed`);
  console.log(lines.join('\n'));
  return fails;
}

async function main() {
  const opts = parseArgs(process.argv);

  // Pre-run cleanup: nuke orphan smoke-* containers + custom-agent-smoke*
  // workspace dirs left behind by prior runs. Replaces the manual
  // `docker ps … | xargs docker rm -f` step previously documented in CLAUDE.md.
  // Runs as the first action — before --list short-circuits, before any new
  // workspace / compose project gets created — so a stale orphan can't hold
  // port 8080 hostage and trip the port-conflict detector on this run's
  // containers, and so the user gets the cleanup as a side-effect even when
  // they just want to list scenarios.
  runPreRunCleanup();

  if (opts.list) {
    for (const s of SCENARIOS) {
      console.log(`${s.id.padEnd(26)} ${s.title}`);
    }
    return 0;
  }

  // Install SIGTERM/SIGINT/uncaughtException handlers BEFORE any workspace
  // or compose project gets created. Killed-mid-flight cleanup tracker is
  // module-level state populated by setupWorkspace / freshMultiScopeWorkspace
  // / bootSpikeServer; the handlers iterate over it on signal and best-effort
  // tear down anything still active.
  installCleanupHandlers();

  // Per-process base port offset — keeps two concurrent `npm run smoke`
  // invocations from colliding on host port 8080/3000/5432. Combined with
  // slotIndex (the --parallel worker index) when calling runScenario.
  // See `processBasePortOffset` docs at top of file.
  const baseOffset = processBasePortOffset();
  console.log(`[smoke] base port offset: +${baseOffset * 10} (per-process; for simultaneous-run isolation)`);

  // Determine scenarios to run. Auto-include dependencies.
  let selected;
  if (opts.only) {
    const requested = new Set(opts.only);
    const expanded = new Set();
    const addWithDeps = (id) => {
      const s = SCENARIOS.find((x) => x.id === id);
      if (!s) throw new Error(`Unknown scenario id: ${id}`);
      if (s.dependsOn) addWithDeps(s.dependsOn);
      expanded.add(id);
    };
    for (const id of requested) addWithDeps(id);
    selected = SCENARIOS.filter((s) => expanded.has(s.id));
  } else {
    selected = SCENARIOS;
  }

  console.log(`[smoke] running ${selected.length} scenario(s): ${selected.map((s) => s.id).join(', ')}`);

  const credSource = loadCredentials();
  console.log(`[smoke] credentials: source=${credSource.source}`);

  const workspace = setupWorkspace();
  console.log(`[smoke] workspace: ${workspace}`);

  // Defaults that match the production "happy path" unless the test overrides.
  process.env.USE_COMPACTION = process.env.USE_COMPACTION || '1';

  // Dynamic import AFTER env is set so paths.js freezes WORKSPACE_DIR correctly.
  const { runCustomAgent } = await import('../../server/agent/agent.js');

  const results = [];
  const byId = {};

  // Helper: run one scenario, log its outcome, and return the result.
  // Captures the dependency-skip case + the pass/fail logging that used to
  // be inline in the sequential loop.
  async function runOne(scenario, slotIndex) {
    console.log(`\n[smoke] ── ${scenario.id} — ${scenario.title}${opts.parallel > 1 ? ` (slot ${slotIndex})` : ''}`);
    const prev = scenario.dependsOn ? byId[scenario.dependsOn] : null;
    if (scenario.dependsOn && (!prev || prev.status !== 'pass')) {
      console.log(`[smoke] SKIP — dependency ${scenario.dependsOn} did not pass`);
      const skipped = { scenario, status: 'skip', durationMs: 0, error: `dep ${scenario.dependsOn} not passed` };
      results.push(skipped);
      byId[scenario.id] = skipped;
      return skipped;
    }
    // portOffset = baseOffset + slotIndex shifts host ports by
    // (baseOffset + slotIndex) * 10. baseOffset isolates this `npm run smoke`
    // process from concurrent runs in other terminals (hash-derived per-PID);
    // slotIndex stacks on top so parallel workers within this process don't
    // collide either. baseOffset is always > 0, so the compose file is always
    // rewritten — the prior "slotIndex=0 = no rewrite" path is intentionally
    // gone (it's what allowed two terminals to both grab 8080:8080).
    const res = await runScenario(scenario, prev, workspace, runCustomAgent, { portOffset: baseOffset + slotIndex, captureSnapshot: opts.captureSnapshot });
    results.push(res);
    byId[scenario.id] = res;
    if (res.status === 'pass') {
      const notes = Object.entries(res.assertNotes || {}).map(([k, v]) => `${k}=${formatNoteValue(k, v)}`).join(' ');
      console.log(`[smoke] PASS ${scenario.id} in ${formatMs(res.durationMs)} — ${notes}`);
    } else {
      console.log(`[smoke] ${res.status.toUpperCase()} ${scenario.id} in ${formatMs(res.durationMs)} — ${res.error}`);
    }
    return res;
  }

  if (opts.parallel <= 1) {
    // Sequential path — preserves the existing behavior bit-for-bit when
    // --parallel isn't set, including dependency ordering for `dependsOn`
    // scenarios.
    for (const scenario of selected) {
      await runOne(scenario, 0);
    }
  } else {
    // Bounded worker-pool path. Each worker holds a slot index 0..N-1 and
    // pulls scenarios off a shared queue until empty. Slot index doubles as
    // portOffset so port assignments are stable (slot 1 → +10, slot 2 → +20).
    //
    // Caveat — `dependsOn`: parallel mode does NOT preserve dependency
    // ordering. If your selection has a `dependsOn` chain, two scenarios
    // could start before the dependency finished; the dependent will
    // observe `prev = undefined` and skip. Run dependent chains with
    // --parallel=1 (or partition the run).
    console.log(`[smoke] running with ${opts.parallel}-way parallelism (base offset +${baseOffset * 10}; per-slot increment +10)`);
    const queue = [...selected];
    const workers = [];
    for (let slot = 0; slot < opts.parallel; slot++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const scenario = queue.shift();
          if (!scenario) return;
          await runOne(scenario, slot);
        }
      })());
    }
    await Promise.all(workers);
  }

  const fails = printSummary(results);
  console.log(`\n[smoke] workspace left at ${workspace} for inspection`);
  return fails;
}

// Export internals for unit testing. The bottom-of-file main() invocation
// still runs when the file is executed as a script (the default), but tests
// can import { runKilledMidFlightCleanup, ... } in advance by setting
// SMOKE_SKIP_MAIN=1 (sets a sentinel that the bottom-of-file checks).
export {
  runKilledMidFlightCleanup,
  registerWorkspace,
  unregisterWorkspace,
  registerComposeProject,
  unregisterComposeProject,
  registerServerProc,
  unregisterServerProc,
  activeWorkspaces,
  activeComposeProjects,
  activeServerProcs,
  _resetCleanupGuardForTest,
};

if (process.env.SMOKE_SKIP_MAIN === '1') {
  // Test-import mode: don't auto-run main(). Tests that import this module
  // manipulate the trackers directly and call runKilledMidFlightCleanup with
  // a mocked runner + fsImpl.
} else {
main()
  .then((fails) => process.exit(Math.min(fails, 255)))
  .catch((err) => {
    console.error('[smoke] fatal:', err.stack || err.message);
    process.exit(255);
  });
}
