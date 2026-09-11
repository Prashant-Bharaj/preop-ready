/**
 * db-credential-consistency-validator — unit coverage.
 *
 * Deterministic enforcement of the canonical local-dev DB connection identity
 * across the db service (POSTGRES_*) and backend service (DATABASE_*). Covers
 * the failure that shipped broken apps: the integration agent renamed the
 * database/user to the project theme and applied it inconsistently. Writes a
 * temp docker-compose.yml per case (the validator reads/writes from disk).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scanComposeForCredentialDrift,
  applyCredentialConsistencyFixes,
} from '../../server/validators/db/db-credential-consistency-validator.js';
import { LOCAL_DB_CREDENTIALS } from '../../server/config/defaults.js';

function tmpWorkspace(composeYaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credval-'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), composeYaml, 'utf-8');
  return dir;
}
const read = (dir) => fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf-8');

// The exact failure mode: db renamed to project theme, backend left on myapp.
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

test('detects + fixes db↔backend mismatch (object form) to canonical', () => {
  const dir = tmpWorkspace(DRIFTED_OBJECT_FORM);
  const issues = scanComposeForCredentialDrift(dir);
  // db service: POSTGRES_DB + POSTGRES_USER drifted (password already canonical)
  assert.ok(issues.some(i => i.service === 'database' && i.key === 'POSTGRES_DB' && i.to === LOCAL_DB_CREDENTIALS.name));
  assert.ok(issues.some(i => i.service === 'database' && i.key === 'POSTGRES_USER' && i.to === LOCAL_DB_CREDENTIALS.user));
  const applied = applyCredentialConsistencyFixes(dir, issues);
  assert.equal(applied.length, issues.length);
  const out = read(dir);
  assert.match(out, /POSTGRES_DB:\s*myapp/);
  assert.match(out, /POSTGRES_USER:\s*myapp_user/);
  assert.doesNotMatch(out, /tasktracker/);
});

// A pgvector vectordb whose container creds drift from the backend's
// VECTORDB_* target — the class that 500'd the SOP upload with `password
// authentication failed for user "vector_user"`. The vectordb is a separate
// store (excluded from the primary-DB reconciliation), but its container must
// still be initialized with what the backend connects as.
const VECTORDB_DRIFT = `
services:
  backend:
    build: ./backend
    depends_on:
      database:
        condition: service_healthy
    environment:
      DATABASE_HOST: database
      DATABASE_NAME: myapp
      DATABASE_USER: myapp_user
      DATABASE_PASSWORD: localdev123
      VECTORDB_HOST: vectordb
      VECTORDB_NAME: sop_vectors
      VECTORDB_USER: vector_user
      VECTORDB_PASSWORD: localdev123
  database:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp_user
      POSTGRES_PASSWORD: localdev123
  vectordb:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp_user
      POSTGRES_PASSWORD: localdev123
`;

test('aligns vectordb container creds to the backend VECTORDB_* target', () => {
  const dir = tmpWorkspace(VECTORDB_DRIFT);
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(issues.some(i => i.service === 'vectordb' && i.key === 'POSTGRES_USER' && i.to === 'vector_user'));
  assert.ok(issues.some(i => i.service === 'vectordb' && i.key === 'POSTGRES_DB' && i.to === 'sop_vectors'));
  // the primary DB is already canonical — no spurious rewrites there
  assert.ok(!issues.some(i => i.service === 'database'));
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  const vdbBlock = out.slice(out.indexOf('vectordb:'));
  assert.match(vdbBlock, /POSTGRES_USER:\s*vector_user/);
  assert.match(vdbBlock, /POSTGRES_DB:\s*sop_vectors/);
  // idempotent: a second pass finds nothing
  assert.deepEqual(scanComposeForCredentialDrift(dir), []);
});

test('fixes list form (- KEY=val) on the backend service', () => {
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
  const issues = scanComposeForCredentialDrift(dir);
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  assert.match(out, /- DATABASE_NAME=myapp/);
  assert.match(out, /- DATABASE_USER=myapp_user/);
  assert.match(out, /- DATABASE_PASSWORD=localdev123/);
  assert.match(out, /- POSTGRES_DB=myapp/);
  assert.match(out, /- POSTGRES_PASSWORD=localdev123/);
  assert.doesNotMatch(out, /tasktracker|hunter2/);
});

test('sets DATABASE_HOST to the actual db service name when it differs', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [db]
    environment:
      DATABASE_HOST: localhost
      DATABASE_NAME: myapp
      DATABASE_USER: myapp_user
      DATABASE_PASSWORD: localdev123
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp_user
      POSTGRES_PASSWORD: localdev123
`);
  const issues = scanComposeForCredentialDrift(dir);
  // db service discovered as `db`; backend DATABASE_HOST=localhost must become `db`
  assert.ok(issues.some(i => i.key === 'DATABASE_HOST' && i.to === 'db'));
  applyCredentialConsistencyFixes(dir, issues);
  assert.match(read(dir), /DATABASE_HOST:\s*db\b/);
});

test('already-canonical compose → zero fixes (idempotent)', () => {
  const dir = tmpWorkspace(DRIFTED_OBJECT_FORM);
  applyCredentialConsistencyFixes(dir, scanComposeForCredentialDrift(dir));
  // second pass must find nothing
  const issues2 = scanComposeForCredentialDrift(dir);
  assert.equal(issues2.length, 0);
  const applied2 = applyCredentialConsistencyFixes(dir, issues2);
  assert.equal(applied2.length, 0);
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

test('db creds in env_file (not inline) are not touched — out of scope', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    depends_on: [database]
    environment:
      DATABASE_NAME: myapp
      DATABASE_USER: myapp_user
      DATABASE_PASSWORD: localdev123
      DATABASE_HOST: database
  database:
    image: postgres:16
    env_file: ./database/.env
`);
  // db has no inline POSTGRES_*; backend already canonical → nothing to fix.
  assert.deepEqual(scanComposeForCredentialDrift(dir), []);
});

// ── add-if-missing: the fatal-startup class (observed live 2026-07-16) ──

test('missing POSTGRES_PASSWORD on database service is ADDED (list form)', () => {
  const dir = tmpWorkspace(`
services:
  backend:
    build: ./backend
    depends_on:
      - database
    environment:
      - DATABASE_HOST=database
      - DATABASE_PORT=5432
      - DATABASE_NAME=myapp
      - DATABASE_USER=myapp_user
      - DATABASE_PASSWORD=localdev123
  database:
    image: postgres:16
    environment:
      - POSTGRES_DB=myapp
      - POSTGRES_USER=myapp_user
`);
  const issues = scanComposeForCredentialDrift(dir);
  const add = issues.find(i => i.service === 'database' && i.key === 'POSTGRES_PASSWORD');
  assert.ok(add, 'missing POSTGRES_PASSWORD should be detected');
  assert.equal(add.add, true);
  assert.equal(add.from, null);
  const applied = applyCredentialConsistencyFixes(dir, issues);
  assert.ok(applied.some(a => a.key === 'POSTGRES_PASSWORD'));
  const out = read(dir);
  assert.match(out, new RegExp(`- POSTGRES_PASSWORD=${LOCAL_DB_CREDENTIALS.password}`));
  // Landed inside the database service's environment block, list style.
  const dbBlock = out.slice(out.indexOf('database:'));
  assert.ok(dbBlock.includes('POSTGRES_PASSWORD'), 'entry must be in the database block');
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
  assert.ok(issues.filter(i => i.service === 'database' && i.add).length >= 3, 'DB/USER/PASSWORD all missing');
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  assert.match(out, /database:\n    environment:\n/);
  assert.match(out, new RegExp(`POSTGRES_PASSWORD=${LOCAL_DB_CREDENTIALS.password}`));
});

test('POSTGRES_HOST_AUTH_METHOD=trust suppresses the password add', () => {
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
  assert.ok(!issues.some(i => i.key === 'POSTGRES_PASSWORD' && i.add), 'trust auth needs no password');
});

test('pgvector vectordb service missing POSTGRES_PASSWORD gets the guard add', () => {
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
      - POSTGRES_DB=myapp
      - POSTGRES_USER=myapp_user
      - POSTGRES_PASSWORD=localdev123
  vectordb:
    image: pgvector/pgvector:pg16
    environment:
      - POSTGRES_DB=vectors
`);
  const issues = scanComposeForCredentialDrift(dir);
  const add = issues.find(i => i.service === 'vectordb' && i.key === 'POSTGRES_PASSWORD' && i.add);
  assert.ok(add, 'vectordb postgres image without password must get the guard');
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  const vBlock = out.slice(out.indexOf('vectordb:'));
  assert.ok(vBlock.includes('POSTGRES_PASSWORD'), 'password added inside vectordb block');
});

// ── build-based (Dockerfile) postgres-family detection ──────────────────────
// The live gap (2026-08-10, sop-assistant on the merged branch): the pgvector
// scaffold ships `build: ./vectordb` with a Dockerfile, not an inline image.
// The image-only guard skipped it and vectordb booted without POSTGRES_PASSWORD.

test('BUILD-based pgvector vectordb (Dockerfile FROM) gets the password guard', () => {
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
      - POSTGRES_DB=myapp
      - POSTGRES_USER=myapp_user
      - POSTGRES_PASSWORD=localdev123
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
  const add = issues.find(i => i.service === 'vectordb' && i.key === 'POSTGRES_PASSWORD' && i.add);
  assert.ok(add, 'build-based pgvector service must get the password guard');
  applyCredentialConsistencyFixes(dir, issues);
  const out = read(dir);
  assert.ok(out.slice(out.indexOf('vectordb:')).includes('POSTGRES_PASSWORD'));
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
      - POSTGRES_DB=myapp
      - POSTGRES_USER=myapp_user
      - POSTGRES_PASSWORD=localdev123
  worker:
    build:
      context: ./worker
`);
  fs.mkdirSync(path.join(dir, 'worker'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker', 'Dockerfile'), 'FROM node:22-alpine\n', 'utf-8');
  const issues = scanComposeForCredentialDrift(dir);
  assert.ok(!issues.some(i => i.service === 'worker'), 'a node service must never get a POSTGRES_PASSWORD');
});
