/**
 * reference-data-generator.js — emits `database/init/02_reference_data.sql`
 * from the contract: placeholder starter rows for REFERENCE tables.
 *
 * A reference table is one the API acts on through `:id` routes but never
 * creates (production "lines" with `POST /lines/:id/status` and no
 * `POST /lines`). The planner asks for such tables to be seeded in prose
 * ("Seed 3-5 sample lines"), but the database scope is scaffolded
 * deterministically on fresh builds and no agent ever reads that sentence —
 * so the table stays empty, every mutation 404s, and the app is broken while
 * every gate is green (observed live: realtime-status-board).
 *
 * Detection is structural (data_model + api_contract), values are derived
 * from column types, and every block is guarded so it inserts nothing when
 * the table already has rows. Tables that need a value this generator can't
 * derive safely (NOT NULL FK to an unseeded table, unknown type) are skipped
 * whole — never half-valid rows. Identity tables are never seeded.
 *
 * The file lives in database/init/ so it runs on first boot both locally and
 * on ECS (init/ is baked into the database image). Pure function.
 */

import { topologicalSort } from './schema-generator.js';

export const REFERENCE_DATA_FILE = 'database/init/02_reference_data.sql';
export const REFERENCE_ROW_COUNT = 3;

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/;
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REFERENCES_RE = /REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;
const CHECK_IN_RE = /CHECK\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s+IN\s*\(([^)]*)\)/i;
const VARCHAR_LEN_RE = /^\s*(?:VARCHAR|CHARACTER\s+VARYING|CHAR|CHARACTER)\s*\(\s*(\d+)\s*\)/i;
const IDENTITY_TABLE_RE = /^(users?|accounts?|members?|profiles?|operators?)$/i;
const IDENTITY_COLUMN_RE = /^(oidc_sub|email|password_hash|password)$/i;
const NAME_COLUMN_RE = /^(name|title|label|display_name|full_name)$/i;
const CODE_COLUMN_RE = /^(code|slug|key)$/i;
const FILE_COLUMN_RE = /(file|mime|storage|blob|path)/i;

/**
 * Tables the API acts on but never creates.
 * @returns {Array<{ table: object, prefixes: string[] }>} in FK-safe order
 */
export function findReferenceTables(contract) {
  const tables = contract?.dataModel?.tables || contract?.data_model?.tables || [];
  const endpoints = (contract?.apiContract?.endpoints || contract?.api_contract?.endpoints || [])
    .filter((e) => e && typeof e.method === 'string' && typeof e.path === 'string')
    .map((e) => ({ ...e, method: e.method.toUpperCase() }));
  if (!Array.isArray(tables) || tables.length === 0 || endpoints.length === 0) return [];

  const ordered = topologicalSort(tables.filter((t) => t && SQL_IDENT.test(String(t.name || ''))));
  const out = [];
  for (const table of ordered) {
    if (isIdentityTable(table) || hasVectorColumn(table)) continue;
    const targeting = endpoints.filter((e) => PARAM_RE.test(e.path) && sameNoun(collectionSegment(e.path), table.name));
    if (targeting.length === 0) continue;
    if (endpoints.some((e) => isCreatorOf(e, table))) continue;
    const prefixes = [...new Set(targeting.map((e) => collectionPrefix(e.path)))];
    out.push({ table, prefixes });
  }
  return out;
}

/**
 * @returns {{ source: string, seeded: Array<{ table: string, rows: number, columns: string[] }>, skipped: Array<{ table: string, reason: string }> } | null}
 */
export function generateReferenceData(contract, { rows = REFERENCE_ROW_COUNT, now = new Date() } = {}) {
  const candidates = findReferenceTables(contract);
  if (candidates.length === 0) return null;

  const seededNames = new Set();
  const seeded = [];
  const skipped = [];
  const blocks = [];
  for (const { table } of candidates) {
    const plan = planColumns(table, seededNames, rows);
    if (plan.error) { skipped.push({ table: table.name, reason: plan.error }); continue; }
    blocks.push(emitBlock(table.name, plan.columns, rows));
    seededNames.add(table.name);
    seeded.push({ table: table.name, rows, columns: plan.columns.map((c) => c.name) });
  }
  if (seeded.length === 0) return null;

  const lines = [
    '-- AUTO-GENERATED — DO NOT EDIT — starter rows for reference tables',
    `-- Generated ${now.toISOString()}`,
    `-- Tables: ${seeded.map((s) => s.table).join(', ')}`,
    '-- These tables are acted on through :id routes but the API has no route to',
    '-- create them, so an empty table makes every such route 404. Values are',
    '-- placeholders; each block inserts nothing when the table already has rows.',
    '',
    ...blocks,
  ];
  return { source: lines.join('\n'), seeded, skipped };
}

// ── detection helpers ────────────────────────────────────────────────────

function isIdentityTable(table) {
  if (IDENTITY_TABLE_RE.test(String(table.name))) return true;
  return (table.columns || []).some((c) => IDENTITY_COLUMN_RE.test(String(c.name || '')));
}

function hasVectorColumn(table) {
  return (table.columns || []).some((c) => /^\s*VECTOR\s*\(/i.test(String(c.type || '')));
}

/** Literal segment right before the first path param ('/admin/lines/:id' → 'lines'). */
function collectionSegment(p) {
  const segs = p.split('/').filter(Boolean);
  const idx = segs.findIndex((s) => PARAM_RE.test(s));
  const head = idx === -1 ? segs : segs.slice(0, idx);
  return head[head.length - 1] || '';
}

/** Same head as endpoint-probe's collectionPrefix: path up to the first param. */
function collectionPrefix(p) {
  const idx = p.search(PARAM_RE);
  const head = idx === -1 ? p : p.slice(0, idx);
  return head.replace(/\/+$/, '');
}

function lastSegment(p) {
  const segs = p.split('/').filter(Boolean);
  return segs[segs.length - 1] || '';
}

/**
 * A POST/PUT creates rows of `table` when its final literal segment names
 * the table (`POST /lines`, `POST /projects/:id/tasks`), or — for
 * non-parameterized routes — its request fields overlap the table's
 * columns (`POST /generate` → reports.prompt) or it uploads a file into a
 * table with file-ish columns (`POST /upload` → documents.file_path).
 */
function isCreatorOf(ep, table) {
  if (ep.method !== 'POST' && ep.method !== 'PUT') return false;
  const last = lastSegment(ep.path);
  if (!PARAM_RE.test(last) && sameNoun(last, table.name)) return true;
  if (PARAM_RE.test(ep.path)) return false;
  const fields = requestFields(ep.request);
  if (fields.length === 0) return false;
  const columns = new Set((table.columns || []).map((c) => String(c.name || '').toLowerCase()).filter((n) => n && n !== 'id'));
  if (fields.some(({ name }) => columns.has(name))) return true;
  const uploads = fields.some(({ type }) => /^file/.test(type));
  return uploads && [...columns].some((n) => FILE_COLUMN_RE.test(n));
}

function requestFields(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [];
  const out = [];
  for (const [name, value] of Object.entries(spec)) {
    if (/^content[_-]?type$/i.test(name)) continue;
    const type = typeof value === 'string'
      ? value.trim().split(/\s+/)[0].toLowerCase()
      : String(value?.type || 'string').toLowerCase();
    out.push({ name: name.toLowerCase(), type });
  }
  return out;
}

function singular(word) {
  const w = String(word).toLowerCase().replace(/-/g, '_');
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ses|xes|zes|shes|ches)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function sameNoun(a, b) {
  if (!a || !b) return false;
  return singular(a) === singular(b);
}

// ── value derivation ─────────────────────────────────────────────────────

/**
 * Decide which columns get values and how. Returns `{ columns }` or
 * `{ error }` when any required column can't be derived safely.
 */
function planColumns(table, seededNames, rows) {
  const columns = [];
  for (const col of table.columns || []) {
    const name = String(col.name || '');
    const type = String(col.type || '');
    if (!SQL_IDENT.test(name)) return { error: `column ${name || '(unnamed)'} is not a plain identifier` };
    if (/\bSERIAL\b|PRIMARY\s+KEY|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i.test(type)) continue;
    if (/\bDEFAULT\b/i.test(type)) continue;
    const notNull = /NOT\s+NULL/i.test(type);
    const nameLike = NAME_COLUMN_RE.test(name) || CODE_COLUMN_RE.test(name);
    if (!notNull && !nameLike) continue;

    const fk = REFERENCES_RE.exec(type);
    if (fk) {
      if (!seededNames.has(fk[1])) return { error: `${name} references unseeded table ${fk[1]}` };
      columns.push({ name, value: () => `(SELECT MIN(id) FROM ${fk[1]})` });
      continue;
    }
    const enumValues = parseEnum(type);
    const base = baseType(type);
    const valueFn = enumValues
      ? (i) => literal(enumValues[i % enumValues.length])
      : deriveValue(table.name, name, base, type);
    if (!valueFn) return { error: `${name} ${type}: no safe placeholder for this type` };
    const lenM = VARCHAR_LEN_RE.exec(type);
    if (lenM) {
      const max = Number(lenM[1]);
      for (let i = 0; i < rows; i++) {
        const v = valueFn(i);
        if (/^'/.test(v) && v.length - 2 > max) return { error: `${name} VARCHAR(${max}) too short for a placeholder` };
      }
    }
    columns.push({ name, value: valueFn });
  }
  return { columns };
}

function parseEnum(type) {
  const m = CHECK_IN_RE.exec(type);
  if (!m) return null;
  const values = m[1].split(',').map((s) => s.trim().replace(/^'(.*)'$/, '$1')).filter(Boolean);
  return values.length ? values : null;
}

function baseType(type) {
  const m = /^\s*([A-Za-z]+(?:\s+(?:VARYING|PRECISION|WITH(?:OUT)?\s+TIME\s+ZONE))?)/i.exec(type);
  return (m ? m[1] : '').toUpperCase().replace(/\s+/g, ' ');
}

function deriveValue(tableName, colName, base, rawType) {
  if (/\[\]|\bARRAY\b/i.test(rawType)) return () => `'{}'`;
  if (/^(VARCHAR|CHARACTER VARYING|TEXT|CHAR|CHARACTER|CITEXT)$/.test(base)) {
    const label = titleCase(singular(tableName));
    if (NAME_COLUMN_RE.test(colName)) return (i) => literal(`${label} ${i + 1}`);
    if (CODE_COLUMN_RE.test(colName)) return (i) => literal(`${singular(tableName).toUpperCase()}-${i + 1}`);
    return (i) => literal(`${label} ${colName} ${i + 1}`);
  }
  if (/^(INT|INTEGER|SMALLINT|BIGINT|NUMERIC|DECIMAL|REAL|DOUBLE PRECISION|FLOAT)$/.test(base)) return (i) => String(i + 1);
  if (/^(BOOLEAN|BOOL)$/.test(base)) return () => 'TRUE';
  if (base === 'DATE') return () => 'CURRENT_DATE';
  if (/^(TIMESTAMP|TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE|TIMESTAMP WITHOUT TIME ZONE|TIME)$/.test(base)) return () => 'NOW()';
  if (base === 'UUID') return () => 'gen_random_uuid()';
  if (/^(JSON|JSONB)$/.test(base)) return () => `'{}'`;
  return null;
}

function titleCase(s) {
  return s.split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function literal(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function emitBlock(tableName, columns, rows) {
  const lines = ['DO $$', 'BEGIN', `  IF NOT EXISTS (SELECT 1 FROM ${tableName}) THEN`];
  if (columns.length === 0) {
    for (let i = 0; i < rows; i++) lines.push(`    INSERT INTO ${tableName} DEFAULT VALUES;`);
  } else {
    const tuples = [];
    for (let i = 0; i < rows; i++) tuples.push(`(${columns.map((c) => c.value(i)).join(', ')})`);
    lines.push(`    INSERT INTO ${tableName} (${columns.map((c) => c.name).join(', ')}) VALUES`);
    lines.push(`      ${tuples.join(',\n      ')};`);
  }
  lines.push('  END IF;', 'END $$;', '');
  return lines.join('\n');
}
