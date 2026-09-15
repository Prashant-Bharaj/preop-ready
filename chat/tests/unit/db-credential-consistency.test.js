/**
 * db-credential-consistency-validator — unit coverage.
 *
 * Deterministic enforcement of the canonical local-dev credential wiring:
 * values in the workspace-root `.env`, `${DATABASE_*}` / `${VECTORDB_*}`
 * references on the db services, `env_file: .env` on the backend. Covers the
 * failures that shipped broken (or uncommittable) apps: the integration agent
 * inlined literal passwords, renamed the database/user to the project theme on
 * one service only, or dropped POSTGRES_PASSWORD entirely. Writes a temp
 * docker-compose.yml per case (the validator reads/writes from disk).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import {
  scanComposeForCredentialDrift,
  applyCredentialConsistencyFixes,
} from '../../server/validators/db/db-credential-consistency-validator.js';
import { LOCAL_DB_CREDENTIALS, LOCAL_VECTORDB_CREDENTIALS } from '../../server/config/defaults.js';
import { readEnvFile } from '../../server/core/workspace-env.js';

function tmpWorkspace(composeYaml, env = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credval-'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), composeYaml, 'utf-8');
  if (env != null) fs.writeFileSync(path.join(dir, '.env'), env, 'utf-8');
  return dir;
}
const read = (dir) => fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf-8');
const env = (dir) => readEnvFile(path.join(dir, '.env'));
const fixAll = (dir) => applyCredentialConsistencyFixes(dir, scanComposeForCredentialDrift(dir));

// The exact failure mode: literal creds on both sides, db renamed to the
// project theme, backend left on myapp.
const DRIFTED_OBJECT_FORM = `
services:
  backend:
    build: ./backend
    depends_on:
      database:
        condition: service_healthy
    environment:
      DATABASE_HOST: database
      DATABASE_PORT: 5432
      DATABASE_NAME: myapp
      DATABASE_USER: myapp_user
      DATABASE_PASSWORD: localdev123
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: tasktracker
      POSTGRES_USER: tasktracker_user
      POSTGRES_PASSWORD: localdev123
`;

// What every case must converge to.
function assertCanonical(dir, { vectordb = false } = {}) {
  const out = read(dir);
  assert.doesNotMatch(out, /_PASSWORD[=:][ \t]*[^$\s]/, 'no literal password may remain in compose');
  const doc = YAML.parse(out);
  const backend = doc.services.backend;
  const envFiles = [].concat(backend.env_file).map((e) => (typeof e === 'string' ? e : e.path));
  assert.ok(envFiles.includes('.env'), `backend env_file must list .env (got ${JSON.stringify(backend.env_file)})`);
  const e = env(dir);
  assert.equal(e.DATABASE_NAME, LOCAL_DB_CREDENTIALS.name);
  assert.equal(e.DATABASE_USER, LOCAL_DB_CREDENTIALS.user);
  assert.equal(e.DATABASE_PASSWORD, LOCAL_DB_CREDENTIALS.password);
  if (vectordb) {
    assert.equal(e.VECTORDB_NAME, LOCAL_VECTORDB_CREDENTIALS.name);
    assert.equal(e.VECTORDB_USER, LOCAL_VECTORDB_CREDENTIALS.user);
    assert.equal(e.VECTORDB_PASSWORD, LOCAL_VECTORDB_CREDENTIALS.password);
  }
  // idempotent: a second pass finds nothing
  assert.deepEqual(scanComposeForCredentialDrift(dir), []);
}

test('literal creds (object form) → ${DATABASE_*} references, env_file, .env written', () => {
  const dir = tmpWorkspace(DRIFTED_OBJECT_FORM);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(issues.some((i) => i.service === 'database' && i.key === 'POSTGRES_DB' && i.to === '${DATABASE_NAME}'));
  assert.ok(issues.some((i) => i.service === 'backend' && i.key === 'DATABASE_PASSWORD' && i.to === '${DATABASE_PASSWORD}'));
  assert.ok(issues.some((i) => i.service === 'backend' && i.key === 'env_file' && i.to === '.env'));
  assert.ok(issues.some((i) => i.file === '.env' && i.key === 'DATABASE_PASSWORD' && i.to === LOCAL_DB_CREDENTIALS.password));
  const applied = applyCredentialConsistencyFixes(dir, issues);
  assert.equal(applied.length, issues.length);
  const out = read(dir);
  assert.match(out, /POSTGRES_DB:\s*\$\{DATABASE_NAME\}/);
  assert.match(out, /POSTGRES_USER:\s*\$\{DATABASE_USER\}/);
  assert.match(out, /POSTGRES_PASSWORD:\s*\$\{DATABASE_PASSWORD\}/);
  assert.match(out, /backend:\n\s+env_file:\n\s+- \.env\n/);
  assert.doesNotMatch(out, /tasktracker|localdev123/);
  assertCanonical(dir);
});

test('list form (- KEY=val) is rewritten in place', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [database]
    environment:
      - DATABASE_HOST=database
      - DATABASE_PORT=5432
      - DATABASE_NAME=tasktracker
      - DATABASE_USER=tasktracker_user
      - DATABASE_PASSWORD=hunter2
  database:
    image: postgres:16
    environment:
      - POSTGRES_DB=tasktracker
      - POSTGRES_USER=tasktracker_user
      - POSTGRES_PASSWORD=hunter2
`);
  fixAll(dir);
  const out = read(dir);
  assert.match(out, /- DATABASE_NAME=\$\{DATABASE_NAME\}/);
  assert.match(out, /- DATABASE_PASSWORD=\$\{DATABASE_PASSWORD\}/);
  assert.match(out, /- POSTGRES_DB=\$\{DATABASE_NAME\}/);
  assert.match(out, /- POSTGRES_PASSWORD=\$\{DATABASE_PASSWORD\}/);
  assert.doesNotMatch(out, /tasktracker|hunter2/);
  assertCanonical(dir);
});

test('already-canonical compose + .env → zero fixes', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    env_file:
      - .env
      - path: backend/.env
        required: false
    environment:
      - PORT=3000
      - DATABASE_HOST=database
      - DATABASE_PORT=5432
    depends_on: [database]
  database:
    build: ./database
    environment:
      POSTGRES_DB: \${DATABASE_NAME}
      POSTGRES_USER: \${DATABASE_USER}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD:-fallback}
`, 'DATABASE_NAME=myapp\nDATABASE_USER=myapp_user\nDATABASE_PASSWORD=localdev123\n');
  assert.deepEqual(scanComposeForCredentialDrift(dir), []);
});

test('sets DATABASE_HOST to the actual db service name when it differs', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [db]
    environment:
      DATABASE_HOST: localhost
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: \${DATABASE_NAME}
      POSTGRES_USER: \${DATABASE_USER}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD}
`);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(issues.some((i) => i.key === 'DATABASE_HOST' && i.to === 'db'));
  applyCredentialConsistencyFixes(dir, issues);
  assert.match(read(dir), /DATABASE_HOST:\s*db\b/);
  assertCanonical(dir);
});

test('existing .env values are kept (never overwritten), only missing keys added', () => {
  const dir = tmpWorkspace(DRIFTED_OBJECT_FORM, '# mine\nDATABASE_PASSWORD=keepme\nMGA_API_KEY=k\n');
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(!issues.some((i) => i.file === '.env' && i.key === 'DATABASE_PASSWORD'));
  applyCredentialConsistencyFixes(dir, issues);
  const text = fs.readFileSync(path.join(dir, '.env'), 'utf-8');
  assert.match(text, /^# mine\n/);
  assert.match(text, /^DATABASE_PASSWORD=keepme$/m);
  assert.match(text, /^MGA_API_KEY=k$/m);
  assert.match(text, /^DATABASE_NAME=myapp$/m);
});

test('no db service (frontend-only) → no issues, no throw', () => {
  const dir = tmpWorkspace(`
services:
  frontend:
    build: ./frontend
    ports: ["8080:8080"]
`);
  assert.deepEqual(scanComposeForCredentialDrift(dir), []);
});

test('missing docker-compose.yml → [] (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credval-empty-'));
  assert.deepEqual(scanComposeForCredentialDrift(dir), []);
});

test('db service with its own env_file is out of scope; backend still gets .env', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [database]
    environment:
      DATABASE_HOST: database
  database:
    image: postgres:16
    env_file: ./database/.env
`);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(!issues.some((i) => i.service === 'database'));
  assert.ok(issues.some((i) => i.service === 'backend' && i.key === 'env_file'));
  applyCredentialConsistencyFixes(dir, issues);
  assert.doesNotMatch(read(dir).slice(read(dir).indexOf('database:')), /POSTGRES_/);
});

// ── env_file shapes on the backend ─────────────────────────────────────────

test('env_file scalar (backend/.env) → block list with .env first', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [database]
    env_file: ./backend/.env
    environment:
      DATABASE_HOST: database
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: \${DATABASE_NAME}
      POSTGRES_USER: \${DATABASE_USER}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD}
`);
  fixAll(dir);
  assert.match(read(dir), /env_file:\n\s+- \.env\n\s+- \.\/backend\/\.env\n/);
  assertCanonical(dir);
});

test('env_file inline flow list → .env prepended', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [database]
    env_file: [backend/.env]
    environment:
      DATABASE_HOST: database
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: \${DATABASE_NAME}
      POSTGRES_USER: \${DATABASE_USER}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD}
`);
  fixAll(dir);
  assert.match(read(dir), /env_file: \[\.env, backend\/\.env\]/);
  assertCanonical(dir);
});

test('env_file block list with long-form entries → .env added as an item', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [database]
    env_file:
      - path: backend/.env
        required: false
    environment:
      DATABASE_HOST: database
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: \${DATABASE_NAME}
      POSTGRES_USER: \${DATABASE_USER}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD}
`);
  fixAll(dir);
  assert.match(read(dir), /env_file:\n\s+- \.env\n\s+- path: backend\/\.env\n\s+required: false\n/);
  assertCanonical(dir);
});

// ── add-if-missing: the fatal-startup class (observed live 2026-07-16) ──

test('missing POSTGRES_PASSWORD on database service is ADDED as a reference (list form)', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
      - DATABASE_PORT=5432
  database:
    image: postgres:16
    environment:
      - POSTGRES_DB=\${DATABASE_NAME}
      - POSTGRES_USER=\${DATABASE_USER}
`);
  const issues = scanComposeForCredentialDrift(dir);
  const add = issues.find((i) => i.service === 'database' && i.key === 'POSTGRES_PASSWORD');
  assert.ok(add, 'missing POSTGRES_PASSWORD should be detected');
  assert.equal(add.add, true);
  assert.equal(add.from, null);
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  const dbBlock = out.slice(out.indexOf('database:'));
  assert.match(dbBlock, /- POSTGRES_PASSWORD=\$\{DATABASE_PASSWORD\}/);
  assertCanonical(dir);
});

test('database service with NO environment block gets one created', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
  database:
    image: postgres:16
    volumes:
      - database-data:/var/lib/postgresql/data
`);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(issues.filter((i) => i.service === 'database' && i.add).length >= 3, 'DB/USER/PASSWORD all missing');
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  assert.match(out, /database:\n    environment:\n/);
  assert.match(out, /POSTGRES_PASSWORD=\$\{DATABASE_PASSWORD\}/);
  assertCanonical(dir);
});

test('POSTGRES_HOST_AUTH_METHOD=trust suppresses the reference adds', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
  database:
    image: postgres:16
    environment:
      - POSTGRES_HOST_AUTH_METHOD=trust
`);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(!issues.some((i) => i.service === 'database'), 'trust auth needs no credentials');
});

// ── the dedicated pgvector store ─────────────────────────────────────────────

test('vectordb literal creds copied from the primary DB → ${VECTORDB_*} + backend literals rewritten', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      database:
        condition: service_healthy
    environment:
      DATABASE_HOST: database
      VECTORDB_HOST: vectordb
      VECTORDB_NAME: sop_vectors
      VECTORDB_USER: vector_user
      VECTORDB_PASSWORD: localdev123
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: \${DATABASE_NAME}
      POSTGRES_USER: \${DATABASE_USER}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD}
  vectordb:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp_user
      POSTGRES_PASSWORD: localdev123
`);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(issues.some((i) => i.service === 'vectordb' && i.key === 'POSTGRES_USER' && i.to === '${VECTORDB_USER}'));
  assert.ok(issues.some((i) => i.service === 'backend' && i.key === 'VECTORDB_NAME' && i.to === '${VECTORDB_NAME}'));
  assert.ok(issues.some((i) => i.file === '.env' && i.key === 'VECTORDB_PASSWORD'));
  assert.ok(!issues.some((i) => i.service === 'database'));
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  const vdbBlock = out.slice(out.indexOf('vectordb:'));
  assert.match(vdbBlock, /POSTGRES_USER:\s*\$\{VECTORDB_USER\}/);
  assert.match(vdbBlock, /POSTGRES_DB:\s*\$\{VECTORDB_NAME\}/);
  assert.doesNotMatch(out, /sop_vectors|vector_user|localdev123/);
  assertCanonical(dir, { vectordb: true });
});

test('pgvector vectordb service missing POSTGRES_PASSWORD gets the reference add', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
  database:
    image: postgres:16
    environment:
      - POSTGRES_DB=\${DATABASE_NAME}
      - POSTGRES_USER=\${DATABASE_USER}
      - POSTGRES_PASSWORD=\${DATABASE_PASSWORD}
  vectordb:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_DB=vectors
`);
  const issues = scanComposeForCredentialDrift(dir);
  const add = issues.find((i) => i.service === 'vectordb' && i.key === 'POSTGRES_PASSWORD' && i.add);
  assert.ok(add, 'vectordb postgres image without password must get the guard');
  assert.equal(add.to, '${VECTORDB_PASSWORD}');
  applyCredentialConsistencyFixes(dir, issues);
  assertCanonical(dir, { vectordb: true });
});

// ── build-based (Dockerfile) postgres-family detection ──────────────────────
// The live gap (2026-08-10, sop-assistant on the merged branch): the pgvector
// scaffold ships `build: ./vectordb` with a Dockerfile, not an inline image.
// The image-only guard skipped it and vectordb booted without POSTGRES_PASSWORD.

test('BUILD-based pgvector vectordb (Dockerfile FROM) gets the reference guard', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
  database:
    image: postgres:16
    environment:
      - POSTGRES_DB=\${DATABASE_NAME}
      - POSTGRES_USER=\${DATABASE_USER}
      - POSTGRES_PASSWORD=\${DATABASE_PASSWORD}
  vectordb:
    build:
      context: ./vectordb
    environment:
      - POSTGRES_DB=vectors
`);
  fs.mkdirSync(path.join(dir, 'vectordb'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vectordb', 'Dockerfile'),
    'FROM pgvector/pgvector:0.7.4-pg16\nENV PGDATA=/data/postgres\nEXPOSE 5432\n', 'utf-8');
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(issues.find((i) => i.service === 'vectordb' && i.key === 'POSTGRES_PASSWORD' && i.add), 'build-based pgvector service must get the password guard');
  applyCredentialConsistencyFixes(dir, issues);
  assert.ok(read(dir).slice(read(dir).indexOf('vectordb:')).includes('POSTGRES_PASSWORD=${VECTORDB_PASSWORD}'));
  assertCanonical(dir, { vectordb: true });
});

test('BUILD-based NON-postgres service is left alone (no false add)', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
  database:
    image: postgres:16
    environment:
      - POSTGRES_DB=\${DATABASE_NAME}
      - POSTGRES_USER=\${DATABASE_USER}
      - POSTGRES_PASSWORD=\${DATABASE_PASSWORD}
  worker:
    build:
      context: ./worker
`);
  fs.mkdirSync(path.join(dir, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker', 'Dockerfile'), 'FROM node:22-alpine\n', 'utf-8');
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(!issues.some((i) => i.service === 'worker'), 'a node service must never get a POSTGRES_PASSWORD');
  assert.ok(!issues.some((i) => i.file === '.env' && i.key.startsWith('VECTORDB_')), 'no vectordb → no VECTORDB_* in .env');
});
