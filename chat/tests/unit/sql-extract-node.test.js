/**
 * extract-node — AST SQL extraction unit coverage.
 *
 * The whole point of moving off regex: the TS AST distinguishes a real
 * `.query(...)` call from a comment, an unrelated string, or dynamically-built
 * SQL. These cases are exactly what the old regex got wrong (it mis-saw the
 * JOIN that started this whole effort).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQueriesFromSource } from '../../server/reconciler/sql-extract/extract-node.js';

const sqls = (src) => extractQueriesFromSource(src, 'routes.ts').map((q) => q.sql);

test('extracts a static parameterized pool.query literal', () => {
  const out = sqls(`const r = await pool.query('SELECT id, comment FROM feedback WHERE id = $1', [id]);`);
  assert.equal(out.length, 1);
  assert.match(out[0], /SELECT id, comment FROM feedback/);
});

test('the JOIN that broke the regex extracts cleanly (one query, verbatim)', () => {
  const src = `
    const rows = await pool.query(
      \`SELECT f.comment, um.content AS question FROM feedback f
        JOIN messages um ON um.role = 'user' AND um.id = f.message_id\`,
      [id],
    );
  `;
  const out = sqls(src);
  assert.equal(out.length, 1);
  assert.match(out[0], /JOIN messages um ON um\.role = 'user'/);
});

test('does NOT extract pool.query mentioned in a comment or unrelated string', () => {
  const src = `
    // we call pool.query a lot — SELECT everywhere
    const note = "our SELECT pattern uses pool.query('SELECT ...')";
    doSomething(note);
  `;
  assert.deepEqual(sqls(src), []);
});

test('skips dynamically-built SQL (template with substitutions)', () => {
  const src = 'const r = await pool.query(`SELECT * FROM tasks WHERE ${whereClause}`, params);';
  assert.deepEqual(sqls(src), []);
});

test('skips a query passed as an identifier (cannot resolve statically → fail-open)', () => {
  const src = `const q = buildQuery(); await pool.query(q, params);`;
  assert.deepEqual(sqls(src), []);
});

test('extracts from client.query and vectorPool.query too', () => {
  const src = `
    await client.query('INSERT INTO users (oidc_sub, email) VALUES ($1, $2)', [s, e]);
    await vectorPool.query('SELECT id FROM doc_chunks ORDER BY embedding <=> $1::vector LIMIT $2', [v, k]);
  `;
  assert.equal(sqls(src).length, 2);
});

test('reports file + 1-based line', () => {
  const src = `\n\nawait pool.query('SELECT 1', []);`;
  const out = extractQueriesFromSource(src, 'backend/src/routes.ts');
  assert.equal(out[0].file, 'backend/src/routes.ts');
  assert.equal(out[0].line, 3);
});

test('unparseable source → [] (fail-open, never throws)', () => {
  assert.deepEqual(sqls('function ( { [ this is not valid <<<'), []);
});
