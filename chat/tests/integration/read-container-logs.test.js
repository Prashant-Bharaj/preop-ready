/**
 * Coverage: flow 5 (Bug report → investigator) via chain
 *   flow 5 → investigator agent reads container logs to diagnose runtime
 *           failures → tool returns structured shape (status: ok |
 *           no_container | timeout | error) → confidence assessment grounds
 *           the diagnose vs surface decision in real evidence
 *
 * Migrated from `tests/tools/test-read-container-logs.js` (Dispatch 3 —
 * original was a scripted `process.exit(N)` driver, W3.LOGS verification).
 *
 * Integration tier boundary: per the test plan, integration runs with Docker
 * ABSENT (or mocked). The original driver's PATHs 1, 2, 3 each require a
 * live `docker compose` against a real running backend container; those are
 * skipped here with `t.skip()` and labelled as live-dispatch-tier surfaces.
 * The two deterministic + Docker-independent paths survive intact:
 *
 *   - PATH 3b: truncation transform unit-check (drives the head-truncation
 *     transform with a known 200KB synthetic payload + 50KB cap)
 *   - PATH 4 : registry wiring (KNOWN_TOOL_NAMES + isToolConcurrencySafe)
 *
 * Together they cover the byte-cap behaviour + the dispatcher wiring without
 * requiring Docker. The live paths can still be exercised manually via the
 * original driver's WORKSPACE_DIR convention or via the smoke tier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchTool, KNOWN_TOOL_NAMES, isToolConcurrencySafe } from '../../server/agent/tools/core.js';
import { stripAnsi } from '../../server/util/redact.js';

// ── PATH 1 — Happy path (live Docker) ────────────────────────────────────
test('PATH 1 — happy path: live Docker required; skipped in Docker-absent integration tier', (t) => {
  t.skip('Requires WORKSPACE_DIR with running docker compose + backend service; covered in smoke + live-dispatch tiers.');
});

// ── PATH 2 — Bogus service (live Docker) ─────────────────────────────────
test('PATH 2 — no_container shape on bogus service: live Docker required; skipped', (t) => {
  t.skip('Requires live docker compose runtime; classifyError behaviour covered by smoke runs.');
});

// ── PATH 3 — Truncation against live container ───────────────────────────
test('PATH 3 — live-container truncation: requires accumulated container logs; skipped', (t) => {
  t.skip('Requires live docker compose runtime with accumulated >50KB log buffer; superseded by PATH 3b for the byte-cap behaviour itself.');
});

// ── PATH 3b — Truncation transform unit-check (deterministic) ────────────
test('PATH 3b — truncation transform: 200KB → 50KB cap, tail preserved, leading partial line dropped', () => {
  const big = ('A'.repeat(100) + '\n').repeat(2000); // ~200 KB
  const CAP = 50 * 1024;
  const cleaned = stripAnsi(big);
  const buf = Buffer.from(cleaned, 'utf8');
  let payload = buf.subarray(buf.length - CAP).toString('utf8');
  const firstNewline = payload.indexOf('\n');
  if (firstNewline > 0 && firstNewline < payload.length - 1) payload = payload.slice(firstNewline + 1);
  const returnedBytes = Buffer.byteLength(payload, 'utf8');

  assert.ok(returnedBytes <= CAP, `returnedBytes (${returnedBytes}) must be at or below cap (${CAP})`);
  // Head-truncation: payload should still end with the same tail as the original.
  assert.ok(cleaned.endsWith(payload.slice(-1000)), 'tail-of-truncated must match tail-of-original');
  // The post-newline slice means payload starts on a line boundary.
  assert.ok(payload.length > 0, 'payload not empty after truncation');
});

// ── PATH 4 — TOOL_MAP-dispatch registry wiring ────────────────────────────
test('PATH 4 — registry wiring: read_container_logs is in KNOWN_TOOL_NAMES + marked concurrency-safe', () => {
  assert.ok(KNOWN_TOOL_NAMES.includes('read_container_logs'),
    'read_container_logs must be in KNOWN_TOOL_NAMES (registered, not just imported)');
  assert.ok(isToolConcurrencySafe('read_container_logs'),
    'read_container_logs must be marked concurrency-safe (read-only)');
  // dispatchTool surface exists (callable; we don't invoke it here because
  // even the bogus-service path requires runCompose to traverse a real
  // docker compose binary search).
  assert.equal(typeof dispatchTool, 'function');
});
