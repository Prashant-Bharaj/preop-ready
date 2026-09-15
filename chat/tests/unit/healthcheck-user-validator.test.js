/**
 * pg_isready healthcheck-user scanner — the prescribed `$${POSTGRES_USER}` /
 * `$${POSTGRES_DB}` form expands inside the container and must never count as
 * a mismatch, whatever the env block holds (literal or ${DATABASE_*} reference).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanComposeForHealthcheckUserMismatch } from '../../server/validators/db/pgdata-validator.js';

function ws(compose) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcuser-'));
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  return dir;
}
const db = (env, check) => `services:
  database:
    image: postgres:16
    environment:
${env}
    healthcheck:
      test: ["CMD-SHELL", "${check}"]
`;

test('container-side $${POSTGRES_USER}/$${POSTGRES_DB} matches a ${DATABASE_*} reference env', () => {
  const dir = ws(db('      POSTGRES_DB: ${DATABASE_NAME}\n      POSTGRES_USER: ${DATABASE_USER}\n      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}',
    'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}'));
  assert.deepEqual(scanComposeForHealthcheckUserMismatch(dir), []);
});

test('container-side form also matches a literal env', () => {
  const dir = ws(db('      POSTGRES_DB: tasks\n      POSTGRES_USER: tasks_user', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}'));
  assert.deepEqual(scanComposeForHealthcheckUserMismatch(dir), []);
});

test('a literal role that differs from the env is still flagged', () => {
  const dir = ws(db('      POSTGRES_DB: ${DATABASE_NAME}\n      POSTGRES_USER: ${DATABASE_USER}', 'pg_isready -U postgres -d tasks'));
  const issues = scanComposeForHealthcheckUserMismatch(dir);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].recommendedUser, '${DATABASE_USER}');
});
