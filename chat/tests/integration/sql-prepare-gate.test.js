/**
 * sql-prepare-gate — Postgres-PREPARE oracle (docker-gated integration).
 *
 * Proves the two things the regex check could not:
 *   1. The exact JOIN that false-positived (`um.content` from a `FROM feedback`
 *      query) PREPAREs clean → NO finding. (The bug that started this effort.)
 *   2. A genuinely missing column (`feedback.content`) → a real finding.
 *
 * Boots the warm validator container (pulls pgvector on first run), so it's
 * skipped when docker is unavailable — mirrors read-container-logs.test.js. Also
 * skips (rather than fails) if the validator can't come up (no network/image),
 * since the gate itself fails open in that case.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSqlPrepareGate } from '../../server/reconciler/sql-prepare-gate.js';
import { stopValidator } from '../../server/reconciler/sql-validation-db.js';

function dockerAvailable() {
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 8_000 }); return true; } catch { return false; }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY, conversation_id INT, role TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY, message_id INT, rating INT, comment TEXT, created_at TIMESTAMP DEFAULT NOW()
  );
`;

function mkWorkspace(routesTs, { vectorSql = null, vectorSh = null } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlgate-'));
  fs.mkdirSync(path.join(ws, 'backend', 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'database', 'init'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'backend', 'tsconfig.json'), '{}'); // → detectRuntime 'node'
  fs.writeFileSync(path.join(ws, 'backend', 'src', 'index.ts'), '// entry\n');
  fs.writeFileSync(path.join(ws, 'backend', 'src', 'routes.ts'), routesTs);
  fs.writeFileSync(path.join(ws, 'database', 'init', '01_schema.sql'), SCHEMA);
  if (vectorSql || vectorSh) {
    fs.mkdirSync(path.join(ws, 'vectordb', 'init'), { recursive: true });
    if (vectorSql) fs.writeFileSync(path.join(ws, 'vectordb', 'init', '01_init.sql'), vectorSql);
    if (vectorSh) fs.writeFileSync(path.join(ws, 'vectordb', 'init', '01_init.sh'), vectorSh);
  }
  return ws;
}

after(async () => { try { await stopValidator(); } catch { /* ignore */ } });

test('the JOIN that false-positived PREPAREs clean — no finding', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function list(pool) {
      return pool.query(\`SELECT f.comment, um.content AS question
        FROM feedback f
        JOIN messages um ON um.conversation_id = f.message_id AND um.role = 'user'\`, []);
    }
  `);
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 0, `correct JOIN must not flag; got ${JSON.stringify(findings)}`);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a missing column (feedback.content) → sql-undeclared-column finding', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function bad(pool) {
      return pool.query('SELECT id, content FROM feedback WHERE id = $1', [1]);
    }
  `);
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'sql-undeclared-column');
    assert.equal(findings[0].severity, 'hard');
    assert.match(findings[0].contract, /content/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The ex-mediumhard regression: a relational `documents` table (no embedding)
// AND a vector `documents` table (with embedding) coexist. Merging both into
// one DB collided — the vector table was skipped (name taken), then its index
// on `embedding` failed, the schema load aborted, and the gate failed open.
// Per-scope DBs + pool routing must let BOTH pools' queries PREPARE cleanly.
const VECTOR_SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY, content TEXT, embedding VECTOR(3)
  );
`;
// database/init also defines a DIFFERENT documents table (no embedding column).
const REL_DOCS = `
  CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY, title TEXT, owner_id INT
  );
`;

test('same-named table across database + vectordb scopes does not collide (no finding)', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function rel(pool) {
      return pool.query('SELECT id, title FROM documents WHERE owner_id = $1', [1]);
    }
    export async function vec(vectorPool) {
      return vectorPool.query('SELECT id, content FROM documents ORDER BY embedding <=> $1::vector LIMIT 5', [v]);
    }
  `, { vectorSql: VECTOR_SCHEMA });
  // Append the relational documents table to the default schema file.
  fs.appendFileSync(path.join(ws, 'database', 'init', '01_schema.sql'), REL_DOCS);
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 0, `no collision expected; got ${JSON.stringify(findings)}`);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a table the app CREATEs in code (not init.sql) is not flagged (DDL applied first)', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  // No vectordb/init for this table — the app creates it at startup, exactly
  // like the real contract_chunks case that false-flagged. We still need a
  // vectordb/init so the vector scope DB exists; it just defines a vector ext.
  const ws = mkWorkspace(`
    export async function initVec(vectorPool) {
      return vectorPool.query(\`
        CREATE TABLE IF NOT EXISTS contract_chunks (
          id SERIAL PRIMARY KEY, contract_id INT, content TEXT, embedding VECTOR(3)
        );
        CREATE INDEX IF NOT EXISTS cc_idx ON contract_chunks USING hnsw (embedding vector_cosine_ops);
      \`);
    }
    export async function search(vectorPool) {
      return vectorPool.query('SELECT id, content FROM contract_chunks ORDER BY embedding <=> $1::vector LIMIT 5', [v]);
    }
  `, { vectorSql: 'CREATE EXTENSION IF NOT EXISTS vector;' });
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 0, `app-created table must not flag; got ${JSON.stringify(findings)}`);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a vector-pool query on a missing column is still caught', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function vec(vectorPool) {
      return vectorPool.query('SELECT id, nope FROM documents LIMIT 1', []);
    }
  `, { vectorSql: VECTOR_SCHEMA });
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'sql-undeclared-column');
    assert.match(findings[0].contract, /nope/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The exact destabilization case: a table defined in a .sh init script (the
// pgvector scaffold's pattern). The gate must LOAD it from the .sh — otherwise
// it false-flags the table as missing and the re-engage loop corrupts the build.
const VECTOR_SH = `#!/bin/bash
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id SERIAL PRIMARY KEY, contract_id INT, chunk_text TEXT, embedding VECTOR(3)
  );
EOSQL
echo "done"
`;

test('a table defined only in a .sh init script is loaded → query is not flagged', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function read(vectorPool) {
      return vectorPool.query('SELECT id, chunk_text FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT 5', [v]);
    }
  `, { vectorSh: VECTOR_SH });
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 0, `.sh-defined table must load; got ${JSON.stringify(findings)}`);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a bad column on a .sh-defined table is still caught (proves .sh loaded)', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function read(vectorPool) {
      return vectorPool.query('SELECT id, nope FROM kb_chunks LIMIT 1', []);
    }
  `, { vectorSh: VECTOR_SH });
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'sql-undeclared-column');
    assert.match(findings[0].contract, /nope/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a genuinely missing table is fail-open — no finding (never blocks/re-engages)', { timeout: 300_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip('docker not available'); return; }
  const ws = mkWorkspace(`
    export async function x(pool) {
      return pool.query('SELECT id, content FROM totally_missing_table WHERE id = $1', [1]);
    }
  `);
  try {
    const { ran, findings } = await runSqlPrepareGate(ws, {});
    if (!ran) { t.skip('validator DB unavailable (docker/image)'); return; }
    assert.equal(findings.length, 0, `missing table must fail-open; got ${JSON.stringify(findings)}`);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
