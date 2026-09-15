/**
 * Pre-stage stages the migration runner for Node backends with a database,
 * and the Node Dockerfile template ships backend/migrations/ into the
 * runtime image — the two halves that make migrations run in production.
 *
 * Modules under test:
 *   chat/server/agent/coordinator/pre-stage-scaffolds.js
 *   backend/Dockerfile.node (template content)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { preStageScaffolds, MIGRATION_RUNNER_PATH } from '../../server/agent/coordinator/pre-stage-scaffolds.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const dataModel = { tables: [
  { name: 'notes', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'title', type: 'TEXT NOT NULL' }] },
] };
const apiContract = { endpoints: [{ method: 'GET', path: '/notes' }, { method: 'POST', path: '/notes', request: { title: 'string required' } }] };

function contract(overrides = {}) {
  return {
    dataModel, apiContract, uiContract: null, vectorEngine: null, businessLogicContract: null,
    flags: [], mgaAssistants: [],
    tasks: [{ scope: 'database', dockerfile: 'Dockerfile.postgres' }, { scope: 'backend', dockerfile: 'Dockerfile.node' }],
    ...overrides,
  };
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'prestage-')); }

test('fresh Node build with a database stages backend/src/lib/migrate.ts (ESM-safe, ledger-backed)', () => {
  const wd = tmp();
  try {
    const out = preStageScaffolds({ workspaceDir: wd, contract: contract(), isIterate: false });
    assert.ok(out.filesEmitted.includes(MIGRATION_RUNNER_PATH), out.filesEmitted.join(','));
    const src = fs.readFileSync(path.join(wd, MIGRATION_RUNNER_PATH), 'utf-8');
    assert.match(src, /import\.meta\.url/);
    assert.doesNotMatch(src, /__dirname|process\.cwd\(\)|require\(/);
    assert.match(src, /CREATE TABLE IF NOT EXISTS _migrations/);
    assert.match(src, /'\.\.', '\.\.', 'migrations'/);
    assert.ok(out.files.some((f) => f.relPath === MIGRATION_RUNNER_PATH && f.content === src));
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test('no database, or a Python backend → runner not staged', () => {
  for (const c of [
    contract({ dataModel: null, tasks: [{ scope: 'backend', dockerfile: 'Dockerfile.node' }] }),
    contract({ tasks: [{ scope: 'database', dockerfile: 'Dockerfile.postgres' }, { scope: 'backend', dockerfile: 'Dockerfile.python' }] }),
  ]) {
    const wd = tmp();
    try {
      const out = preStageScaffolds({ workspaceDir: wd, contract: c, isIterate: false });
      assert.ok(!out.filesEmitted.includes(MIGRATION_RUNNER_PATH));
      assert.ok(!fs.existsSync(path.join(wd, MIGRATION_RUNNER_PATH)));
    } finally { fs.rmSync(wd, { recursive: true, force: true }); }
  }
});

test('iterate on an app built before the runner existed stages it once and never overwrites a custom copy', () => {
  const wd = tmp();
  try {
    fs.mkdirSync(path.join(wd, 'database', 'init'), { recursive: true });
    const first = preStageScaffolds({ workspaceDir: wd, contract: contract(), isIterate: true, iterateDiffs: {} });
    assert.ok(first.filesEmitted.includes(MIGRATION_RUNNER_PATH));
    const custom = '// custom runner\n';
    fs.writeFileSync(path.join(wd, MIGRATION_RUNNER_PATH), custom);
    const second = preStageScaffolds({ workspaceDir: wd, contract: contract(), isIterate: true, iterateDiffs: {} });
    assert.equal(fs.readFileSync(path.join(wd, MIGRATION_RUNNER_PATH), 'utf-8'), custom);
    // Still captured for the spawn message so the agent imports the real name.
    assert.ok(second.files.some((f) => f.relPath === MIGRATION_RUNNER_PATH && f.content === custom));
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test('Dockerfile.node template ships migrations/ into the runtime stage', () => {
  const df = fs.readFileSync(path.join(ROOT, 'backend', 'Dockerfile.node'), 'utf-8');
  assert.match(df, /RUN npm run build && mkdir -p migrations/);
  assert.match(df, /COPY --from=builder --chown=appuser:appgroup \/app\/migrations \.\/migrations/);
});

// ── workspace .env (the only place local credential values live) ────────────

test('pre-stage writes the workspace .env with DATABASE_* (and VECTORDB_* for pgvector), never into out.files', () => {
  const wd = tmp();
  try {
    const out = preStageScaffolds({ workspaceDir: wd, contract: contract(), isIterate: false });
    const env = fs.readFileSync(path.join(wd, '.env'), 'utf-8');
    assert.match(env, /^DATABASE_NAME=myapp$/m);
    assert.match(env, /^DATABASE_PASSWORD=localdev123$/m);
    assert.doesNotMatch(env, /VECTORDB_/);
    assert.ok(!out.filesEmitted.includes('.env'), '.env is gitignored and later carries the MGA key — never a staged file');
    // iterate keeps a hand-edited value and only adds what is missing
    fs.writeFileSync(path.join(wd, '.env'), 'DATABASE_PASSWORD=mine\n');
    preStageScaffolds({ workspaceDir: wd, contract: contract({ vectorEngine: 'pgvector', tasks: [...contract().tasks, { scope: 'vectordb', dockerfile: 'Dockerfile.pgvector' }] }), isIterate: true });
    const after = fs.readFileSync(path.join(wd, '.env'), 'utf-8');
    assert.match(after, /^DATABASE_PASSWORD=mine$/m);
    assert.match(after, /^DATABASE_NAME=myapp$/m);
    assert.match(after, /^VECTORDB_USER=vectordb_user$/m);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test('backend without a database still gets an (empty) .env for env_file to load', () => {
  const wd = tmp();
  try {
    preStageScaffolds({ workspaceDir: wd, contract: contract({ dataModel: null, tasks: [{ scope: 'backend', dockerfile: 'Dockerfile.node' }] }), isIterate: false });
    const env = fs.readFileSync(path.join(wd, '.env'), 'utf-8');
    assert.doesNotMatch(env, /DATABASE_|VECTORDB_/);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});
