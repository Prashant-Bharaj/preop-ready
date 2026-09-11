/**
 * W3.TYPES.GATE — type-gate unit tests.
 *
 * Covers:
 *   parseTscOutput      — tsc's `path(line,col): error TS####: message` lines
 *   parseMypyOutput     — mypy's `path:line[:col]: error: message [code]` lines
 *   formatTypeErrors    — per-file truncation + byte cap + source context
 *   runTypeGate         — end-to-end on a temp workspace with a real tsconfig
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseTscOutput,
  parseMypyOutput,
  formatTypeErrors,
  runTypeGate,
  detectRuntime,
} from '../../server/reconciler/type-gate.js';
import { MAX_TYPE_ERROR_CONTEXT_BYTES } from '../../server/config/defaults.js';

// ── parseTscOutput ────────────────────────────────────────────────────────

test('parseTscOutput: empty / null input returns empty array', () => {
  assert.deepEqual(parseTscOutput(''), []);
  assert.deepEqual(parseTscOutput(null), []);
  assert.deepEqual(parseTscOutput(undefined), []);
});

test('parseTscOutput: parses a known tsc error blob into structured errors', () => {
  const blob = `src/index.ts(172,24): error TS2345: Argument of type 'string | string[]' is not assignable to parameter of type 'string'.
src/util.ts(5,7): error TS2304: Cannot find name 'fooBar'.
src/util.ts(12,1): error TS6133: 'unused' is declared but its value is never read.`;
  const errors = parseTscOutput(blob);
  assert.equal(errors.length, 3);
  assert.equal(errors[0].file, 'src/index.ts');
  assert.equal(errors[0].line, 172);
  assert.equal(errors[0].col, 24);
  assert.equal(errors[0].code, 'TS2345');
  assert.match(errors[0].message, /Argument of type/);
  assert.equal(errors[1].file, 'src/util.ts');
  assert.equal(errors[1].code, 'TS2304');
  assert.equal(errors[2].code, 'TS6133');
});

test('parseTscOutput: ignores non-error lines (info, "Found N errors", blank)', () => {
  const blob = `
src/index.ts(1,1): error TS2304: Cannot find name 'foo'.

Found 1 error in src/index.ts:1
`;
  const errors = parseTscOutput(blob);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'TS2304');
});

test('parseTscOutput: strips ANSI color codes before parsing', () => {
  // Simulate tsc --pretty output: ESC sequences around path / error code.
  const blob = '\x1b[96msrc/index.ts\x1b[0m(\x1b[93m12\x1b[0m,\x1b[93m5\x1b[0m): \x1b[91merror\x1b[0m \x1b[90mTS2304: \x1b[0mCannot find name \'foo\'.';
  const errors = parseTscOutput(blob);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'src/index.ts');
  assert.equal(errors[0].code, 'TS2304');
});

// ── parseMypyOutput ───────────────────────────────────────────────────────

test('parseMypyOutput: parses canonical "path:line: error: message [code]" lines', () => {
  const blob = `main.py:42: error: Incompatible return value type (got "int", expected "str")  [return-value]
routes/api.py:7: error: Name "foo" is not defined  [name-defined]`;
  const errors = parseMypyOutput(blob);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].file, 'main.py');
  assert.equal(errors[0].line, 42);
  assert.equal(errors[0].code, 'return-value');
  assert.match(errors[0].message, /Incompatible return value/);
  assert.equal(errors[1].file, 'routes/api.py');
  assert.equal(errors[1].code, 'name-defined');
});

test('parseMypyOutput: parses "path:line:col:" variant too', () => {
  const blob = `main.py:42:8: error: Argument 1 to "foo" has incompatible type  [arg-type]`;
  const errors = parseMypyOutput(blob);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].col, 8);
  assert.equal(errors[0].code, 'arg-type');
});

test('parseMypyOutput: handles missing [code] suffix', () => {
  const blob = `main.py:1: error: Something broke without a code`;
  const errors = parseMypyOutput(blob);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, '');
  assert.equal(errors[0].message, 'Something broke without a code');
});

// ── formatTypeErrors ──────────────────────────────────────────────────────

test('formatTypeErrors: empty raw output → hasErrors=false, empty formatted', () => {
  const out = formatTypeErrors({
    scope: 'backend',
    runtime: 'node',
    rawOutput: '',
    workspaceDir: '/tmp/nonexistent',
  });
  assert.equal(out.hasErrors, false);
  assert.equal(out.errorCount, 0);
  assert.equal(out.formatted, '');
});

test('formatTypeErrors: per-file truncation at 10 errors with "… and N more"', () => {
  // Generate 15 errors in one file.
  const lines = [];
  for (let i = 1; i <= 15; i++) {
    lines.push(`src/index.ts(${i},1): error TS2304: Error number ${i}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-fmt-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    // Source file with 20 lines so context reads don't break.
    const src = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), src);

    const out = formatTypeErrors({
      scope: 'backend',
      runtime: 'node',
      rawOutput: lines.join('\n'),
      workspaceDir: tmpDir,
    });
    assert.equal(out.hasErrors, true);
    assert.equal(out.errorCount, 15);
    assert.match(out.formatted, /… and 5 more error\(s\) in this file/);
    // First 10 are rendered with their "Error number N" message text.
    for (let i = 1; i <= 10; i++) {
      assert.ok(out.formatted.includes(`Error number ${i}`),
        `expected "Error number ${i}" in formatted output`);
    }
    // 11+ should NOT be rendered individually.
    assert.ok(!out.formatted.includes('Error number 11'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatTypeErrors: includes source-line context (1 above + 1 below) for each error', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-fmt-ctx-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const src = [
      'line 1',
      'line 2',
      'const x: number = "wrong";',  // line 3 (the error line)
      'line 4',
      'line 5',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), src);

    const out = formatTypeErrors({
      scope: 'backend',
      runtime: 'node',
      rawOutput: `src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
      workspaceDir: tmpDir,
    });
    assert.equal(out.hasErrors, true);
    assert.match(out.formatted, /line 2/);
    assert.match(out.formatted, /const x: number = "wrong";/);
    assert.match(out.formatted, /line 4/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatTypeErrors: caps at MAX_TYPE_ERROR_CONTEXT_BYTES with truncation marker', () => {
  // Generate enough errors across enough files to far exceed the byte cap.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-fmt-cap-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const fileCount = 50;
    const errLines = [];
    for (let f = 0; f < fileCount; f++) {
      const rel = `src/file_${f}.ts`;
      // Big source so context reads add bytes per error.
      const src = Array.from({ length: 30 }, (_, i) => `// some content line ${i + 1} of file ${f} with extra padding text`).join('\n');
      fs.writeFileSync(path.join(tmpDir, rel), src);
      for (let i = 1; i <= 5; i++) {
        errLines.push(`${rel}(${i},1): error TS2304: Cannot find name 'undefined_in_file_${f}_err_${i}'.`);
      }
    }
    const out = formatTypeErrors({
      scope: 'backend',
      runtime: 'node',
      rawOutput: errLines.join('\n'),
      workspaceDir: tmpDir,
    });
    assert.equal(out.hasErrors, true);
    assert.equal(out.errorCount, fileCount * 5);
    assert.ok(out.formatted.length <= MAX_TYPE_ERROR_CONTEXT_BYTES + 500,
      `formatted length ${out.formatted.length} should be near or below cap ${MAX_TYPE_ERROR_CONTEXT_BYTES}`);
    assert.match(out.formatted, /truncated to stay within agent context budget|output truncated at/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── detectRuntime ─────────────────────────────────────────────────────────

test('detectRuntime: backend with tsconfig.json + src/index.ts → node', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-detect-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'backend', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'backend', 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'backend', 'src', 'index.ts'), '');
    assert.equal(detectRuntime(tmpDir, 'backend'), 'node');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectRuntime: backend with main.py + mypy.ini → python', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-detect-py-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'backend', 'main.py'), '');
    fs.writeFileSync(path.join(tmpDir, 'backend', 'mypy.ini'), '[mypy]\nstrict = True\n');
    assert.equal(detectRuntime(tmpDir, 'backend'), 'python');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectRuntime: frontend with tsconfig.json → frontend', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-detect-fe-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'frontend', 'tsconfig.json'), '{}');
    assert.equal(detectRuntime(tmpDir, 'frontend'), 'frontend');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectRuntime: scopes without type-checked runtime → null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-detect-null-'));
  try {
    assert.equal(detectRuntime(tmpDir, 'database'), null);
    assert.equal(detectRuntime(tmpDir, 'vectordb'), null);
    assert.equal(detectRuntime(tmpDir, 'integration'), null);
    // backend without the required files → null
    assert.equal(detectRuntime(tmpDir, 'backend'), null);
    assert.equal(detectRuntime(tmpDir, 'frontend'), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── runTypeGate end-to-end ────────────────────────────────────────────────

// Resolve a tsc binary the test process can spawn. Mirrors the type-gate's
// own lookup pattern. Skips the e2e test gracefully when no tsc reachable.
function tscReachable() {
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('tsc', ['--version'], { stdio: 'ignore', timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

test('runTypeGate: detects compile errors in a backend workspace and clears once fixed', async (t) => {
  // Resolve tsc inside the test for skip behavior.
  const { execFileSync } = await import('node:child_process');
  let tscOk = false;
  try {
    execFileSync('tsc', ['--version'], { stdio: 'ignore', timeout: 3_000 });
    tscOk = true;
  } catch { /* no tsc on PATH */ }
  if (!tscOk) {
    t.skip('tsc not reachable on PATH — skipping e2e gate test');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-e2e-'));
  try {
    const backend = path.join(tmpDir, 'backend');
    fs.mkdirSync(path.join(backend, 'src'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        noUnusedLocals: false,
        skipLibCheck: true,
        types: [],
      },
      include: ['src/**/*.ts'],
    }, null, 2));
    // Obviously-broken TS: assigning a string literal to a number.
    fs.writeFileSync(path.join(backend, 'src', 'index.ts'),
      `const port: number = "not-a-number";\nexport { port };\n`);

    const gate = await runTypeGate({ workspaceDir: tmpDir, scope: 'backend' });
    assert.equal(gate.runtime, 'node');
    assert.equal(gate.hasErrors, true, 'expected hasErrors=true on broken backend');
    assert.ok(gate.errorCount >= 1, 'expected at least one error');
    // Match the source FILE in the formatted output, not the literal value:
    // tsc renders `const port: number = "not-a-number"` as either the literal
    // type ('"not-a-number"') or the widened 'string' depending on the tsc
    // version on PATH, so asserting the literal is version-brittle. The file
    // path is always present and is what "source line in output" really means.
    assert.match(gate.formatted, /index\.ts/, 'expected source line in formatted output');

    // Fix the file; gate clears.
    fs.writeFileSync(path.join(backend, 'src', 'index.ts'),
      `const port: number = 3000;\nexport { port };\n`);
    const gate2 = await runTypeGate({ workspaceDir: tmpDir, scope: 'backend' });
    assert.equal(gate2.hasErrors, false, 'expected hasErrors=false after fix');
    assert.equal(gate2.errorCount, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runTypeGate: scope with no type-checked runtime returns skipped=true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'type-gate-skip-'));
  try {
    const gate = await runTypeGate({ workspaceDir: tmpDir, scope: 'database' });
    assert.equal(gate.hasErrors, false);
    assert.equal(gate.skipped, true);
    assert.equal(gate.runtime, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
