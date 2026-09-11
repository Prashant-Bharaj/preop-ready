/**
 * init-sql-validator — DB-switching strip coverage.
 *
 * The exact live shape (2026-07-16, sop-assistant): a gate-fix agent wrote
 * `CREATE DATABASE stub_db` + `\connect stub_db` into vectordb/init/01_init.sql,
 * so doc_chunks landed in stub_db while the app connected to POSTGRES_DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scanInitSqlForDbSwitching,
  applyDbSwitchingFixes,
} from '../../server/validators/db/init-sql-validator.js';

function workspace(initSql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'initsql-'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), `
services:
  vectordb:
    build:
      context: ./vectordb
      dockerfile: Dockerfile
    environment:
      - POSTGRES_DB=vectors
`, 'utf-8');
  fs.mkdirSync(path.join(dir, 'vectordb', 'init'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vectordb', 'Dockerfile'), 'FROM pgvector/pgvector:0.7.4-pg16\nCOPY init/ /docker-entrypoint-initdb.d/\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'vectordb', 'init', '01_init.sql'), initSql, 'utf-8');
  return dir;
}
const readSql = (dir) => fs.readFileSync(path.join(dir, 'vectordb', 'init', '01_init.sql'), 'utf-8');

const POISONED = `-- AUTO-GENERATED
CREATE EXTENSION IF NOT EXISTS vector;
SELECT 'CREATE DATABASE stub_db' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'stub_db')\\gexec
\\connect stub_db
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS doc_chunks (
  id SERIAL PRIMARY KEY,
  embedding VECTOR(1536)
);
`;

test('detects CREATE DATABASE and \\connect lines; skips comments', () => {
  const dir = workspace(POISONED);
  const issues = scanInitSqlForDbSwitching(dir);
  assert.equal(issues.length, 2);
  assert.ok(issues.some((i) => /CREATE DATABASE/.test(i.statement)));
  assert.ok(issues.some((i) => i.statement.startsWith('\\connect')));
});

test('apply comments the lines out; tables/extensions untouched; idempotent', () => {
  const dir = workspace(POISONED);
  const applied = applyDbSwitchingFixes(dir, scanInitSqlForDbSwitching(dir));
  assert.equal(applied.length, 2);
  const out = readSql(dir);
  assert.match(out, /-- \[platform\] removed .*CREATE DATABASE stub_db/);
  assert.match(out, /-- \[platform\] removed .*\\connect stub_db/);
  assert.match(out, /CREATE TABLE IF NOT EXISTS doc_chunks/);
  assert.match(out, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.equal(scanInitSqlForDbSwitching(dir).length, 0);
});

test('clean init SQL (extension + tables only) → no issues', () => {
  const dir = workspace('CREATE EXTENSION IF NOT EXISTS vector;\nCREATE TABLE t (id SERIAL PRIMARY KEY);\n');
  assert.deepEqual(scanInitSqlForDbSwitching(dir), []);
});
