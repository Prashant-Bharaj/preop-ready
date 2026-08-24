/**
 * W3.TYPES.GATE — Compile-time type-gate (HARNESS_EVOLUTION.md §O).
 *
 * Wired as the FIRST detector in `runAutoRecovery()` (before the existing
 * structural-checks / file-structure-check / runtime-asserts detectors).
 * Why first: `tsc --noEmit` / `mypy --strict` complete in <5s on a
 * populated workspace, vs 60-90s for `docker compose up`. When a
 * subagent emits attempt_completion but the code still has type drift
 * (stale handler signatures, ghost imports, wrong `req.params` shape,
 * unused vars under strict mode), this gate catches it BEFORE downstream
 * detectors burn wall-clock OR a compose build burns 4+ minutes.
 *
 * Per-scope dispatch:
 *
 *   scope=backend → Node-TS  (when backend/tsconfig.json present)
 *                 → Python   (when backend/main.py + backend/mypy.ini present)
 *   scope=frontend → Frontend-TS (when frontend/tsconfig.json present)
 *   other scopes (database/vectordb/integration) → no-op
 *
 * Output shape:
 *
 *   runTypeGate({ workspaceDir, scope, runtime? })
 *     → { hasErrors: bool, formatted: string, errorCount: number,
 *         durationMs: number, runtime: string | null,
 *         skipped?: bool, skipReason?: string }
 *
 * The `formatted` string becomes the spawn-message context for the
 * fix-dispatch subagent. It is:
 *   - per-file capped at MAX_ERRORS_PER_FILE entries (default 10)
 *   - each error shown with 1 line of source context above + below
 *   - total bytes capped at MAX_TYPE_ERROR_CONTEXT_BYTES (8 KB) so the
 *     agent's prompt budget stays bounded
 *   - stripped of ANSI color codes
 *
 * Best-effort posture per L.5: telemetry writes wrap in `logAndSwallow`;
 * any internal parsing crash falls open (returns `{ hasErrors: false,
 * skipped: true }`) — a broken type-gate must never block a build.
 *
 * When `tsc` / `mypy` are not reachable on PATH or in node_modules, the
 * gate soft-skips with `skipped: true, skipReason: '...'`. The caller
 * treats a soft-skip as "no type-errors detected this round" and falls
 * through to the existing downstream detectors.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { logAndSwallow } from '../util/log-helpers.js';
import {
  TYPE_GATE_TIMEOUT_MS,
  MAX_TYPE_ERROR_CONTEXT_BYTES,
} from '../config/defaults.js';

// Per-file cap on rendered errors. tsc cascades produce dozens of
// follow-on errors from one root cause; the first ~10 carry the signal.
const MAX_ERRORS_PER_FILE = 10;

// ── Runtime detection ────────────────────────────────────────────────────

/**
 * Detect which type-checker (if any) to run for a given scope. The
 * combination of scope × workspace files determines the runtime:
 *
 *   backend + backend/tsconfig.json + (backend/src/index.ts | index.js)
 *     → 'node'
 *   backend + backend/main.py + (backend/mypy.ini | backend/pyproject.toml)
 *     → 'python'
 *   frontend + frontend/tsconfig.json
 *     → 'frontend'
 *
 * Returns null for scopes that aren't type-checked (database, vectordb,
 * integration) or when the necessary files are missing.
 */
export function detectRuntime(workspaceDir, scope) {
  if (scope === 'backend') {
    const tsconfig = path.join(workspaceDir, 'backend', 'tsconfig.json');
    const indexTs = path.join(workspaceDir, 'backend', 'src', 'index.ts');
    const indexJs = path.join(workspaceDir, 'backend', 'src', 'index.js');
    if (existsSync(tsconfig) && (existsSync(indexTs) || existsSync(indexJs))) {
      return 'node';
    }
    const mainPy = path.join(workspaceDir, 'backend', 'main.py');
    const mypyIni = path.join(workspaceDir, 'backend', 'mypy.ini');
    const pyproject = path.join(workspaceDir, 'backend', 'pyproject.toml');
    if (existsSync(mainPy) && (existsSync(mypyIni) || existsSync(pyproject))) {
      return 'python';
    }
    return null;
  }
  if (scope === 'frontend') {
    const tsconfig = path.join(workspaceDir, 'frontend', 'tsconfig.json');
    if (existsSync(tsconfig)) {
      return 'frontend';
    }
    return null;
  }
  return null;
}

// ── Binary resolution ────────────────────────────────────────────────────

/**
 * Locate a `tsc` binary the harness can run for the given scope's
 * tsconfig. Mirrors the pattern in contract-types-generator.js but
 * targets the scope directory's own node_modules first so it picks up
 * the user-app's pinned TypeScript version.
 *
 * Returns `{ cmd, args }` or null when nothing reachable.
 */
function resolveTscFor(workspaceDir, scopeDir) {
  const localBin = path.join(workspaceDir, scopeDir, 'node_modules', '.bin', 'tsc');
  if (existsSync(localBin)) return { cmd: localBin, args: [] };
  const otherBin = path.join(
    workspaceDir,
    scopeDir === 'backend' ? 'frontend' : 'backend',
    'node_modules', '.bin', 'tsc'
  );
  if (existsSync(otherBin)) return { cmd: otherBin, args: [] };
  try {
    execFileSync('tsc', ['--version'], { stdio: 'ignore', timeout: 3_000 });
    return { cmd: 'tsc', args: [] };
  } catch {
    return null;
  }
}

/**
 * Locate `mypy`. Python's stdlib doesn't ship it so it's PATH-only in
 * normal venvs; the user-app's Dockerfile.python image bundles it, but
 * for the host-side gate we rely on the developer's PATH or the
 * canonical `dd-kitchen-sink` base providing it.
 */
function resolveMypy() {
  try {
    execFileSync('mypy', ['--version'], { stdio: 'ignore', timeout: 3_000 });
    return { cmd: 'mypy', args: [] };
  } catch {
    return null;
  }
}

// ── tsc / mypy parsing ───────────────────────────────────────────────────

/**
 * Strip ANSI color codes. tsc honors --pretty by default in TTY; even
 * over pipes it sometimes emits SGR sequences. We strip eagerly so the
 * formatted output is plain text suitable for prompt injection.
 *
 * Compatible with both ESC=\x1b and 0x9b CSI; deliberately conservative
 * regex (only the SGR + cursor sequences tsc/mypy actually emit).
 */
function stripAnsi(s) {
  if (!s) return '';
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Parse tsc --noEmit stderr/stdout into structured errors.
 *
 * tsc format:
 *   path/to/file.ts(LINE,COL): error TS####: message
 *   path/to/file.ts(LINE,COL): error TS####: message that may
 *     wrap across lines and is then indented.
 *
 * @param {string} rawOutput
 * @returns {Array<{ file, line, col, code, message }>}
 */
export function parseTscOutput(rawOutput) {
  const errors = [];
  if (!rawOutput) return errors;
  const clean = stripAnsi(rawOutput);
  const re = /^([^()\n]+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
  for (const line of clean.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    errors.push({
      file: m[1].trim(),
      line: Number(m[2]),
      col: Number(m[3]),
      code: m[4],
      message: m[5].trim(),
    });
  }
  return errors;
}

/**
 * Parse mypy --strict output into structured errors.
 *
 * mypy format (no --pretty):
 *   path/to/file.py:LINE: error: message  [error-code]
 *   path/to/file.py:LINE:COL: error: message  [error-code]
 *
 * @param {string} rawOutput
 * @returns {Array<{ file, line, col, code, message }>}
 */
export function parseMypyOutput(rawOutput) {
  const errors = [];
  if (!rawOutput) return errors;
  const clean = stripAnsi(rawOutput);
  // Match both `file:line:col:` and `file:line:` variants.
  const re = /^([^\s:][^:\n]*):(\d+)(?::(\d+))?:\s+error:\s+(.+?)(?:\s+\[([a-z0-9-]+)\])?\s*$/i;
  for (const line of clean.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    errors.push({
      file: m[1].trim(),
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : 0,
      code: m[5] || '',
      message: m[4].trim(),
    });
  }
  return errors;
}

// ── Formatter ────────────────────────────────────────────────────────────

/**
 * Render parsed type errors into a prompt-friendly block. Groups by
 * file, caps per-file errors, includes 1 line of source context above
 * and below each error, and stops growing the output once the total
 * byte count would exceed MAX_TYPE_ERROR_CONTEXT_BYTES.
 *
 * @param {object} args
 * @param {string} args.scope
 * @param {'node'|'python'|'frontend'} args.runtime
 * @param {string} args.rawOutput - raw tsc/mypy combined stdout+stderr
 * @param {string} args.workspaceDir
 * @returns {{ hasErrors: bool, summary: string, formatted: string, errorCount: number }}
 */
export function formatTypeErrors({ scope, runtime, rawOutput, workspaceDir }) {
  const errors = runtime === 'python'
    ? parseMypyOutput(rawOutput)
    : parseTscOutput(rawOutput);

  if (errors.length === 0) {
    return { hasErrors: false, summary: '', formatted: '', errorCount: 0 };
  }

  // Group by file (preserve first-seen order so the agent reads errors
  // in the order tsc/mypy reported them).
  const byFile = new Map();
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }

  const checker = runtime === 'python' ? 'mypy --strict' : 'tsc --noEmit';
  const header = `=== AUTO-RECOVERY — ${scope.toUpperCase()} TYPE-GATE FAILURES ===`;
  const summary =
    `${checker} found ${errors.length} error(s) across ${byFile.size} file(s) in ${scope}. ` +
    `Fix each one and emit attempt_completion. The harness re-runs the type-gate before downstream checks.`;

  const sections = [header, '', summary, ''];
  let truncated = false;
  let renderedCount = 0;

  // Track byte budget eagerly so we stop at file boundary, not mid-error.
  let usedBytes = sections.join('\n').length + 1;

  outer:
  for (const [file, fileErrors] of byFile) {
    const showCount = Math.min(fileErrors.length, MAX_ERRORS_PER_FILE);
    const overflow = fileErrors.length - showCount;

    // Best-effort source read for context lines.
    let sourceLines = null;
    try {
      const absPath = path.isAbsolute(file)
        ? file
        : path.join(workspaceDir, file);
      if (existsSync(absPath)) {
        sourceLines = readFileSync(absPath, 'utf-8').split('\n');
      }
    } catch (err) {
      logAndSwallow(err, '[type-gate] failed to read source for context');
    }

    const fileBlock = [`--- ${file} ---`];
    for (let i = 0; i < showCount; i++) {
      const e = fileErrors[i];
      const head = e.code
        ? `${file}(${e.line},${e.col}): error ${e.code}: ${e.message}`
        : `${file}(${e.line},${e.col}): error: ${e.message}`;
      fileBlock.push(head);
      if (sourceLines) {
        const idx = e.line - 1;
        const before = idx > 0 ? sourceLines[idx - 1] : null;
        const at = sourceLines[idx] != null ? sourceLines[idx] : null;
        const after = idx + 1 < sourceLines.length ? sourceLines[idx + 1] : null;
        if (before != null) fileBlock.push(`  ${String(e.line - 1).padStart(4)} | ${before}`);
        if (at != null)     fileBlock.push(`  ${String(e.line).padStart(4)} | ${at}`);
        if (after != null)  fileBlock.push(`  ${String(e.line + 1).padStart(4)} | ${after}`);
      }
      fileBlock.push('');
      renderedCount++;
    }
    if (overflow > 0) {
      fileBlock.push(`… and ${overflow} more error(s) in this file`);
      fileBlock.push('');
    }

    const blockBytes = fileBlock.join('\n').length + 1;
    if (usedBytes + blockBytes > MAX_TYPE_ERROR_CONTEXT_BYTES && sections.length > 4) {
      // Already have at least one file rendered — stop at file boundary.
      truncated = true;
      const remaining = errors.length - renderedCount;
      if (remaining > 0) {
        sections.push(
          `… (additional ${remaining} error(s) across ${byFile.size - renderedCountFiles(sections)} more file(s) ` +
          `truncated to stay within agent context budget; fix the listed errors first then re-run)`
        );
      }
      break outer;
    }
    sections.push(...fileBlock);
    usedBytes += blockBytes;
  }

  if (!truncated && usedBytes > MAX_TYPE_ERROR_CONTEXT_BYTES) {
    // Single oversize file edge case — hard-trim. Keep header + summary,
    // truncate the rendered list with an explicit marker.
    const joined = sections.join('\n');
    const trimmed = joined.slice(0, MAX_TYPE_ERROR_CONTEXT_BYTES - 200);
    return {
      hasErrors: true,
      summary,
      formatted: trimmed +
        `\n\n… (output truncated at ${MAX_TYPE_ERROR_CONTEXT_BYTES} bytes; fix the listed errors first then re-run)\n`,
      errorCount: errors.length,
    };
  }

  return {
    hasErrors: true,
    summary,
    formatted: sections.join('\n'),
    errorCount: errors.length,
  };
}

/**
 * Count how many `--- file ---` headers appear in the sections so far.
 * Used inside formatTypeErrors to compute the "X more files truncated"
 * count without re-grouping.
 */
function renderedCountFiles(sections) {
  let count = 0;
  for (const line of sections) {
    if (typeof line === 'string' && line.startsWith('--- ') && line.endsWith(' ---')) count++;
  }
  return count;
}

// ── Per-runtime checker drivers ──────────────────────────────────────────

/**
 * Run `tsc --noEmit` against the scope's tsconfig. Returns `{ rawOutput,
 * exitCode }`. Soft-skips with `{ skipped: true, reason }` when no tsc
 * reachable.
 */
function runTsc({ workspaceDir, scopeDir, tsconfigPath }) {
  const tsc = resolveTscFor(workspaceDir, scopeDir);
  if (!tsc) {
    return { skipped: true, reason: 'no tsc binary reachable (checked workspace node_modules and PATH)' };
  }
  try {
    execFileSync(
      tsc.cmd,
      [...tsc.args, '--noEmit', '-p', tsconfigPath, '--pretty', 'false'],
      {
        stdio: 'pipe',
        timeout: TYPE_GATE_TIMEOUT_MS,
        encoding: 'utf-8',
        cwd: path.join(workspaceDir, scopeDir),
      }
    );
    return { rawOutput: '', exitCode: 0 };
  } catch (err) {
    // err.status non-zero = tsc reported diagnostics (expected).
    // err.code === 'ETIMEDOUT' = timeout hit.
    if (err.code === 'ETIMEDOUT') {
      return {
        skipped: true,
        reason: `tsc --noEmit exceeded TYPE_GATE_TIMEOUT_MS=${TYPE_GATE_TIMEOUT_MS}ms`,
      };
    }
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    return { rawOutput: stdout + stderr, exitCode: err.status || 1 };
  }
}

/**
 * Run `mypy --strict <backend dir>`. Returns `{ rawOutput, exitCode }`.
 */
function runMypy({ workspaceDir }) {
  const mypy = resolveMypy();
  if (!mypy) {
    return { skipped: true, reason: 'no mypy binary reachable on PATH' };
  }
  const backendDir = path.join(workspaceDir, 'backend');
  try {
    execFileSync(
      mypy.cmd,
      [...mypy.args, '--strict', '--no-color-output', '--show-error-codes', '.'],
      {
        stdio: 'pipe',
        timeout: TYPE_GATE_TIMEOUT_MS,
        encoding: 'utf-8',
        cwd: backendDir,
      }
    );
    return { rawOutput: '', exitCode: 0 };
  } catch (err) {
    if (err.code === 'ETIMEDOUT') {
      return {
        skipped: true,
        reason: `mypy --strict exceeded TYPE_GATE_TIMEOUT_MS=${TYPE_GATE_TIMEOUT_MS}ms`,
      };
    }
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    return { rawOutput: stdout + stderr, exitCode: err.status || 1 };
  }
}

// ── Top-level entrypoint ─────────────────────────────────────────────────

/**
 * Run the type-gate for one scope. Detects runtime, invokes the matching
 * checker, parses output, formats into a prompt-friendly context block.
 *
 * @param {object} args
 * @param {string} args.workspaceDir
 * @param {string} args.scope - 'backend' | 'frontend' | 'database' | 'vectordb' | 'integration'
 * @param {string} [args.runtime] - explicit override; auto-detected when omitted
 * @returns {Promise<{ hasErrors: bool, formatted: string, errorCount: number, durationMs: number, runtime: string | null, skipped?: bool, skipReason?: string }>}
 */
export async function runTypeGate({ workspaceDir, scope, runtime }) {
  const t0 = Date.now();
  const resolved = runtime || detectRuntime(workspaceDir, scope);
  if (!resolved) {
    return {
      hasErrors: false,
      formatted: '',
      errorCount: 0,
      durationMs: Date.now() - t0,
      runtime: null,
      skipped: true,
      skipReason: `scope=${scope} has no type-checked runtime in workspace`,
    };
  }

  let result;
  try {
    if (resolved === 'node') {
      result = runTsc({
        workspaceDir,
        scopeDir: 'backend',
        tsconfigPath: path.join(workspaceDir, 'backend', 'tsconfig.json'),
      });
    } else if (resolved === 'frontend') {
      result = runTsc({
        workspaceDir,
        scopeDir: 'frontend',
        tsconfigPath: path.join(workspaceDir, 'frontend', 'tsconfig.json'),
      });
    } else if (resolved === 'python') {
      result = runMypy({ workspaceDir });
    } else {
      result = { skipped: true, reason: `unsupported runtime: ${resolved}` };
    }
  } catch (err) {
    logAndSwallow(err, `[type-gate] runtime=${resolved} threw`);
    return {
      hasErrors: false,
      formatted: '',
      errorCount: 0,
      durationMs: Date.now() - t0,
      runtime: resolved,
      skipped: true,
      skipReason: `type-gate internal error: ${err.message}`,
    };
  }

  if (result.skipped) {
    return {
      hasErrors: false,
      formatted: '',
      errorCount: 0,
      durationMs: Date.now() - t0,
      runtime: resolved,
      skipped: true,
      skipReason: result.reason,
    };
  }

  if (result.exitCode === 0 || !result.rawOutput.trim()) {
    return {
      hasErrors: false,
      formatted: '',
      errorCount: 0,
      durationMs: Date.now() - t0,
      runtime: resolved,
    };
  }

  const formatted = formatTypeErrors({
    scope,
    runtime: resolved,
    rawOutput: result.rawOutput,
    workspaceDir,
  });

  return {
    hasErrors: formatted.hasErrors,
    formatted: formatted.formatted,
    errorCount: formatted.errorCount,
    durationMs: Date.now() - t0,
    runtime: resolved,
  };
}
