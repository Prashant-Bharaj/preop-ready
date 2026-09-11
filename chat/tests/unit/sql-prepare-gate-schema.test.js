/**
 * The SQL prepare gate must treat backend/migrations/*.sql as part of the
 * relational schema (the backend runner applies them at startup), in name
 * order after database/init — otherwise every schema-changing iterate fails
 * as a hard "column does not exist" mismatch before the build.
 *
 * Module under test:
 *   chat/server/reconciler/sql-prepare-gate.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectInitSqlByScope } from '../../server/reconciler/sql-prepare-gate.js';

test('relational = database/init (sql+sh, sorted) then backend/migrations (sql, sorted); database/migrations ignored', () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    const w = (rel, body = 'select 1') => { fs.mkdirSync(path.dirname(path.join(wd, rel)), { recursive: true }); fs.writeFileSync(path.join(wd, rel), body); };
    w('database/init/02_reference_data.sql');
    w('database/init/01_schema.sql');
    w('database/init/10_extra.sh');
    w('backend/migrations/002_b.sql');
    w('backend/migrations/001_a.sql');
    w('backend/migrations/notes.md');
    w('database/migrations/003_wrong.sql');
    w('vectordb/init/01_init.sql');
    const sets = collectInitSqlByScope(wd);
    assert.deepEqual(sets.relational.map((p) => path.relative(wd, p)), [
      'database/init/01_schema.sql', 'database/init/02_reference_data.sql', 'database/init/10_extra.sh',
      'backend/migrations/001_a.sql', 'backend/migrations/002_b.sql',
    ]);
    assert.deepEqual(sets.vector.map((p) => path.relative(wd, p)), ['vectordb/init/01_init.sql']);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test('migrations without a database/init are not a schema on their own', () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  try {
    fs.mkdirSync(path.join(wd, 'backend', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(wd, 'backend', 'migrations', '001_a.sql'), 'select 1');
    assert.deepEqual(collectInitSqlByScope(wd), { relational: [], vector: [] });
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});
