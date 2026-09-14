import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from './paths.js';
import { broadcastEvent, connectedClientCount } from '../util/stream.js';
import { tlog, terr } from '../util/timestamped-log.js';

// Keeps a running harness current with the template. The codespace start hook
// already checks, applies, commits and pushes; this repeats the same check while
// the harness is up so a project does not have to sleep to receive a release.
// Applies only when nothing is being built, and if the harness itself changed
// it rebuilds and restarts (clients see a short notice and reload).
//
// Off switches: HARNESS_TEMPLATE_UPDATE=0 (env) or the repo marker
// .template-auto-update-disabled (which also stops the start hook).

const INTERVAL_MS = Number(process.env.HARNESS_TEMPLATE_UPDATE_MS) || 30 * 60_000;
const FIRST_CHECK_MS = 5 * 60_000;
const SCRIPT_TIMEOUT_MS = 10 * 60_000;
const UPDATE_SCRIPT = path.join(WORKSPACE_DIR, '.devcontainer', 'auto-update-template.sh');
const CHECK_SCRIPT = path.join(WORKSPACE_DIR, 'scripts', 'check-updates.sh');
const HARNESS_DIR = path.join(WORKSPACE_DIR, 'chat');
const HARNESS_WATCH = ['server', 'src', 'package.json', 'index.html'];

let running = false;
// A built update waiting for a restart while tabs are open.
let pendingRestart = null;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: WORKSPACE_DIR, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, ...opts },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// Newest mtime under the harness sources: cheap way to see whether the sync
// touched the code this process is running.
function harnessFingerprint() {
  let newest = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (name === 'node_modules' || name === 'dist') continue;
        walk(path.join(p, name));
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  for (const rel of HARNESS_WATCH) walk(path.join(HARNESS_DIR, rel));
  return newest;
}

function restartSelf() {
  const log = openSync('/tmp/harness.log', 'a');
  const child = spawn('sh', ['-c', 'sleep 2; exec node server/index.js'], {
    cwd: HARNESS_DIR,
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  tlog('[template-update] restarting the harness on the updated code');
  setTimeout(() => process.exit(0), 500);
}

/**
 * Check for a template release and apply it (the start-hook script does the
 * sync, commit and push). Rebuilds the client when harness files changed and
 * reports whether a restart is needed; the caller decides when to restart.
 * @returns {Promise<{ updated: boolean, version: string|null, restarting: boolean, reason?: string }>}
 */
export async function runTemplateUpdate({ isBusy } = {}) {
  const idle = { updated: false, version: null, restarting: false };
  if (running) return { ...idle, reason: 'already-running' };
  if (existsSync(path.join(WORKSPACE_DIR, '.template-auto-update-disabled'))) return { ...idle, reason: 'disabled' };
  if (typeof isBusy === 'function' && isBusy()) return { ...idle, reason: 'busy' };
  if (!existsSync(UPDATE_SCRIPT) || !existsSync(CHECK_SCRIPT)) return { ...idle, reason: 'no-scripts' };
  running = true;
  try {
    const check = await run('bash', [CHECK_SCRIPT]);
    const result = check.stdout.trim();
    if (!result.startsWith('UPDATE_AVAILABLE')) return { ...idle, reason: 'up-to-date' };
    const [, current, latest] = result.split('|');
    tlog('[template-update] %s -> %s available; applying', current, latest);

    const before = harnessFingerprint();
    const apply = await run('bash', [UPDATE_SCRIPT]);
    if (!apply.ok) {
      terr('[template-update] update script failed: %s', (apply.stderr || apply.stdout).slice(-400));
      return { ...idle, reason: 'apply-failed' };
    }
    const harnessChanged = harnessFingerprint() !== before;
    tlog('[template-update] applied %s (harness files changed: %s)', latest, harnessChanged ? 'yes' : 'no');
    if (!harnessChanged) return { updated: true, version: latest, restarting: false };

    const build = await run('npm', ['run', 'build', '--silent'], { cwd: HARNESS_DIR });
    if (!build.ok) {
      terr('[template-update] client build failed; keeping the running harness: %s', (build.stderr || build.stdout).slice(-400));
      return { updated: true, version: latest, restarting: false, reason: 'build-failed' };
    }
    pendingRestart = { version: latest };
    return { updated: true, version: latest, restarting: true };
  } finally {
    running = false;
  }
}

/** Announce and perform the restart: tabs show a notice and reload afterwards. */
export function restartHarness(version = pendingRestart?.version || null) {
  broadcastEvent({ ts: Date.now(), type: 'harness_updating', payload: { version } });
  pendingRestart = null;
  setTimeout(restartSelf, 300);
}

/** The update that is built and waiting for a restart, if any. */
export function pendingHarnessRestart() {
  return pendingRestart;
}

// Restart on its own only when nobody has the harness open; with tabs open
// the update is announced and the restart waits for a quiet check or the
// user's click. A user mid-thought never gets reloaded under their hands.
async function tick({ isBusy }) {
  const r = await runTemplateUpdate({ isBusy });
  if (!pendingRestart) return;
  if (connectedClientCount() === 0) {
    restartHarness();
  } else if (r.restarting) {
    broadcastEvent({ ts: Date.now(), type: 'harness_update_ready', payload: { version: pendingRestart.version } });
  }
}

export function startTemplateAutoUpdate({ isBusy }) {
  if (process.env.HARNESS_TEMPLATE_UPDATE === '0') return false;
  // Only meaningful inside a project codespace (the start hook, git identity
  // and push rights all come from there); local template development opts in.
  if (!existsSync('/.codespaces') && process.env.HARNESS_TEMPLATE_UPDATE !== '1') return false;
  if (!existsSync(UPDATE_SCRIPT) || !existsSync(CHECK_SCRIPT)) return false;
  const busy = typeof isBusy === 'function' ? isBusy : () => false;
  setTimeout(() => void tick({ isBusy: busy }), FIRST_CHECK_MS).unref();
  setInterval(() => void tick({ isBusy: busy }), INTERVAL_MS).unref();
  tlog('[template-update] periodic check every %d min', Math.round(INTERVAL_MS / 60_000));
  return true;
}
