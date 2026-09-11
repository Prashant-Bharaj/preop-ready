/**
 * Coverage: meta-test for the shared telemetry-asserts helper that flows 5,
 *   7, 8, 9 depend on (integration tier — Dispatch 3) and that smoke wires
 *   in (Dispatch 4). This is the unit-tier coverage for the helper itself:
 *   it doesn't map to a single flow, it underpins many.
 *
 *   Chain: this helper → integration tests assert telemetry shape →
 *     flow-5 investigator records / flow-7 run-summary evolution /
 *     flow-8+9 auto-recovery records all surface regressions before smoke
 *
 * Unit tier: no MGA, no Docker, no real workspace. Synthetic JSONL fixtures
 * written to temp dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertHasRunSummary,
  assertHasSnippetFetches,
  assertHasReconcilerVerdicts,
  assertHasAutoRecoveryAttempts,
  assertHasInvestigatorRecords,
  assertLogAndSwallowContained,
} from '../util/telemetry-asserts.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeWs() {
  const ws = mkdtempSync(path.join(tmpdir(), 'tel-asserts-'));
  mkdirSync(path.join(ws, '.harness'), { recursive: true });
  return ws;
}

function writeJsonl(file, records) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function writeWorkspaceRunSummary(ws, records) {
  writeJsonl(path.join(ws, '.harness', 'run-summaries.jsonl'), records);
}

function writeSummariesDirFile(summariesDir, sessionId, records) {
  writeJsonl(path.join(summariesDir, `${sessionId}.jsonl`), records);
}

// ── assertHasRunSummary ──────────────────────────────────────────────────

test('assertHasRunSummary: workspace-local run-summaries.jsonl happy path', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      { sessionId: 's1', action: 'execute', status: 'built', scopes: ['backend'], tokens: { total: 100 } },
    ]);
    const rec = assertHasRunSummary(ws, {
      sessionId: 's1',
      action: 'execute',
      status: 'built',
      requireFields: ['scopes', 'tokens'],
    });
    assert.equal(rec.sessionId, 's1');
    assert.equal(rec.action, 'execute');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasRunSummary: takes the latest record when multiple exist for sessionId', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      { sessionId: 's1', action: 'execute', status: 'built', scopes: ['backend'] },
      { sessionId: 's1', action: 'iterate', status: 'partial', scopes: ['frontend'] },
    ]);
    const rec = assertHasRunSummary(ws, { sessionId: 's1', action: 'iterate' });
    assert.equal(rec.status, 'partial');
    assert.deepEqual(rec.scopes, ['frontend']);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasRunSummary: action mismatch throws actionable error', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      { sessionId: 's1', action: 'execute', status: 'built' },
    ]);
    assert.throws(
      () => assertHasRunSummary(ws, { sessionId: 's1', action: 'iterate' }),
      /action mismatch.*expected iterate.*got execute/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasRunSummary: missing required field throws with field name', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      { sessionId: 's1', action: 'execute', status: 'built', scopes: [] },
    ]);
    assert.throws(
      () => assertHasRunSummary(ws, { sessionId: 's1', requireFields: ['scopes'] }),
      /required field "scopes" is empty\/missing/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasRunSummary: missing file throws with file path', () => {
  const ws = makeWs();
  try {
    // No file written.
    assert.throws(
      () => assertHasRunSummary(ws, { sessionId: 'nope' }),
      /run-summary file not found/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasRunSummary: summariesDir override + per-sessionId file', () => {
  const ws = makeWs();
  const summariesDir = mkdtempSync(path.join(tmpdir(), 'tel-asserts-summaries-'));
  try {
    writeSummariesDirFile(summariesDir, 's2', [
      { sessionId: 's2', action: 'diagnose', status: 'built' },
    ]);
    const rec = assertHasRunSummary(ws, { sessionId: 's2', summariesDir, action: 'diagnose' });
    assert.equal(rec.sessionId, 's2');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(summariesDir, { recursive: true, force: true });
  }
});

// ── assertHasSnippetFetches ──────────────────────────────────────────────

test('assertHasSnippetFetches: happy path with scope + path filters', () => {
  const ws = makeWs();
  try {
    writeJsonl(path.join(ws, '.harness', 'snippet-fetches.jsonl'), [
      { sessionId: 's1', scope: 'backend', phase: 'SUBAGENT', snippetPath: 'backend/Health.ts', sizeBytes: 100, fetchedAt: 1, source: 'disk' },
      { sessionId: 's1', scope: 'frontend', phase: 'SUBAGENT', snippetPath: 'frontend/App.tsx', sizeBytes: 200, fetchedAt: 2, source: 'disk' },
    ]);
    const rows = assertHasSnippetFetches(ws, {
      sessionId: 's1',
      expectedScopes: ['backend', 'frontend'],
      minCount: 2,
    });
    assert.equal(rows.length, 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasSnippetFetches: missing scope throws with seen scopes', () => {
  const ws = makeWs();
  try {
    writeJsonl(path.join(ws, '.harness', 'snippet-fetches.jsonl'), [
      { sessionId: 's1', scope: 'backend', phase: 'SUBAGENT', snippetPath: 'x.ts', sizeBytes: 1, source: 'disk' },
    ]);
    assert.throws(
      () => assertHasSnippetFetches(ws, { expectedScopes: ['backend', 'frontend'] }),
      /expected scope "frontend" not found.*seen: \[backend\]/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasSnippetFetches: missing file throws with file path', () => {
  const ws = makeWs();
  try {
    assert.throws(
      () => assertHasSnippetFetches(ws, {}),
      /file not found/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── assertHasReconcilerVerdicts ──────────────────────────────────────────

test('assertHasReconcilerVerdicts: filters by kind + verdict + scope', () => {
  const ws = makeWs();
  try {
    writeJsonl(path.join(ws, '.harness', 'reconciler-verdicts.jsonl'), [
      { scope: 'backend', kind: 'api_contract', verdict: 'ok', contractItem: 'GET /health' },
      { scope: 'backend', kind: 'api_contract', verdict: 'mismatch', target: 'POST /correct', contractItem: 'POST /uniqBBB' },
      { scope: 'frontend', kind: 'ui_contract', verdict: 'ok', contractItem: 'AdminBadge' },
    ]);
    const rows = assertHasReconcilerVerdicts(ws, { kind: 'api_contract', verdict: 'ok' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, 'backend');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasReconcilerVerdicts: under-count throws with filters in message', () => {
  const ws = makeWs();
  try {
    writeJsonl(path.join(ws, '.harness', 'reconciler-verdicts.jsonl'), [
      { scope: 'backend', kind: 'api_contract', verdict: 'ok', contractItem: 'GET /x' },
    ]);
    assert.throws(
      () => assertHasReconcilerVerdicts(ws, { verdict: 'mismatch', minCount: 2 }),
      /expected at least 2.*got 0/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── assertHasAutoRecoveryAttempts ────────────────────────────────────────

test('assertHasAutoRecoveryAttempts: extracts records from run-summary autoRecoveryAttempts', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      {
        sessionId: 's1', action: 'execute', status: 'partial',
        autoRecoveryAttempts: [
          { scope: 'backend', attemptN: 1, triggeredBy: 'reconciler', exhausted: false },
          { scope: 'backend', attemptN: 2, triggeredBy: 'reconciler', exhausted: true },
        ],
      },
    ]);
    const records = assertHasAutoRecoveryAttempts(ws, {
      sessionId: 's1',
      scope: 'backend',
      minAttempts: 2,
      exhausted: true,
    });
    assert.equal(records.length, 2);
    assert.equal(records[1].exhausted, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasAutoRecoveryAttempts: exhausted=true requires at least one matching record', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      {
        sessionId: 's1', action: 'execute', status: 'built',
        autoRecoveryAttempts: [{ scope: 'backend', attemptN: 1, triggeredBy: 'reconciler', exhausted: false }],
      },
    ]);
    assert.throws(
      () => assertHasAutoRecoveryAttempts(ws, { sessionId: 's1', exhausted: true }),
      /expected at least one record with exhausted===true/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── assertHasInvestigatorRecords ─────────────────────────────────────────

test('assertHasInvestigatorRecords: confidence floor + filesRead minimum', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      {
        sessionId: 's1', action: 'diagnose', status: 'built',
        investigatorRecords: [
          {
            symptom: 'health 500',
            confidence: 0.85,
            filesRead: ['a.ts', 'b.ts', 'c.ts'],
            recommendedFix: { scope: 'backend', description: 'await pool.query' },
          },
        ],
      },
    ]);
    const records = assertHasInvestigatorRecords(ws, {
      sessionId: 's1',
      confidence: 0.7,
      minFilesRead: 2,
      branched: true,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].confidence, 0.85);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasInvestigatorRecords: low confidence throws with seen values', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      {
        sessionId: 's1', action: 'diagnose', status: 'built',
        investigatorRecords: [{ symptom: 'x', confidence: 0.3 }],
      },
    ]);
    assert.throws(
      () => assertHasInvestigatorRecords(ws, { sessionId: 's1', confidence: 0.7 }),
      /expected at least one record with confidence >= 0\.7.*seen: \[0\.3\]/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertHasInvestigatorRecords: no investigator records throws', () => {
  const ws = makeWs();
  try {
    writeWorkspaceRunSummary(ws, [
      { sessionId: 's1', action: 'execute', status: 'built', investigatorRecords: [] },
    ]);
    assert.throws(
      () => assertHasInvestigatorRecords(ws, { sessionId: 's1' }),
      /no investigatorRecords found in run-summary/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── assertLogAndSwallowContained ─────────────────────────────────────────

test('assertLogAndSwallowContained: matches any [telemetry-X] label by default', () => {
  // Should not throw.
  assertLogAndSwallowContained({
    stderr: '[17:00:00] [telemetry-reconciler-verdicts]: ENOTDIR: not a directory ...',
  });
});

test('assertLogAndSwallowContained: matches specific label when provided', () => {
  assertLogAndSwallowContained({
    stderr: '[17:00:00] [telemetry-snippet-fetches]: write failed',
    label: 'telemetry-snippet-fetches',
  });
});

test('assertLogAndSwallowContained: throws when stderr has no telemetry label', () => {
  assert.throws(
    () => assertLogAndSwallowContained({ stderr: 'plain log output, no telemetry frame' }),
    /expected stderr to contain a \[telemetry-X\] label/,
  );
});

test('assertLogAndSwallowContained: throws when specific label is absent', () => {
  assert.throws(
    () => assertLogAndSwallowContained({
      stderr: '[telemetry-reconciler-verdicts]: write failed',
      label: 'telemetry-snippet-fetches',
    }),
    /expected stderr to contain \[telemetry-snippet-fetches\]/,
  );
});

test('assertLogAndSwallowContained: missing stderr throws', () => {
  assert.throws(
    () => assertLogAndSwallowContained({}),
    /opts.stderr is required/,
  );
});
