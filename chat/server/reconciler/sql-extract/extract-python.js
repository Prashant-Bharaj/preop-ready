// extract-python.js — wraps the stdlib-`ast` Python extractor (extract_py.py)
// for Python (asyncpg/psycopg) backends. Shells out to python3; if python3 is
// absent or errors, returns [] (fail-open). Normalizes psycopg `%s` → `$1,$2…`
// so the shared Postgres PREPARE gate accepts them (asyncpg already uses `$1`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PY_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract_py.py');

// psycopg uses %s positional placeholders; convert to $1,$2,… for PREPARE.
// asyncpg SQL has no %s so this is a no-op there. `%(name)s` and `%%` are left
// untouched (only bare `%s` is rewritten) — anything we don't convert that
// PREPARE rejects just fails open.
function normalizePlaceholders(sql) {
  if (!sql.includes('%s')) return sql;
  let n = 0;
  return sql.replace(/%s/g, () => `$${++n}`);
}

export function extractPythonQueries(backendDir) {
  if (!fs.existsSync(backendDir)) return [];
  let raw;
  try {
    raw = execFileSync('python3', [PY_HELPER, backendDir], {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return []; // python3 missing / helper crash → fail-open
  }
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((q) => q && typeof q.sql === 'string')
    .map((q) => ({ sql: normalizePlaceholders(q.sql), file: q.file, line: q.line || 0, receiver: q.receiver ?? null }));
}

export { normalizePlaceholders };
