#!/usr/bin/env node
/**
 * dev.js — Local development launcher
 *
 * Starts both the Express backend and the Vite frontend in a single terminal
 * with colour-coded, prefixed output so you can tell them apart.
 *
 * Usage:
 *   node dev.js
 *
 * Ports:
 *   Backend  (Express)  → http://localhost:3000
 *   Frontend (Vite)     → http://localhost:5173
 *
 * Stop with Ctrl+C — both processes are killed cleanly.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── ANSI colour helpers ──────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';

function tag(label, colour) {
  return `${BOLD}${colour}[${label}]${RESET}`;
}

function prefixLines(data, prefix) {
  return data
    .toString()
    .split('\n')
    .filter(line => line.trim())          // drop blank lines
    .map(line => `${prefix} ${line}`)
    .join('\n');
}

// ── Process definitions ──────────────────────────────────────────────────────
const procs = [
  {
    label:   'server',
    colour:  CYAN,
    // Use --watch for auto-restart on file changes (Node 18+)
    // Falls back to plain node if --watch causes issues
    cmd:     process.execPath,
    args:    ['--watch', 'server/index.js'],
    ready:   /listening|started|ready|port/i,
    readyMsg: `${BOLD}${CYAN}[server]${RESET} Backend ready → ${BOLD}http://localhost:3000${RESET}`,
  },
  {
    label:   'client',
    colour:  GREEN,
    cmd:     'npx',
    args:    ['vite', '--clearScreen', 'false'],
    ready:   /Local:\s+http/i,
    readyMsg: `${BOLD}${GREEN}[client]${RESET} Frontend ready → ${BOLD}http://localhost:5173${RESET}`,
  },
];

// ── Spawn helpers ────────────────────────────────────────────────────────────
const children = [];

function spawnProc({ label, colour, cmd, args, ready, readyMsg }) {
  const prefix = tag(label, colour);
  let announced = false;

  // Resolve npx to full path on Windows if needed
  const isWin = process.platform === 'win32';
  const resolvedCmd = (cmd === 'npx' && isWin) ? 'npx.cmd' : cmd;

  const child = spawn(resolvedCmd, args, {
    cwd: __dirname,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  child.stdout.on('data', (data) => {
    const out = prefixLines(data, prefix);
    console.log(out);

    // Detect ready signal (only announce once)
    if (!announced && ready && ready.test(data.toString())) {
      announced = true;
      console.log('\n' + readyMsg + '\n');
    }
  });

  child.stderr.on('data', (data) => {
    // Vite writes normal output to stderr too — treat it the same as stdout
    const out = prefixLines(data, prefix);
    console.log(out);

    if (!announced && ready && ready.test(data.toString())) {
      announced = true;
      console.log('\n' + readyMsg + '\n');
    }
  });

  child.on('error', (err) => {
    console.error(`${tag(label, RED)} Failed to start: ${err.message}`);
    if (err.code === 'ENOENT' && cmd === process.execPath) {
      // --watch flag not available, retry without it
      console.log(`${DIM}[dev] Retrying ${label} without --watch...${RESET}`);
      const fallback = spawn(process.execPath, ['server/index.js'], {
        cwd: __dirname,
        env: { ...process.env, FORCE_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      children.push(fallback);
      fallback.stdout.on('data', d => console.log(prefixLines(d, prefix)));
      fallback.stderr.on('data', d => console.log(prefixLines(d, prefix)));
    } else {
      shutdown(1);
    }
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGINT') return; // expected during shutdown
    if (code !== 0) {
      console.error(`\n${tag(label, RED)} Process exited with code ${code}`);
      shutdown(1);
    }
  });

  children.push(child);
  return child;
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${DIM}[dev] Shutting down...${RESET}`);
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  // Force-kill after 3 s if still running
  setTimeout(() => {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    process.exit(exitCode);
  }, 3000).unref();
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ── Check server entry exists ────────────────────────────────────────────────
const serverEntry = path.join(__dirname, 'server', 'index.js');
if (!existsSync(serverEntry)) {
  console.error(`${RED}[dev] server/index.js not found — is this the right directory?${RESET}`);
  process.exit(1);
}

// ── Banner ───────────────────────────────────────────────────────────────────
console.log(`
${BOLD}${YELLOW}╔══════════════════════════════════════╗
║       Local Dev Environment          ║
╚══════════════════════════════════════╝${RESET}
  ${CYAN}${BOLD}[server]${RESET}  Express backend   → ${BOLD}http://localhost:3000${RESET}
  ${GREEN}${BOLD}[client]${RESET}  Vite frontend      → ${BOLD}http://localhost:5173${RESET}
  ${DIM}Press Ctrl+C to stop both processes${RESET}
`);

// ── Start both processes ─────────────────────────────────────────────────────
for (const p of procs) {
  spawnProc(p);
}
