// extract-routes-runtime.js — get the backend's REAL route table by loading the
// app and reading the framework's own router (Express) / route list (FastAPI),
// instead of statically parsing source. This is the route-coverage analog of
// the SQL PREPARE gate: ask the real authority, don't pattern-match code.
//
// Node: compile the backend (tsc) then run dump-express-routes.mjs, which
//   imports the entry with `listen()` stubbed-and-capturing, so it sees the
//   fully-configured app — every route, however it was registered (app.get, a
//   mounted Router, or a helper like `mountCsvExport(app, '/p', fn)`).
// Python: run dump_fastapi_routes.py, which reads app.routes natively.
//
// FULLY FAIL-OPEN: missing deps, build failure, an app that won't import, no
// detectable entry → returns null. The caller treats null as "introspection
// unavailable" and never hard-blocks coverage on it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { detectRuntime } from './type-gate.js';
import { tlog } from '../util/timestamped-log.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPRESS_DUMPER = path.join(HERE, 'route-introspect', 'dump-express-routes.mjs');
const FASTAPI_DUMPER = path.join(HERE, 'route-introspect', 'dump_fastapi_routes.py');
const MARKER = '__DD_ROUTES__';

function parseMarker(stdout) {
  const i = stdout.lastIndexOf(MARKER);
  if (i < 0) return null;
  let rest = stdout.slice(i + MARKER.length);
  const nl = rest.indexOf('\n');
  if (nl >= 0) rest = rest.slice(0, nl);
  try {
    const arr = JSON.parse(rest);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// Find the entry the `start` script runs (it's the file that calls listen),
// falling back to common compiled-output locations.
function resolveNodeEntry(backendDir) {
  let start = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(backendDir, 'package.json'), 'utf-8'));
    start = pkg.scripts?.start || '';
  } catch { /* none */ }
  const m = start.match(/node\s+(\S+\.[mc]?js)/);
  const candidates = [
    m && m[1],
    'dist/index.js', 'dist/src/index.js', 'dist/server.js', 'dist/main.js', 'dist/app.js',
  ].filter(Boolean);
  for (const c of candidates) {
    const abs = path.join(backendDir, c);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

async function buildNode(backendDir) {
  // Prefer the project's own build; fall back to a direct tsc emit. We don't
  // care about the exit code (type errors are the type-gate's job and tsc still
  // emits) — only whether a runnable entry exists afterwards.
  const tscBin = path.join(backendDir, 'node_modules', '.bin', 'tsc');
  try {
    if (fs.existsSync(path.join(backendDir, 'node_modules'))) {
      await execFileP('npm', ['run', 'build'], { cwd: backendDir, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    }
  } catch {
    try {
      if (fs.existsSync(tscBin)) {
        await execFileP(tscBin, ['-p', 'tsconfig.json'], { cwd: backendDir, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      }
    } catch { /* tsc emitted-with-errors or failed → check entry below */ }
  }
}

async function introspectNode(backendDir) {
  if (!fs.existsSync(backendDir)) return null;
  await buildNode(backendDir);
  const entry = resolveNodeEntry(backendDir);
  if (!entry) return null;
  try {
    const { stdout } = await execFileP('node', [EXPRESS_DUMPER, entry], {
      cwd: backendDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    return parseMarker(stdout);
  } catch (err) {
    // dumper exited non-zero (nothing captured) but may still have emitted the
    // marker before exit — try the captured output.
    return parseMarker(err.stdout?.toString() || '') ;
  }
}

// Locate the module:attr that defines the FastAPI app (e.g. "main:app").
function resolveFastApiTarget(backendDir) {
  const skip = new Set(['__pycache__', 'venv', '.venv', 'node_modules']);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { const r = walk(abs); if (r) return r; }
      else if (e.isFile() && e.name.endsWith('.py')) {
        let txt; try { txt = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
        const m = txt.match(/(\w+)\s*=\s*FastAPI\s*\(/);
        if (m) {
          const rel = path.relative(backendDir, abs).replace(/\.py$/, '').replace(/[/\\]/g, '.');
          return `${rel}:${m[1]}`;
        }
      }
    }
    return null;
  };
  return walk(backendDir);
}

async function introspectPython(backendDir) {
  if (!fs.existsSync(backendDir)) return null;
  const target = resolveFastApiTarget(backendDir);
  if (!target) return null;
  try {
    const { stdout } = await execFileP('python3', [FASTAPI_DUMPER, backendDir, target], {
      cwd: backendDir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    return parseMarker(stdout);
  } catch (err) {
    return parseMarker(err.stdout?.toString() || '');
  }
}

/**
 * @param {string} workspaceDir
 * @returns {Promise<Array<{method:string, path:string}>|null>} the real route
 *   table, or null when introspection is unavailable (fail-open).
 */
export async function extractRuntimeRoutes(workspaceDir) {
  const backendDir = path.join(workspaceDir, 'backend');
  const runtime = detectRuntime(workspaceDir, 'backend');
  try {
    const routes = runtime === 'python'
      ? await introspectPython(backendDir)
      : await introspectNode(backendDir);
    if (Array.isArray(routes)) {
      tlog('[route-introspect] %s backend → %d route(s) from the live router table', runtime || 'node', routes.length);
      return routes;
    }
  } catch (err) {
    tlog('[route-introspect] unavailable (fail-open): %s', (err.message || '').slice(0, 120));
  }
  return null;
}
