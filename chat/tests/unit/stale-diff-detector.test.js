/**
 * W3.RECOV — stale-diff detector unit test.
 *
 * Covers the detection signature documented in
 * `smoke-metrics-baseline-post-phase{1,2}-2026-05-16.flake-notes.md`:
 * when a single batch produces N≥2 `replace_in_file` errors with a
 * "SEARCH block did not match" snippet (with or without a block index),
 * the detector returns the deduped list of affected paths so the
 * recovery loop can synthesise read_file injections.
 *
 * Also covers buildReadFileInjection's happy path + missing-file path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectStaleDiffPaths, buildReadFileInjection } from '../../server/agent/agent.js';

test('detectStaleDiffPaths: returns empty array for null / non-array input', () => {
  assert.deepEqual(detectStaleDiffPaths(null), []);
  assert.deepEqual(detectStaleDiffPaths(undefined), []);
  assert.deepEqual(detectStaleDiffPaths('not an array'), []);
});

test('detectStaleDiffPaths: returns empty when no replace_in_file errors present', () => {
  const errors = [
    { name: 'read_file', path: 'foo.ts', snippet: 'ENOENT' },
    { name: 'execute_command', path: '', snippet: 'exit code 1' },
  ];
  assert.deepEqual(detectStaleDiffPaths(errors), []);
});

test('detectStaleDiffPaths: returns empty when replace_in_file errors are NOT stale-diff signature', () => {
  const errors = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'ENOENT: no such file or directory' },
    { name: 'replace_in_file', path: 'b.ts', snippet: 'permission denied' },
  ];
  assert.deepEqual(detectStaleDiffPaths(errors), []);
});

test('detectStaleDiffPaths: detects "SEARCH block 1 did not match" signature', () => {
  const errors = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block 1 did not match. The text below was not found verbatim in a.ts ...' },
    { name: 'replace_in_file', path: 'b.ts', snippet: 'replace_in_file: SEARCH block 1 did not match. The text below was not found verbatim in b.ts ...' },
  ];
  assert.deepEqual(detectStaleDiffPaths(errors).sort(), ['a.ts', 'b.ts']);
});

test('detectStaleDiffPaths: detects "SEARCH block did not match" (no number) signature', () => {
  const errors = [
    { name: 'replace_in_file', path: 'src/index.ts', snippet: 'replace_in_file: SEARCH block did not match. The text below was not found verbatim in src/index.ts' },
    { name: 'replace_in_file', path: 'src/util.ts', snippet: 'replace_in_file: SEARCH block did not match. ...' },
  ];
  assert.deepEqual(detectStaleDiffPaths(errors).sort(), ['src/index.ts', 'src/util.ts']);
});

test('detectStaleDiffPaths: dedups identical paths across multiple blocks', () => {
  // Same file can produce multiple stale-diff errors if the agent emits multiple
  // SEARCH/REPLACE blocks in one call. We dedup at the path level — the
  // recovery loop only needs one read_file injection per affected path.
  const errors = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block 1 did not match.' },
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block 2 did not match.' },
    { name: 'replace_in_file', path: 'b.ts', snippet: 'replace_in_file: SEARCH block 1 did not match.' },
  ];
  assert.deepEqual(detectStaleDiffPaths(errors).sort(), ['a.ts', 'b.ts']);
});

test('detectStaleDiffPaths: ignores non-replace_in_file errors interleaved with stale-diff signature', () => {
  const errors = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block did not match.' },
    { name: 'execute_command', path: '', snippet: 'exit code 1: npm install failed' },
    { name: 'replace_in_file', path: 'b.ts', snippet: 'replace_in_file: SEARCH block did not match.' },
  ];
  assert.deepEqual(detectStaleDiffPaths(errors).sort(), ['a.ts', 'b.ts']);
});

test('detectStaleDiffPaths: gating threshold met when >=2 distinct paths affected', () => {
  // The recovery loop fires when length >= 2. Single-path stale-diff is a
  // benign one-off (could be a real SEARCH typo); we only intervene when
  // the signature looks like cross-scope reconciler activity (multiple
  // files going stale at once).
  const oneFile = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block did not match.' },
  ];
  const twoFiles = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block did not match.' },
    { name: 'replace_in_file', path: 'b.ts', snippet: 'replace_in_file: SEARCH block did not match.' },
  ];
  assert.equal(detectStaleDiffPaths(oneFile).length, 1, 'single-path detection is fine; gating is the caller');
  assert.equal(detectStaleDiffPaths(twoFiles).length, 2, 'two-path is the trigger threshold');
});

test('buildReadFileInjection: returns synthesised read_file block with current file content', () => {
  // Hand-craft a temp workspace with a known file. Verify the injection
  // includes (a) the file path, (b) the file's current text, (c) the
  // "stale-diff recovery" attribution marker.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-diff-test-'));
  try {
    const relPath = 'backend/src/index.ts';
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const content = "// hello world\nexport const app = 'real-current-content';\n";
    fs.writeFileSync(absPath, content);

    const block = buildReadFileInjection(tmpDir, relPath);
    assert.ok(block, 'injection block should be non-null for existing file');
    assert.match(block, /\[TOOL RESULT — read_file \(synthesised by stale-diff recovery\)\]/);
    assert.match(block, new RegExp(`path: ${relPath.replace(/\//g, '\\/')}`));
    assert.ok(block.includes("real-current-content"), 'injection should embed file content verbatim');
    assert.match(block, /\[\/TOOL RESULT\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildReadFileInjection: handles missing file gracefully with an explanatory stub', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-diff-test-'));
  try {
    const block = buildReadFileInjection(tmpDir, 'does/not/exist.ts');
    assert.ok(block, 'should return a stub for missing file');
    assert.match(block, /does not exist on disk/i);
    assert.match(block, /\[TOOL RESULT — read_file/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Integration-shaped check: simulate the gate logic the agent loop uses ──

test('integration: gate fires only when N>=2 distinct stale-diff paths exist (mirrors agent.js loop logic)', () => {
  // This duplicates the gate in agent.js without spinning up the full
  // agent loop. Documents the contract between detector + caller so a
  // future refactor to the gate doesn't silently change semantics.
  const single = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block did not match' },
  ];
  const multi = [
    { name: 'replace_in_file', path: 'a.ts', snippet: 'replace_in_file: SEARCH block did not match' },
    { name: 'replace_in_file', path: 'b.ts', snippet: 'replace_in_file: SEARCH block did not match' },
  ];
  // The caller's gate: trigger recovery only when ≥2 distinct paths.
  const singleFires = detectStaleDiffPaths(single).length >= 2;
  const multiFires = detectStaleDiffPaths(multi).length >= 2;
  assert.equal(singleFires, false, 'single-path should NOT trigger recovery');
  assert.equal(multiFires, true, 'multi-path SHOULD trigger recovery');
});
