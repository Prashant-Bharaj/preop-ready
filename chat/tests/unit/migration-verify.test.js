/**
 * Unit tests for the post-compose migration ledger check.
 *
 * Module under test:
 *   chat/server/session/migration-verify.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeMigrationStatus,
  listMigrationFiles,
  verifyMigrationsApplied,
} from '../../server/session/migration-verify.js';

test('no migration files → none', () => {
  assert.deepEqual(computeMigrationStatus({ files: [], ledger: null }), { status: 'none', applied: [], pending: [], detail: '' });
});

test('ledger table missing → warn naming the runner call', () => {
  const r = computeMigrationStatus({ files: ['001_a.sql'], ledger: null });
  assert.equal(r.status, 'warn');
  assert.deepEqual(r.pending, ['001_a.sql']);
  assert.match(r.detail, /runner never ran/);
  assert.match(r.detail, /await runMigrations\(pool\)/);
});

test('all files recorded → done; some missing → warn listing them', () => {
  const done = computeMigrationStatus({ files: ['001_a.sql', '002_b.sql'], ledger: ['001_a.sql', '002_b.sql', '000_old.sql'] });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.applied, ['001_a.sql', '002_b.sql']);

  const warn = computeMigrationStatus({ files: ['001_a.sql', '002_b.sql'], ledger: ['001_a.sql'] });
  assert.equal(warn.status, 'warn');
  assert.deepEqual(warn.pending, ['002_b.sql']);
  assert.match(warn.detail, /002_b\.sql/);
});

test('listMigrationFiles reads backend/migrations only, sorted, .sql only; verify wires the ledger reader', () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  try {
    assert.deepEqual(listMigrationFiles(wd), []);
    fs.mkdirSync(path.join(wd, 'backend', 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(wd, 'database', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(wd, 'backend', 'migrations', '002_b.sql'), 'select 1');
    fs.writeFileSync(path.join(wd, 'backend', 'migrations', '001_a.sql'), 'select 1');
    fs.writeFileSync(path.join(wd, 'backend', 'migrations', 'README.md'), 'x');
    fs.writeFileSync(path.join(wd, 'database', 'migrations', '003_wrong_place.sql'), 'select 1');
    assert.deepEqual(listMigrationFiles(wd), ['001_a.sql', '002_b.sql']);

    let calls = 0;
    const r = verifyMigrationsApplied(wd, () => { calls++; return ['001_a.sql', '002_b.sql']; });
    assert.equal(r.status, 'done');
    assert.equal(calls, 1);

    const thrown = verifyMigrationsApplied(wd, () => { throw new Error('psql: relation "_migrations" does not exist'); });
    assert.equal(thrown.status, 'warn');
    assert.match(thrown.detail, /runner never ran/);
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
  }
});
