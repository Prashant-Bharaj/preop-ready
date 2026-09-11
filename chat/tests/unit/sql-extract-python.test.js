/**
 * extract-python — Python (asyncpg/psycopg) SQL extraction.
 *
 * `normalizePlaceholders` (%s → $n) is pure and always tested. The full
 * `extractPythonQueries` shells out to python3 + the stdlib `ast` helper, so it
 * is skipped when python3 is unavailable (mirrors the docker-gated tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractPythonQueries, normalizePlaceholders } from '../../server/reconciler/sql-extract/extract-python.js';

function pythonAvailable() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('normalizePlaceholders: psycopg %s → $1,$2…; asyncpg $1 untouched', () => {
  assert.equal(
    normalizePlaceholders('UPDATE users SET role = %s WHERE id = %s'),
    'UPDATE users SET role = $1 WHERE id = $2',
  );
  assert.equal(normalizePlaceholders('SELECT * FROM users WHERE id = $1'), 'SELECT * FROM users WHERE id = $1');
});

test('extractPythonQueries: asyncpg literals extracted, f-strings skipped', (t) => {
  if (!pythonAvailable()) { t.skip('python3 not available'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyextract-'));
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend', 'main.py'), [
    'async def h(pool, uid, name):',
    '    row = await pool.fetchrow("SELECT id, comment FROM feedback WHERE id = $1", uid)',
    '    bad = await pool.fetch(f"SELECT * FROM users WHERE name = {name}")',
    '    await cur.execute("UPDATE users SET role = %s WHERE id = %s", (r, uid))',
  ].join('\n'));
  try {
    const out = extractPythonQueries(path.join(dir, 'backend'));
    const sqls = out.map((q) => q.sql);
    assert.ok(sqls.some((s) => /SELECT id, comment FROM feedback/.test(s)), 'asyncpg fetchrow extracted');
    assert.ok(sqls.some((s) => /UPDATE users SET role = \$1 WHERE id = \$2/.test(s)), 'psycopg %s normalized');
    assert.ok(!sqls.some((s) => /WHERE name =/.test(s)), 'f-string skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractPythonQueries: missing backend dir → [] (fail-open)', () => {
  assert.deepEqual(extractPythonQueries('/nonexistent/backend/xyz'), []);
});
