// extract-node.js — AST-based SQL query extraction for Node/TS backends.
//
// Replaces the regex SQL scraping in compare.js. Uses the TypeScript compiler
// API (the same parser tsc/ESLint use) to find `<x>.query(...)` calls and pull
// out the literal SQL — so comments, log strings, and dynamically-built SQL are
// correctly distinguished from real query literals (the regex couldn't).
//
// Output shape (shared with the Python extractor): [{ sql, file, line }].
// Only STATIC SQL is extracted:
//   - string literal first arg            → extracted
//   - no-substitution template (`...`)    → extracted
//   - template WITH ${} substitutions     → skipped (dynamic; fail-open)
//   - identifier / other                  → skipped (can't resolve statically)
// Parameterized `$1` placeholders are preserved verbatim (PREPARE handles them).

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

// Pull the literal SQL out of a `.query(...)` first argument, or null when it's
// dynamic / non-literal (→ skip, fail-open).
function literalSql(arg) {
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return null; // TemplateExpression (has ${...}), Identifier, BinaryExpression (concat), etc.
}

// The object a `.query(...)` is called on, e.g. `pool` in `pool.query(...)` or
// `vectorPool` in `this.vectorPool.query(...)`. Used to route the query to the
// right schema (relational vs vector) — the backend talks to TWO separate
// Postgres instances via two pools, so a query must be validated against the
// schema of the pool it actually uses. null when the receiver isn't a plain
// name (e.g. `getPool().query(...)`) → treated as 'unknown' (validated against
// every available schema, fail-open).
function receiverName(propAccess) {
  const recv = propAccess.expression;
  if (ts.isIdentifier(recv)) return recv.text;
  if (ts.isPropertyAccessExpression(recv)) return recv.name.text; // this.pool / db.pool
  return null;
}

/**
 * Extract static SQL query literals from a single TS/JS source string.
 * Exposed for unit testing (no filesystem).
 * @returns {Array<{ sql, file, line, receiver }>}
 */
export function extractQueriesFromSource(text, file = 'source.ts') {
  const out = [];
  let sf;
  try {
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(file));
  } catch {
    return out; // unparseable → fail-open
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query' &&
      node.arguments.length > 0
    ) {
      const sql = literalSql(node.arguments[0]);
      if (sql != null && /\S/.test(sql)) {
        const line = sf.getLineAndCharacterOfPosition(node.arguments[0].getStart(sf)).line + 1;
        out.push({ sql, file, line, receiver: receiverName(node.expression) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(abs);
    else if (ent.isFile() && SRC_RE.test(ent.name)) yield abs;
  }
}

/**
 * Walk a backend directory and extract every static SQL query literal.
 * @returns {Array<{ sql, file, line, receiver }>}
 */
export function extractNodeQueries(backendDir) {
  const out = [];
  if (!fs.existsSync(backendDir)) return out;
  for (const file of walk(backendDir)) {
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const q of extractQueriesFromSource(text, file)) out.push(q);
  }
  return out;
}
