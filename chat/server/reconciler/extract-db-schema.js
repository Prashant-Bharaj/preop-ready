/**
 * Extract DB schema (tables + columns) from init.sql files.
 *
 * Coverage: `CREATE TABLE [IF NOT EXISTS] <name> ( <cols> );`. Per-column line
 * parsing pulls out name, type, NULL constraint, DEFAULT.
 *
 * Reads from `<workspaceDir>/database/init/*.sql` and `<workspaceDir>/database/init.sql`
 * (single-file fallback). The platform's Postgres Dockerfile only auto-runs
 * SQL inside `init/` — but the comparator should still see top-level init.sql
 * so we surface a useful diagnostic when the agent put it in the wrong place
 * (the existing init-sql-validator handles canonical-column auto-fix; the
 * comparator's job is the cross-scope view, not auto-fix).
 *
 * Skip silently per the project's "don't block builds on extractor confusion"
 * stance.
 */

import fs from 'node:fs';
import path from 'node:path';

function debug(...args) {
  if (process.env.DEBUG && /\breconciler\b/.test(process.env.DEBUG)) {
    console.error('[reconciler]', ...args);
  }
}

// Match CREATE TABLE [IF NOT EXISTS] <name> ( <body> ) — capture name + body.
// Body capture is greedy-balanced via a paren counter (regex alone can't do
// it for nested parens like CHECK (col IN ('a','b'))).
const CREATE_TABLE_HEAD_RE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][\w]*\.)?["`]?([A-Za-z_][\w]*)["`]?\s*\(/gi;

function findMatchingParen(content, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "'" || ch === '"') {
      // Skip string literals.
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '-' && content[i + 1] === '-') {
      // Skip line comment.
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Split a column body on top-level commas (don't split inside parens).
function splitColumnBody(body) {
  const parts = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += ch;
      i++;
      while (i < body.length && body[i] !== quote) {
        if (body[i] === '\\') { buf += body[i]; i++; }
        buf += body[i];
        i++;
      }
      buf += body[i];
      i++;
      continue;
    }
    if (ch === '-' && body[i + 1] === '-') {
      while (i < body.length && body[i] !== '\n') { buf += body[i]; i++; }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
    i++;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

const TABLE_LEVEL_KEYWORDS = ['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'INDEX', 'KEY', 'EXCLUDE'];

function parseColumnDecl(decl) {
  const trimmed = decl.trim();
  if (!trimmed) return null;
  // Skip table-level constraints.
  const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
  if (TABLE_LEVEL_KEYWORDS.includes(firstWord)) return null;
  // Strip a trailing comment.
  const cleaned = trimmed.replace(/--.*$/, '').trim();
  // Column declaration: `<name> <type...> [constraints]`. Name may be quoted.
  const nameMatch = cleaned.match(/^["`]?([A-Za-z_][\w]*)["`]?\s+(.+)$/s);
  if (!nameMatch) return null;
  const [, name, rest] = nameMatch;
  // Type is the first token after name; multi-word types like `TIMESTAMP WITH TIME ZONE`
  // and parameterized types like `VARCHAR(255)` need a small extension.
  const typeMatch = rest.match(/^([A-Za-z_][\w]*(?:\s*\([^)]*\))?(?:\s+(?:WITH(?:OUT)?\s+TIME\s+ZONE|UNSIGNED))?)/i);
  const type = typeMatch ? typeMatch[1].trim() : rest.split(/\s+/)[0];
  const nullable = !/\bNOT\s+NULL\b/i.test(rest);
  const defaultMatch = rest.match(/\bDEFAULT\s+(.+?)(?=\s+(?:NOT\s+NULL|NULL|REFERENCES|CHECK|UNIQUE|PRIMARY|$))/i);
  const dflt = defaultMatch ? defaultMatch[1].trim() : null;
  return {
    name,
    type,
    nullable,
    default: dflt,
  };
}

function extractTablesFromContent(file, content) {
  const out = [];
  let m;
  CREATE_TABLE_HEAD_RE.lastIndex = 0;
  while ((m = CREATE_TABLE_HEAD_RE.exec(content)) !== null) {
    const tableName = m[1];
    const openParenIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(content, openParenIdx);
    if (closeIdx < 0) {
      debug('unmatched paren in CREATE TABLE', file, tableName);
      continue;
    }
    const body = content.slice(openParenIdx + 1, closeIdx);
    const decls = splitColumnBody(body);
    const columns = [];
    for (const d of decls) {
      const col = parseColumnDecl(d);
      if (col) columns.push(col);
    }
    out.push({ file, table: tableName, columns });
  }
  return out;
}

/**
 * Walk `<workspaceDir>/database/` for SQL init files and extract schema.
 * @param {string} workspaceDir
 * @returns {Array<{file:string, table:string, columns:Array<{name:string,type:string,nullable:boolean,default:?string}>}>}
 */
export function extractDbSchema(workspaceDir) {
  const root = path.join(workspaceDir, 'database');
  if (!fs.existsSync(root)) return [];
  const candidates = [];
  // database/init/*.sql (canonical layout — auto-run by Postgres entrypoint)
  const initDir = path.join(root, 'init');
  if (fs.existsSync(initDir)) {
    try {
      for (const f of fs.readdirSync(initDir)) {
        if (f.endsWith('.sql')) candidates.push(path.join(initDir, f));
      }
    } catch (err) {
      debug('readdir init failed', err.message);
    }
  }
  // database/init.sql (single-file fallback — will NOT run in the container,
  // but the comparator should still see schema declared here so the diagnostic
  // is useful).
  const topLevel = path.join(root, 'init.sql');
  if (fs.existsSync(topLevel)) candidates.push(topLevel);

  // Sort lexicographically so multi-file init runs in declared order.
  candidates.sort();

  const tables = [];
  for (const file of candidates) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      debug('skip unreadable sql file', file, err.message);
      continue;
    }
    try {
      tables.push(...extractTablesFromContent(file, content));
    } catch (err) {
      debug('extractor threw on', file, err.message);
    }
  }
  return tables;
}
