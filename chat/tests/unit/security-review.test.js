/**
 * Security-review phase — pure logic + file collection.
 *
 * Covers the findings parser (robust to fenced/garbage output), the
 * auto-fix/report partition (Critical/High grouped by scope; Medium/Low and
 * scope-less findings report-only), the bounded source collection (skips
 * node_modules/locks, honors caps), and the fix-directive formatting.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseSecurityFindings,
  partitionFindings,
  collectReviewFiles,
  formatSecurityFixDirective,
  SYSTEM_PROMPT,
} from '../../server/reconciler/security-review.js';

test('parseSecurityFindings: parses fenced JSON, normalizes severity, infers scope', () => {
  const content = '```json\n' + JSON.stringify({ findings: [
    { severity: 'critical', scope: 'backend', file: 'backend/src/db.ts', line: 10, summary: 'SQL by concat', fix: 'use $1' },
    { severity: 'Low', file: 'frontend/app.tsx', summary: 'debug log' },
  ] }) + '\n```';
  const f = parseSecurityFindings(content);
  assert.equal(f.length, 2);
  assert.equal(f[0].severity, 'Critical');           // normalized from lowercase
  assert.equal(f[1].scope, 'frontend');              // inferred from file path
});

test('parseSecurityFindings: drops invalid severities + summary-less entries', () => {
  const f = parseSecurityFindings(JSON.stringify({ findings: [
    { severity: 'Bogus', scope: 'backend', summary: 'x' },   // bad severity → dropped
    { severity: 'High', scope: 'backend' },                  // no summary → dropped
    { severity: 'High', scope: 'backend', summary: 'ok' },   // kept
  ] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].summary, 'ok');
});

test('parseSecurityFindings: garbage / empty → []', () => {
  assert.deepEqual(parseSecurityFindings('not json'), []);
  assert.deepEqual(parseSecurityFindings(''), []);
  assert.deepEqual(parseSecurityFindings('{"findings":[]}'), []);
  assert.deepEqual(parseSecurityFindings('prefix {"findings":[{"severity":"High","scope":"backend","summary":"y"}]} suffix').map(x => x.summary), ['y']);
});

test('partitionFindings: Critical/High grouped by scope; Medium/Low + scope-less → report-only', () => {
  const findings = [
    { severity: 'Critical', scope: 'backend', summary: 'a' },
    { severity: 'High', scope: 'backend', summary: 'b' },
    { severity: 'High', scope: 'frontend', summary: 'c' },
    { severity: 'Medium', scope: 'backend', summary: 'd' },
    { severity: 'Critical', scope: null, summary: 'e' },   // no scope → can't auto-fix
  ];
  const { criticalHigh, reportOnly, byScope } = partitionFindings(findings);
  assert.equal(criticalHigh.length, 3);
  assert.equal(reportOnly.length, 2);                       // the Medium + the scope-less Critical
  assert.deepEqual([...byScope.keys()].sort(), ['backend', 'frontend']);
  assert.equal(byScope.get('backend').length, 2);
});

test('collectReviewFiles: collects source, skips node_modules + lockfiles, honors scopes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'secreview-'));
  try {
    await mkdir(path.join(dir, 'backend', 'src'), { recursive: true });
    await mkdir(path.join(dir, 'backend', 'node_modules', 'x'), { recursive: true });
    await mkdir(path.join(dir, 'frontend'), { recursive: true });
    await mkdir(path.join(dir, 'database'), { recursive: true });
    await writeFile(path.join(dir, 'backend', 'src', 'index.ts'), 'export const x = 1;');
    await writeFile(path.join(dir, 'backend', 'Dockerfile'), 'FROM node\nUSER appuser');
    await writeFile(path.join(dir, 'backend', 'node_modules', 'x', 'evil.js'), 'nope');
    await writeFile(path.join(dir, 'backend', 'package-lock.json'), '{}');
    await writeFile(path.join(dir, 'frontend', 'app.tsx'), 'export {}');
    await writeFile(path.join(dir, 'database', 'init.sql'), 'CREATE TABLE t (id int);');

    const files = collectReviewFiles(dir, ['backend', 'frontend']);   // database excluded by scope
    const paths = files.map((f) => f.path).sort();
    assert.ok(paths.includes('backend/src/index.ts'), 'includes backend source');
    assert.ok(paths.includes('backend/Dockerfile'), 'includes Dockerfile');
    assert.ok(paths.includes('frontend/app.tsx'), 'includes frontend source');
    assert.ok(!paths.some((p) => p.includes('node_modules')), 'skips node_modules');
    assert.ok(!paths.some((p) => p.includes('package-lock')), 'skips lockfiles');
    assert.ok(!paths.some((p) => p.startsWith('database/')), 'respects scope filter');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatSecurityFixDirective: includes findings + rule anchor', () => {
  const d = formatSecurityFixDirective('backend', [
    { severity: 'Critical', file: 'backend/src/db.ts', line: 10, summary: 'SQL by concat', fix: 'use $1' },
  ]);
  assert.match(d, /SECURITY REVIEW — BACKEND/);
  assert.match(d, /02-security\.md/);
  assert.match(d, /SQL by concat/);
  assert.match(d, /backend\/src\/db\.ts:10/);
});

// Observed live (webhook-integration bench): the review flagged an ADMIN-configured
// webhook URL as SSRF and the auto-fix enforced https-only + private-range
// blocking — which makes an intranet webhook forwarder unusable in production.
test('review prompt scopes SSRF to non-admin URLs and forbids https-only / private-range mitigations', () => {
  assert.match(SYSTEM_PROMPT, /INSIDE the Bayer intranet/);
  assert.match(SYSTEM_PROMPT, /only an ADMIN configures[\s\S]*not SSRF/);
  assert.match(SYSTEM_PROMPT, /NEVER prescribe "https only" or "block private IP ranges"/);
  assert.match(SYSTEM_PROMPT, /169\.254\.0\.0\/16/);
});
