/**
 * Unit tests for chat/server/agent/coordinator/build-summary.js — the
 * deterministic state.md + build report generator that replaces the LLM
 * orchestrator's end-of-build authoring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateBuildSummary } from '../../server/agent/coordinator/build-summary.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — synthesize completion reports + contracts to drive the generator
// ─────────────────────────────────────────────────────────────────────────────

// Synthesize a subagent attempt_completion text in the canonical format
// (chat/prompts/subagent-base.md). Maps the legacy test-status vocabulary:
//   'completed' → 'complete' (subagents emit complete, not completed)
//   'failed'    → 'failed'   (back-compat — explicit terminal-failure marker)
//   anything else → passed through (partial / infeasible / incomplete / ...)
function makeCompletionText({ scope, description, status = 'complete', filesWritten = ['file1.ts'], body = '' }) {
  const reportStatus = status === 'completed' ? 'complete' : status;
  const filesBlock = filesWritten.length === 0
    ? 'none'
    : filesWritten.map(p => `- ${p}`).join('\n');
  return [
    '--- PHASE AGENT REPORT ---',
    '',
    `**Scope:** ${scope}`,
    '',
    `**Status:** ${reportStatus}`,
    '',
    `**Files written:**`,
    filesBlock,
    '',
    `**Summary:**`,
    '',
    body || `${scope} subagent completed task: ${description}.`,
    '',
    '--- END REPORT ---',
  ].join('\n');
}

function baseContract() {
  return {
    tasks: [
      { scope: 'database', summary: 'pg schema', task: 'tables: tasks', dockerfile: 'Dockerfile.postgres' },
      { scope: 'backend', summary: 'express crud', task: 'CRUD on /tasks', dockerfile: 'Dockerfile.node', primarySnippet: 'backend/express-server-template.ts' },
      { scope: 'frontend', summary: 'react app', task: 'list+create', dockerfile: 'Dockerfile.react' },
      { scope: 'integration', summary: 'compose', task: 'wire all', dockerfile: null },
    ],
    flags: ['has-users'],
    apiContract: {
      endpoints: [
        { method: 'GET', path: '/tasks', purpose: 'list all tasks' },
        { method: 'POST', path: '/tasks', purpose: 'create a task' },
      ],
    },
    dataModel: { tables: [{ name: 'tasks', columns: [] }] },
    uiContract: { primary_view: 'list', primary_action: 'create' },
    businessLogicContract: { triggers: [], rules: [], side_effects: [] },
    vectorEngine: null,
    mgaAssistants: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clean build — everything completes, no issues
// ─────────────────────────────────────────────────────────────────────────────

test('clean build: status="built", per-scope built prose, no known_issues', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg schema for tasks', body: 'Postgres schema with tasks table and pgdata volume.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'express crud', body: 'Express + TypeScript CRUD on /tasks with /health endpoint.' }),
    frontend: makeCompletionText({ scope: 'frontend', description: 'react app', body: 'React + Vite app with task list view and create form.' }),
    integration: makeCompletionText({ scope: 'integration', description: 'docker-compose', body: 'docker-compose wiring backend + database with healthchecks.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend', 'frontend', 'integration'],
  });

  assert.equal(result.status, 'built');
  assert.equal(result.stateMd.stack.backend_language, 'node');
  assert.equal(result.stateMd.stack.database, 'postgres');
  assert.equal(result.stateMd.stack.frontend, 'react-vite');
  assert.equal(result.stateMd.stack.vector_engine, undefined);
  assert.equal(result.stateMd.known_issues.length, 0);
  assert.match(result.stateMd.built.database, /Postgres schema/);
  assert.match(result.stateMd.built.backend, /Express \+ TypeScript/);
  assert.match(result.stateMd.built.frontend, /React \+ Vite/);
  assert.match(result.buildReport, /Status:\*\* built/);
  assert.match(result.buildReport, /- database: file1\.ts/);
  assert.match(result.buildReport, /GET \/api\/tasks/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Partial build — one scope reports Status: partial
// ─────────────────────────────────────────────────────────────────────────────

test('partial build: status="partial" when a scope reports partial', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', body: 'Schema built.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'be', status: 'partial', body: 'Backend partially built — auth missing.' }),
    frontend: makeCompletionText({ scope: 'frontend', description: 'fe', body: 'Frontend built.' }),
    integration: makeCompletionText({ scope: 'integration', description: 'int', body: 'Compose wired.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend', 'frontend', 'integration'],
  });

  assert.equal(result.status, 'partial');
  assert.ok(result.stateMd.known_issues.some(i => i.scope === 'backend' && /partial/i.test(i.description)));
});

// ─────────────────────────────────────────────────────────────────────────────
// Failed build — a scope has no completion report
// ─────────────────────────────────────────────────────────────────────────────

test('failed build: status="failed" when a scope is missing from completionReports', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', body: 'OK.' }),
    // backend missing
    frontend: makeCompletionText({ scope: 'frontend', description: 'fe', body: 'OK.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend', 'frontend'],
  });

  assert.equal(result.status, 'failed');
});

test('failed build: status="failed" when explicit Status: failed in completionText', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', body: 'OK.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'be', status: 'failed', filesWritten: [], body: 'Crashed during build.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend'],
  });

  assert.equal(result.status, 'failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Files written: none detection (non-integration)
// ─────────────────────────────────────────────────────────────────────────────

test('empty files for frontend → known_issue + partial status', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', body: 'OK.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'be', body: 'OK.' }),
    frontend: makeCompletionText({ scope: 'frontend', description: 'fe', filesWritten: [], body: 'Could not generate frontend.' }),
    integration: makeCompletionText({ scope: 'integration', description: 'int', body: 'Compose.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend', 'frontend', 'integration'],
  });

  assert.equal(result.status, 'partial');
  assert.ok(result.stateMd.known_issues.some(i => i.scope === 'frontend' && /no files written/i.test(i.description)));
});

test('empty files for integration → NOT flagged (compose may be implicit)', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', body: 'OK.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'be', body: 'OK.' }),
    frontend: makeCompletionText({ scope: 'frontend', description: 'fe', body: 'OK.' }),
    integration: makeCompletionText({ scope: 'integration', description: 'int', filesWritten: [], body: 'No new files needed.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend', 'frontend', 'integration'],
  });

  assert.equal(result.status, 'built');
  assert.ok(!result.stateMd.known_issues.some(i => i.scope === 'integration'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Stack derivation
// ─────────────────────────────────────────────────────────────────────────────

test('stack: python backend detected from Dockerfile.python', () => {
  const contract = baseContract();
  contract.tasks.find(t => t.scope === 'backend').dockerfile = 'Dockerfile.python';
  const completionReports = {
    backend: makeCompletionText({ scope: 'backend', description: 'fastapi', body: 'OK.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['backend'],
  });

  assert.equal(result.stateMd.stack.backend_language, 'python');
});

test('stack: vector_engine populated when present in contract', () => {
  const contract = baseContract();
  contract.vectorEngine = 'pgvector';
  contract.tasks.push({ scope: 'vectordb', summary: 'vdb', task: 'pgvector setup', dockerfile: 'Dockerfile.pgvector' });
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', body: 'OK.' }),
    vectordb: makeCompletionText({ scope: 'vectordb', description: 'vdb', body: 'OK.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'be', body: 'OK.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'vectordb', 'backend'],
  });

  assert.equal(result.stateMd.stack.vector_engine, 'pgvector');
});

// ─────────────────────────────────────────────────────────────────────────────
// Build report rendering
// ─────────────────────────────────────────────────────────────────────────────

test('build report: contains scopes built, endpoints, run-locally, no known issues block when clean', () => {
  const contract = baseContract();
  const completionReports = {
    database: makeCompletionText({ scope: 'database', description: 'pg', filesWritten: ['init.sql', 'Dockerfile'], body: 'OK.' }),
    backend: makeCompletionText({ scope: 'backend', description: 'be', filesWritten: ['src/index.ts', 'package.json'], body: 'OK.' }),
    frontend: makeCompletionText({ scope: 'frontend', description: 'fe', filesWritten: ['src/App.tsx'], body: 'OK.' }),
    integration: makeCompletionText({ scope: 'integration', description: 'int', filesWritten: ['docker-compose.yml'], body: 'OK.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['database', 'backend', 'frontend', 'integration'],
  });

  assert.match(result.buildReport, /Status:\*\* built/);
  assert.match(result.buildReport, /- database: init\.sql, Dockerfile/);
  assert.match(result.buildReport, /- backend: src\/index\.ts, package\.json/);
  assert.match(result.buildReport, /GET \/api\/tasks/);
  assert.match(result.buildReport, /POST \/api\/tasks/);
  assert.match(result.buildReport, /docker compose up --build/);
  assert.match(result.buildReport, /http:\/\/localhost:8080/);
  assert.doesNotMatch(result.buildReport, /Known issues:/);
});

test('build report: includes iterate banner when iterate mode', () => {
  const contract = baseContract();
  const completionReports = {
    backend: makeCompletionText({ scope: 'backend', description: 'be', body: 'Fixed endpoint.' }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['backend'],
    iterate: { summary: 'add /comments endpoint', affectedScopes: ['backend'], contractDiffs: {} },
  });

  assert.match(result.buildReport, /Mode:\*\* iterate/);
  assert.match(result.buildReport, /affected scopes: backend/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

test('edge: empty dispatchedScopes → status=failed, no built entries', () => {
  const result = generateBuildSummary({
    contract: baseContract(),
    completionReports: {},
    dispatchedScopes: [],
  });

  assert.equal(result.status, 'failed');
  assert.equal(Object.keys(result.stateMd.built).length, 0);
});

test('edge: missing completion text → recorded as issue, status=failed', () => {
  const contract = baseContract();
  const result = generateBuildSummary({
    contract,
    completionReports: { database: '', backend: makeCompletionText({ scope: 'backend', description: 'be', body: 'OK.' }) },
    dispatchedScopes: ['database', 'backend'],
  });

  assert.equal(result.status, 'failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Real-format regression — copied verbatim from a smoke run's transcript so
// the parser exercises the actual subagent output, not synthesized fixtures.
// Catches the smoke-discovered bug where state.md `built` was empty for every
// scope because the parser matched [PHASE AGENT RESULT] (legacy wrapper) but
// the stash actually stores --- PHASE AGENT REPORT --- (subagent prose).
// ─────────────────────────────────────────────────────────────────────────────

test('real format: parses canonical subagent report end-to-end (state.md + build report)', () => {
  const realDatabase = `--- PHASE AGENT REPORT ---

**Scope:** database

**Status:** complete

**Files written:**
- database/Dockerfile
- database/init/init.sql

**Summary:**

Created PostgreSQL database schema for the URL word count analyzer application. The schema consists of a single \`url_checks\` table that stores URL analysis results with word count and reading time metrics.

The init script includes idempotent DDL with descending indexes for history queries.

**Contracts for sibling scopes:**

**Tables:**
- \`url_checks\` — id (SERIAL PRIMARY KEY), url (TEXT NOT NULL)

--- END REPORT ---`;

  const realFrontendPartial = `--- PHASE AGENT REPORT ---

**Scope:** frontend

**Status:** partial

**Files written:**
- frontend/src/App.tsx
- frontend/src/components/Toast.tsx

**Summary:**

Built a React + Vite frontend with URL validation workflow. Main view displays a single-page form (URL input + Analyze button).

**UNABLE TO RESOLVE:**

Build fails with "Toaster" is not exported by "src/components/Toast.tsx". App.tsx imports Toaster but Toast.tsx does not export this component.

--- END REPORT ---`;

  const contract = baseContract();
  const result = generateBuildSummary({
    contract,
    completionReports: { database: realDatabase, backend: makeCompletionText({ scope: 'backend', description: 'be' }), frontend: realFrontendPartial, integration: makeCompletionText({ scope: 'integration', description: 'int', filesWritten: ['docker-compose.yml'] }) },
    dispatchedScopes: ['database', 'backend', 'frontend', 'integration'],
  });

  assert.equal(result.status, 'partial', 'frontend partial → overall partial');
  assert.match(result.stateMd.built.database, /PostgreSQL database schema/);
  assert.match(result.stateMd.built.frontend, /React \+ Vite/);
  // Build report should list real filenames, not "**"
  assert.match(result.buildReport, /- database: database\/Dockerfile, database\/init\/init\.sql/);
  assert.match(result.buildReport, /- frontend: frontend\/src\/App\.tsx, frontend\/src\/components\/Toast\.tsx/);
  // Frontend's partial status surfaces as a known issue
  assert.ok(result.stateMd.known_issues.some(i => i.scope === 'frontend' && /partial/i.test(i.description)),
    'frontend partial status should appear as known_issue');
  // UNABLE TO RESOLVE caveat extracted
  assert.ok(result.stateMd.known_issues.some(i => i.scope === 'frontend' && /Toaster.*not exported/.test(i.description)),
    'frontend UNABLE TO RESOLVE caveat should appear as known_issue');
});

test('first paragraph: truncates long completion text gracefully', () => {
  const contract = baseContract();
  const longBody = 'Built a comprehensive backend service. '.repeat(50); // ~2000 chars
  const completionReports = {
    backend: makeCompletionText({ scope: 'backend', description: 'be', body: longBody }),
  };

  const result = generateBuildSummary({
    contract,
    completionReports,
    dispatchedScopes: ['backend'],
  });

  // First paragraph should be capped at ~400 chars
  assert.ok(result.stateMd.built.backend.length <= 410, `built prose ${result.stateMd.built.backend.length} chars > 410 cap`);
  assert.match(result.stateMd.built.backend, /Built a comprehensive backend/);
});

test('synthetic partial report (agent died after writing) → partial, never failed', () => {
  // Shape produced by phase-tools recordReportOrSyntheticPartial when a
  // failed agent had already written files this dispatch.
  const synthetic = [
    '--- PHASE AGENT REPORT ---',
    '**Scope:** database',
    '**Status:** partial',
    '**Files written:** database/init/01_schema.sql, database/migrations/002_add_corrective_action.sql',
    '',
    '**Summary:** Agent terminated before reporting; the files above were written this dispatch and are verified by the downstream gates.',
  ].join('\n');

  const result = generateBuildSummary({
    contract: baseContract(),
    completionReports: {
      database: synthetic,
      backend: makeCompletionText({ scope: 'backend', description: 'be' }),
    },
    dispatchedScopes: ['database', 'backend'],
  });

  assert.equal(result.status, 'partial');
  assert.ok(result.stateMd.known_issues.some(i => i.scope === 'database' && /partial/i.test(i.description)),
    'synthetic partial should surface as a known_issue');
  assert.match(result.stateMd.built.database, /terminated before reporting/);
});
