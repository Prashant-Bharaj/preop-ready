/**
 * Coverage: flows 5, 7, 8, 9 — telemetry artifacts these flows depend on
 *   flow 5 → investigator records emitted into run-summary (W3.TEL §M item 11)
 *   flow 7 → run-summary writes evolve per turn (W1.TEL §M item 6)
 *   flow 8 → auto-recovery records collected into run-summary (§M item 10)
 *           reconciler verdicts emitted as jsonl (§M item 4)
 *           snippet fetches recorded (§M item 3)
 *   flow 9 → exhausted recovery records carry exhausted=true through to the
 *           run-summary so the user-surface message has structured backing
 *
 * Migrated from `tests/telemetry/test-w3-tel.js` (Dispatch 3 — original was
 * a scripted `process.exit(N)` driver, W3.TEL verification). Same code paths
 * exercised, same assertions made; the wrapping is mechanical.
 *
 * Integration tier: real telemetry writers (judge-extras, compareScopes,
 * getSnippet, appendReconcilerVerdict, pushAutoRecoveryRecord,
 * pushInvestigatorRecord, writeRunSummary). No MGA, no Docker. PATH 1's
 * judge is a sync stub.
 *
 * Concurrency note: PATH 1 + PATH 5 monkey-patch process.stdout/stderr to
 * capture output; node --test runs each *.test.js file in its own process
 * (test:integration uses --test-isolation=process), and tests within this
 * file are NOT marked concurrent, so the monkey-patch is safe within this
 * file's scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { judgeExtras } from '../../server/reconciler/judge-extras.js';
import { compareScopes } from '../../server/reconciler/compare.js';
import { getSnippet } from '../../server/mcp/handlers.js';
import {
  appendReconcilerVerdict,
} from '../../server/util/telemetry-verdicts.js';
import {
  appendSnippetFetch,
  getSnippetFetchMirror,
  resetSnippetFetchMirror,
} from '../../server/util/telemetry-snippets.js';
import { writeRunSummary, __test as runSummaryTest } from '../../server/util/run-summary.js';
import { pushInvestigatorRecord } from '../../server/session/routes.js';
import { pushAutoRecoveryRecord } from '../../server/session/auto-recovery.js';

function makeTmpWorkspace() {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'w3-tel-'));
  const snippetsDir = path.join(ws, 'snippets', 'frontend');
  mkdirSync(snippetsDir, { recursive: true });
  writeFileSync(
    path.join(snippetsDir, 'AppScaffold.tsx'),
    "import React from 'react';\nexport default function App() { return <div>hello</div>; }\n",
  );
  return ws;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8').trim();
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// ── PATH 1 — Reconciler verdict emission ──────────────────────────────
test('PATH 1 — reconciler verdict emission: jsonl + tlog for all 4 verdict tokens', async () => {
  const ws = makeTmpWorkspace();
  try {
    // Capture stdout to assert the tlog still fires.
    let stdoutCapture = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      stdoutCapture += String(chunk);
      return origWrite(chunk, ...rest);
    };

    const extras = [
      { kind: 'backend-extra-route', scope: 'backend', method: 'GET', path: '/uniqAAA' },
      { kind: 'frontend-extra-fetch', scope: 'frontend', method: 'POST', path: '/uniqBBB' },
      { kind: 'coverage-gap-backend', scope: 'backend', method: 'POST', path: '/uniqCCC' },
    ];
    const sinkCalls = [];
    // BATCHED_PROMPT contract: prompt embeds "=== EXTRAS (array of N items
    // to classify) ===" followed by a JSON array; judge MUST return a JSON
    // array of N verdict objects in the same order. Each test extra is its
    // own batch here because batches group by (kind, scope) and these 3
    // items are all distinct (kind, scope) pairs.
    const judge = async (prompt) => {
      const m = prompt.match(/=== EXTRAS \(array of \d+ items? to classify\) ===\n(\[[\s\S]*?\])\n/);
      if (!m) return JSON.stringify([{ verdict: 'legitimate' }]);
      const items = JSON.parse(m[1]);
      const verdicts = items.map(item => {
        if (item.path === '/uniqAAA') return { verdict: 'legitimate' };
        if (item.path === '/uniqBBB') return { verdict: 'mismatch:POST /correct', target: 'POST /correct' };
        if (item.path === '/uniqCCC') return { verdict: 'noise' };
        return { verdict: 'legitimate' };
      });
      return JSON.stringify(verdicts);
    };
    await judgeExtras(extras, {}, {
      judge,
      workspaceDir: ws,
      onVerdict: (rec) => sinkCalls.push(rec),
    });

    process.stdout.write = origWrite;

    // compare.js ok path — feed extracted records that overlap on a route.
    compareScopes({
      workspaceDir: ws,
      extractedBackend: [{ method: 'GET', path: '/health', file: 'a.ts', line: 1 }, { method: 'GET', path: '/items', file: 'a.ts', line: 2 }],
      extractedFrontend: [{ method: 'GET', path: '/items', file: 'f.tsx', line: 5 }],
      extractedDb: [],
      routerContracts: { apiContract: { endpoints: [{ method: 'GET', path: '/items' }] } },
    });

    const verdictsPath = path.join(ws, '.harness', 'reconciler-verdicts.jsonl');
    const lines = readJsonl(verdictsPath);

    assert.ok(
      /\[reconciler-judge\] verdict .*verdict=/.test(stdoutCapture),
      'existing reconciler-judge tlog must still fire',
    );

    assert.ok(lines.length >= 4, `expected >=4 verdict lines, got ${lines.length}`);

    for (const line of lines) {
      assert.ok('scope' in line, 'line missing scope');
      assert.ok('contractItem' in line, 'line missing contractItem');
      assert.ok('kind' in line, 'line missing kind');
      assert.ok('verdict' in line, 'line missing verdict');
      assert.ok(['ok', 'mismatch', 'legitimate', 'noise'].includes(line.verdict),
        `verdict token must be normalised: ${line.verdict}`);
    }

    const verdicts = new Set(lines.map((l) => l.verdict));
    assert.ok(verdicts.has('ok'), 'expected an ok verdict from compare.js matched path');
    assert.ok(verdicts.has('legitimate'), 'expected a legitimate verdict from judge');
    assert.ok(verdicts.has('mismatch'), 'expected a mismatch verdict from judge');
    assert.ok(verdicts.has('noise'), 'expected a noise verdict from judge');

    const mismatchLine = lines.find((l) => l.verdict === 'mismatch');
    assert.ok(mismatchLine.target, 'mismatch verdict must populate target');

    assert.equal(sinkCalls.length, 3, `sink call count should be 3, got ${sinkCalls.length}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── PATH 2 — Snippet-fetch emission ───────────────────────────────────
test('PATH 2 — snippet-fetch emission: jsonl + mirror, all required keys', () => {
  const ws = makeTmpWorkspace();
  try {
    const sessionId = 'test-session-w3tel-' + Date.now();
    resetSnippetFetchMirror(sessionId);

    const content = getSnippet('frontend/AppScaffold.tsx', {
      workspaceDir: ws,
      sessionId,
      scope: 'frontend',
      phase: 'SUBAGENT',
    });
    assert.ok(content.includes('import React'), 'snippet content must come through');

    getSnippet('frontend/AppScaffold.tsx', {
      workspaceDir: ws,
      sessionId,
      scope: 'frontend',
      phase: 'SUBAGENT',
    });

    const fetchesPath = path.join(ws, '.harness', 'snippet-fetches.jsonl');
    const lines = readJsonl(fetchesPath);
    assert.equal(lines.length, 2, `expected 2 fetch lines, got ${lines.length}`);

    const first = lines[0];
    for (const key of ['sessionId', 'scope', 'phase', 'snippetPath', 'fetchedAt', 'sizeBytes', 'source']) {
      assert.ok(key in first, `fetch line missing key: ${key}`);
    }
    assert.equal(first.sessionId, sessionId);
    assert.equal(first.scope, 'frontend');
    assert.equal(first.phase, 'SUBAGENT');
    assert.equal(first.snippetPath, 'frontend/AppScaffold.tsx');
    assert.equal(first.source, 'disk', 'source must be disk today (no cache layer)');
    assert.ok(typeof first.sizeBytes === 'number' && first.sizeBytes > 0, 'sizeBytes populated');
    assert.ok(typeof first.fetchedAt === 'number', 'fetchedAt populated');

    const mirror = getSnippetFetchMirror(sessionId);
    assert.equal(mirror.length, 2, `mirror should have 2 entries, got ${mirror.length}`);
    assert.equal(mirror[0].snippetPath, 'frontend/AppScaffold.tsx');

    resetSnippetFetchMirror(sessionId);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── PATH 3 — Auto-recovery record collection ──────────────────────────
test('PATH 3 — auto-recovery records: pushed onto session, picked up by writeRunSummary', () => {
  const session = { id: 'test-session-w3tel-recov-' + Date.now() };

  pushAutoRecoveryRecord(session, {
    scope: 'backend',
    attemptN: 1,
    triggeredBy: 'reconciler',
    failureSummary: '3 failure(s) [type-gate]',
    exhausted: false,
  });
  pushAutoRecoveryRecord(session, {
    scope: 'frontend',
    attemptN: 2,
    triggeredBy: 'reconciler',
    failureSummary: '1 failure(s) [structural]',
    exhausted: true,
  });

  assert.ok(Array.isArray(session.autoRecoveryAttempts), 'autoRecoveryAttempts must be array');
  assert.equal(session.autoRecoveryAttempts.length, 2);
  assert.equal(session.autoRecoveryAttempts[0].scope, 'backend');
  assert.equal(session.autoRecoveryAttempts[0].attemptN, 1);
  assert.equal(session.autoRecoveryAttempts[1].exhausted, true);
  assert.equal(session.autoRecoveryAttempts[1].triggeredBy, 'reconciler');

  writeRunSummary(session.id, {
    action: 'execute',
    autoRecoveryAttempts: session.autoRecoveryAttempts,
  });
  const summaryPath = path.join(runSummaryTest.SUMMARIES_DIR, `${session.id}.jsonl`);
  const summaryLines = readJsonl(summaryPath);
  assert.equal(summaryLines.length, 1);
  const rec = summaryLines[0];
  assert.ok(Array.isArray(rec.autoRecoveryAttempts), 'run-summary must include autoRecoveryAttempts');
  assert.equal(rec.autoRecoveryAttempts.length, 2);
  assert.equal(rec.autoRecoveryAttempts[0].scope, 'backend');
  assert.equal(rec.autoRecoveryAttempts[1].exhausted, true);

  rmSync(summaryPath, { force: true });
});

// ── PATH 4 — Investigator record collection ───────────────────────────
test('PATH 4 — investigator records: pushed onto session, picked up by writeRunSummary', () => {
  const session = { id: 'test-session-w3tel-invest-' + Date.now() };

  pushInvestigatorRecord(session, {
    symptom: 'login button does nothing',
    filesRead: ['frontend/src/Login.tsx', 'backend/src/auth.ts'],
    logsRead: ['frontend', 'backend'],
    rootCause: 'POST /api/login handler returns 500 because pool.query is not awaited',
    confidence: 0.88,
    recommendedFix: {
      scope: 'backend',
      description: 'await pool.query in /api/login handler',
      hasContractChange: false,
    },
  });

  assert.ok(Array.isArray(session.investigatorRecords), 'investigatorRecords must be array');
  assert.equal(session.investigatorRecords.length, 1);
  const r = session.investigatorRecords[0];
  assert.equal(r.confidence, 0.88);
  assert.deepEqual(r.filesRead, ['frontend/src/Login.tsx', 'backend/src/auth.ts']);
  assert.equal(r.recommendedFix.scope, 'backend');
  assert.equal(r.recommendedFix.hasContractChange, false);

  writeRunSummary(session.id, {
    action: 'diagnose',
    investigatorRecords: session.investigatorRecords,
  });
  const summaryPath = path.join(runSummaryTest.SUMMARIES_DIR, `${session.id}.jsonl`);
  const summaryLines = readJsonl(summaryPath);
  assert.equal(summaryLines.length, 1);
  const rec = summaryLines[0];
  assert.ok(Array.isArray(rec.investigatorRecords));
  assert.equal(rec.investigatorRecords.length, 1);
  assert.equal(rec.investigatorRecords[0].rootCause, r.rootCause);

  rmSync(summaryPath, { force: true });
});

// ── PATH 5 — logAndSwallow containment ────────────────────────────────
test('PATH 5 — logAndSwallow containment: all four telemetry writers tolerate write failure', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'w3-tel-bad-'));
  const badWorkspace = path.join(tmpDir, 'is-a-file');
  writeFileSync(badWorkspace, 'x');

  let stderrCapture = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrCapture += String(chunk);
    return origWrite(chunk, ...rest);
  };

  try {
    assert.doesNotThrow(() => {
      appendReconcilerVerdict(badWorkspace, {
        scope: 'backend', contractItem: 'GET /x', kind: 'api_contract', verdict: 'ok',
      });
    }, 'appendReconcilerVerdict must swallow write failure');

    assert.doesNotThrow(() => {
      appendSnippetFetch(badWorkspace, {
        sessionId: 's', scope: 'frontend', phase: 'SUBAGENT',
        snippetPath: 'x.tsx', sizeBytes: 10, source: 'disk',
      });
    }, 'appendSnippetFetch must swallow write failure');

    assert.doesNotThrow(() => {
      pushAutoRecoveryRecord(null, { scope: 'backend' });
      pushAutoRecoveryRecord({ id: 's' }, null);
      pushAutoRecoveryRecord({ id: 's' }, { scope: 'backend', attemptN: 1 });
    }, 'pushAutoRecoveryRecord must tolerate bad input');

    assert.doesNotThrow(() => {
      pushInvestigatorRecord(null, { symptom: 'x' });
      pushInvestigatorRecord({ id: 's' }, null);
      pushInvestigatorRecord({ id: 's' }, { symptom: 'x', confidence: 0.5 });
    }, 'pushInvestigatorRecord must tolerate bad input');
  } finally {
    process.stderr.write = origWrite;
    rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.ok(
    /\[telemetry-reconciler-verdicts\]/.test(stderrCapture),
    'reconciler-verdicts writer should log via [telemetry-reconciler-verdicts]',
  );
  assert.ok(
    /\[telemetry-snippet-fetches\]/.test(stderrCapture),
    'snippet-fetches writer should log via [telemetry-snippet-fetches]',
  );
});
