/**
 * Unit tests for the compose port-offset rewrite (parallel harness runs).
 *
 * Module under test:
 *   chat/server/session/port-offset.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPortOffsetToCompose } from '../../server/session/port-offset.js';

const COMPOSE = `services:
  frontend:
    ports:
      - "8080:8080"
  backend:
    ports:
      - 3001:3000
    expose:
      - 3000
  database:
    ports:
      - "5432:5432/tcp"
`;

function tmp() {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'offset-'));
  fs.writeFileSync(path.join(wd, 'docker-compose.yml'), COMPOSE);
  return wd;
}

test('shifts every host port by offset*10, keeps container ports and forms', () => {
  const wd = tmp();
  try {
    const r = applyPortOffsetToCompose(wd, 100);
    assert.deepEqual(r, [
      { from: '8080:8080', to: '9080:8080' }, { from: '3001:3000', to: '4001:3000' }, { from: '5432:5432', to: '6432:5432' },
    ]);
    const text = fs.readFileSync(path.join(wd, 'docker-compose.yml'), 'utf-8');
    assert.match(text, /"9080:8080"/);
    assert.match(text, /- 4001:3000/);
    assert.match(text, /"6432:5432\/tcp"/);
    assert.match(text, /- 3000\n/);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test('idempotent on a second auto-start (iterate): already-shifted mappings are left alone', () => {
  const wd = tmp();
  try {
    applyPortOffsetToCompose(wd, 100);
    assert.equal(applyPortOffsetToCompose(wd, 100), null);
    assert.match(fs.readFileSync(path.join(wd, 'docker-compose.yml'), 'utf-8'), /"9080:8080"/);
    // A rewritten compose file (fresh 8080) is shifted again.
    fs.writeFileSync(path.join(wd, 'docker-compose.yml'), COMPOSE);
    const again = applyPortOffsetToCompose(wd, 100);
    assert.equal(again.length, 3);
    // A different offset ignores the old record.
    fs.writeFileSync(path.join(wd, 'docker-compose.yml'), COMPOSE);
    assert.equal(applyPortOffsetToCompose(wd, 5).length, 3);
    assert.match(fs.readFileSync(path.join(wd, 'docker-compose.yml'), 'utf-8'), /"8130:8080"/);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test('no offset / no compose file → null', () => {
  const wd = tmp();
  try {
    assert.equal(applyPortOffsetToCompose(wd, 0), null);
    fs.rmSync(path.join(wd, 'docker-compose.yml'));
    assert.equal(applyPortOffsetToCompose(wd, 100), null);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});
