/**
 * W1.TYPES.GEN — contract type generator (HARNESS_EVOLUTION.md §O).
 *
 * Reads `<workspace>/.harness/contracts.json` and emits compile-time-
 * enforced type definitions into the workspace's `generated/` directories:
 *
 *   Node backend:    backend/src/generated/contracts.ts
 *   Python backend:  backend/generated/models.py
 *   Frontend:        frontend/src/generated/contracts.ts
 *
 * Triggered after `write_harness_state` lands. Goal: any cross-scope
 * contract change (column added, endpoint renamed) re-emits the shared
 * types so the next `tsc --noEmit` / `mypy --strict` pass catches all
 * usage sites by file + line, replacing the pre-O regex-grep heuristic
 * for "where did this contract field appear".
 *
 * Defensive posture (the brief's load-bearing constraint):
 *  1. Schema-validate contracts before emitting (so partial/garbage
 *     contracts produce a precise error pointing at the offending
 *     JSON-path, not a TypeError six levels deep).
 *  2. Self-test TS via `tsc --noEmit` on a temp file BEFORE the atomic
 *     write to the workspace. A bad emission never reaches user-app
 *     source. When `tsc` isn't reachable on PATH we degrade to a soft-
 *     skip with a warning (telemetry-class — per L.5).
 *  3. Atomic writes (write-temp + rename). Concurrent readers (a
 *     subagent's `tsc` pass) never see a truncated file.
 *  4. All filesystem failures route through `logAndSwallow`. A failed
 *     generation MUST NOT crash a build — this is project memory
 *     plumbing, not a critical-path step.
 *
 * Surface:
 *   generateContractTypes(workspaceDir, opts) → { written, skipped, errors }
 *   emitTsContracts(contracts, { scope })   → string (TS source)
 *   emitPydanticModels(contracts)           → string (Python source)
 *   validateContractsSchema(envelope)       → throws on first failure
 *   selfTestTs(source, label)               → throws on tsc failure
 *
 * Type mappings (data_model column type → TS / Pydantic):
 *
 *   SERIAL PRIMARY KEY / INTEGER     → number          / int
 *   VARCHAR(N) / TEXT                → string          / str
 *   BOOLEAN                          → boolean         / bool
 *   TIMESTAMPTZ / TIMESTAMP          → string (ISO)    / datetime
 *   DATE                             → string          / date
 *   JSONB / JSON                     → Record<...>     / dict[str, Any]
 *   VECTOR(N)                        → number[]        / list[float]
 *   INTEGER REFERENCES X(id)         → number + @see   / int + Field desc
 *   Unknown                          → unknown         / Any (with warn)
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import { logAndSwallow } from '../util/log-helpers.js';
import { readContracts, getHarnessDir } from '../session/harness-state.js';
import { TSC_SELF_TEST_MS } from '../config/defaults.js';
import { validate as validateSchema } from './contracts-schema.js';

// ── Header markers ────────────────────────────────────────────────────────
// Single string so a future audit (or W1.PATH's deny rule) can detect any
// hand-edited generated file by absence of this exact comment.
const TS_HEADER_TAG = 'AUTO-GENERATED — DO NOT EDIT — regenerated from .harness/contracts.json';
const PY_HEADER_TAG = TS_HEADER_TAG; // identical sentinel — Python prefixes with `#`.

/**
 * Read either snake_case or camelCase variant of a contract field.
 * Mirrors `getField` in contracts-schema.js — the on-disk envelope today
 * uses camelCase (orchestration-stash convention); the plan narrative uses
 * snake_case. Be tolerant of both so this generator survives a future
 * schema cleanup without code churn.
 */
function getField(obj, snake, camel) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (snake in obj) return obj[snake];
  if (camel && camel in obj) return obj[camel];
  return undefined;
}

// ── Type mappers ──────────────────────────────────────────────────────────
//
// PostgreSQL column-type strings come in with mixed case, optional widths,
// optional NOT NULL / DEFAULT / REFERENCES clauses. Strip down to the base
// type token and dispatch.

/**
 * Extract the base type token from a raw SQL type string. Returns the upper-
 * cased base type with any width / precision stripped, plus a `refTable`
 * hint when the column is a foreign-key reference.
 *
 * Examples:
 *   'SERIAL PRIMARY KEY'                → { base: 'SERIAL',     refTable: null }
 *   'VARCHAR(255) NOT NULL'             → { base: 'VARCHAR',    refTable: null }
 *   'INTEGER REFERENCES users(id)'      → { base: 'INTEGER',    refTable: 'users' }
 *   'TIMESTAMPTZ DEFAULT NOW()'         → { base: 'TIMESTAMPTZ', refTable: null }
 *   'VECTOR(1536)'                      → { base: 'VECTOR',     refTable: null }
 */
function parseSqlType(raw) {
  const s = String(raw || '').trim();
  const upper = s.toUpperCase();
  const baseMatch = upper.match(/^[A-Z]+/);
  const base = baseMatch ? baseMatch[0] : 'UNKNOWN';
  const refMatch = upper.match(/REFERENCES\s+([A-Z_][A-Z0-9_]*)/i);
  const refTable = refMatch ? refMatch[1].toLowerCase() : null;
  return { base, refTable, original: s };
}

function sqlToTs(raw, warnings) {
  const { base, refTable, original } = parseSqlType(raw);
  switch (base) {
    case 'SERIAL':
    case 'BIGSERIAL':
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
    case 'NUMERIC':
    case 'DECIMAL':
    case 'REAL':
    case 'DOUBLE':
    case 'FLOAT':
      return { ts: 'number', jsdoc: refTable ? ` @see ${refTable}` : '' };
    case 'VARCHAR':
    case 'CHAR':
    case 'TEXT':
    case 'UUID':
      return { ts: 'string', jsdoc: '' };
    case 'BOOLEAN':
    case 'BOOL':
      return { ts: 'boolean', jsdoc: '' };
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP':
      return { ts: 'string', jsdoc: ' ISO-8601 timestamp' };
    case 'DATE':
      return { ts: 'string', jsdoc: ' ISO-8601 date (YYYY-MM-DD)' };
    case 'TIME':
      return { ts: 'string', jsdoc: ' ISO-8601 time' };
    case 'JSONB':
    case 'JSON':
      return { ts: 'Record<string, unknown>', jsdoc: '' };
    case 'VECTOR':
      return { ts: 'number[]', jsdoc: '' };
    case 'BYTEA':
      return { ts: 'string', jsdoc: ' base64-encoded bytes' };
    default:
      warnings.push(`Unknown SQL type '${original}' — falling back to 'unknown'`);
      return { ts: 'unknown', jsdoc: '' };
  }
}

function sqlToPy(raw, warnings) {
  const { base, refTable, original } = parseSqlType(raw);
  switch (base) {
    case 'SERIAL':
    case 'BIGSERIAL':
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
      return { py: 'int', field: refTable ? `references ${refTable}.id` : null };
    case 'NUMERIC':
    case 'DECIMAL':
    case 'REAL':
    case 'DOUBLE':
    case 'FLOAT':
      return { py: 'float', field: null };
    case 'VARCHAR':
    case 'CHAR':
    case 'TEXT':
    case 'UUID':
      return { py: 'str', field: null };
    case 'BOOLEAN':
    case 'BOOL':
      return { py: 'bool', field: null };
    case 'TIMESTAMPTZ':
    case 'TIMESTAMP':
      return { py: 'datetime', field: null, pyImports: { datetime: new Set(['datetime']) } };
    case 'DATE':
      return { py: 'date', field: null, pyImports: { datetime: new Set(['date']) } };
    case 'TIME':
      return { py: 'time', field: null, pyImports: { datetime: new Set(['time']) } };
    case 'JSONB':
    case 'JSON':
      return { py: 'dict[str, Any]', field: null, pyImports: { typing: new Set(['Any']) } };
    case 'VECTOR':
      return { py: 'list[float]', field: null };
    case 'BYTEA':
      return { py: 'bytes', field: null };
    default:
      warnings.push(`Unknown SQL type '${original}' — falling back to 'Any'`);
      return { py: 'Any', field: null, pyImports: { typing: new Set(['Any']) } };
  }
}

// ── Identifier helpers ────────────────────────────────────────────────────
//
// Convert snake_case table / endpoint names into PascalCase + sanitized
// JS/TS-safe identifiers. Path-based identifier construction strips slashes
// and parameter brackets so `/users/:id/tasks` becomes `UsersIdTasks`.

function toPascal(s) {
  const raw = String(s || '');
  // If the input is already CamelCase / PascalCase (no separators, mixed
  // case), preserve internal capitals — `TaskList` should stay `TaskList`,
  // not become `Tasklist`. Only normalize when separators are present.
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return raw
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .split(/[_-]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'Anonymous';
}

function singularize(name) {
  // Crude but adequate: drop trailing 's' (users → user, tasks → task).
  // Doesn't try to be clever about irregulars — type names like `Userss`
  // are loud and easy to spot if a contract author names a table 'us'.
  const n = String(name || '');
  if (n.length > 3 && /s$/i.test(n) && !/ss$/i.test(n)) return n.slice(0, -1);
  return n;
}

function endpointIdent(method, urlPath) {
  const cleaned = String(urlPath || '')
    .replace(/^\//, '')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '$1')
    .replace(/\{[^}]+\}/g, '')
    .replace(/\//g, '_')
    .replace(/[^A-Za-z0-9_]+/g, '_');
  return `${toPascal(method)}${toPascal(cleaned)}`;
}

// ── TS emission ───────────────────────────────────────────────────────────

/**
 * Emit TS contracts source. `scope` toggles whether the file gets the
 * frontend-only `ui_contract` section ('frontend') or the backend slice
 * ('backend'). Same data_model + api_contract on both — the duplication
 * is intentional: each scope has its own tsconfig and we don't want a
 * cross-scope import dependency at compile time.
 *
 * @param {{ version: number, data: object }} envelope - validated envelope
 * @param {{ scope: 'backend'|'frontend' }} opts
 * @returns {{ source: string, warnings: string[] }}
 */
export function emitTsContracts(envelope, { scope = 'backend' } = {}) {
  const warnings = [];
  const data = envelope?.data || {};
  const lines = [];

  lines.push(`// ${TS_HEADER_TAG}`);
  lines.push(`// Source contracts version: ${envelope?.version || '?'}, generated ${new Date().toISOString()}`);
  lines.push(`// Scope: ${scope}`);
  lines.push('');

  // data_model → table interfaces
  const dataModel = getField(data, 'data_model', 'dataModel');
  const tables = (dataModel && Array.isArray(dataModel.tables)) ? dataModel.tables : [];
  if (tables.length > 0) {
    lines.push('// ── data_model ────────────────────────────────────────────────────────');
    lines.push('');
    for (const table of tables) {
      const ifaceName = toPascal(singularize(table.name));
      lines.push(`/** Row type for table \`${table.name}\` */`);
      lines.push(`export interface ${ifaceName} {`);
      for (const col of (table.columns || [])) {
        // Defensive: skip pseudo-columns that aren't real column names. The
        // contract agent sometimes emits SQL constraint entries (e.g.
        // `{ name: "PRIMARY KEY", type: "(document_id, tag_id)" }`) as if
        // they were columns. The schema-generator handles them correctly as
        // table constraints in DDL, but the TS interface would get an invalid
        // identifier (`PRIMARY KEY: unknown;`) which won't compile.
        // Rule: column name must be a valid JS identifier.
        if (!col || typeof col.name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(col.name)) {
          warnings.push(`data_model.tables[${table.name}]: skipping non-identifier column name "${col?.name}"`);
          continue;
        }
        const { ts, jsdoc } = sqlToTs(col.type, warnings);
        if (jsdoc) lines.push(`  /**${jsdoc} */`);
        lines.push(`  ${col.name}: ${ts};`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  // api_contract → request/response interfaces
  const apiContract = getField(data, 'api_contract', 'apiContract');
  const endpoints = (apiContract && Array.isArray(apiContract.endpoints)) ? apiContract.endpoints : [];
  if (endpoints.length > 0) {
    lines.push('// ── api_contract ──────────────────────────────────────────────────────');
    lines.push('');
    for (const ep of endpoints) {
      const ident = endpointIdent(ep.method, ep.path);
      lines.push(`// ${String(ep.method).toUpperCase()} ${ep.path}`);
      if (ep.request) {
        lines.push(`export interface ${ident}Request {`);
        emitTsBody(ep.request, lines, warnings);
        lines.push('}');
      }
      if (ep.response) {
        const body = ep.response.body !== undefined ? ep.response.body : ep.response;
        lines.push(`export interface ${ident}Response {`);
        emitTsBody(body, lines, warnings);
        // The pre-staged dev-role-switcher makes /whoami echo devMode +
        // availableRoles locally; without these OPTIONAL fields here the
        // backend's contract-conformant handler fails TS2353 on its own
        // scaffold (measured: the single biggest type-gate error class,
        // ~210 hits). Optional-only — widens the type, restricts nothing.
        if (String(ep.method).toUpperCase() === 'GET' && /whoami|^\/me$/i.test(String(ep.path))) {
          lines.push('  /** dev-role-switcher (local dev only) — absent in production */');
          lines.push('  devMode?: boolean;');
          lines.push('  availableRoles?: string[];');
        }
        lines.push('}');
      }
      lines.push('');
    }
  }

  // ui_contract → component-prop interfaces (frontend only)
  if (scope === 'frontend') {
    const uiContract = getField(data, 'ui_contract', 'uiContract');
    const components = (uiContract && Array.isArray(uiContract.components)) ? uiContract.components : [];
    if (components.length > 0) {
      lines.push('// ── ui_contract ───────────────────────────────────────────────────────');
      lines.push('');
      for (const comp of components) {
        const compName = toPascal(comp.name);
        lines.push(`/** Props for component \`${comp.name}\`${comp.role ? ` — ${comp.role}` : ''} */`);
        lines.push(`export interface ${compName}Props {`);
        if (isPlainObject(comp.props)) {
          emitTsBody(comp.props, lines, warnings);
        } else {
          lines.push('  // (no props declared in ui_contract — extend as needed)');
        }
        lines.push('}');
        lines.push('');
      }
    }
  }

  // Ensure file ends with at least one type so a totally-empty contract
  // still produces a parseable .ts module (otherwise tsc complains about
  // an empty file in some configurations).
  if (lines.length === 4) { // only the 4 header lines were pushed
    lines.push('export type ContractsModule = Record<string, never>;');
    lines.push('');
  }

  return { source: lines.join('\n'), warnings };
}

/**
 * Emit TS field declarations from a free-form contract body object.
 * Recognized shapes:
 *   { fieldName: 'string' | 'number' | 'boolean' | 'array' | 'object' }
 *   { fieldName: { type: 'string', optional?: boolean } }
 *   "{ field1, field2, field3 }"  ← free-form string (parsed into fields)
 *   "{ items: [{ id, name }], total }"  ← nested string (parsed best-effort)
 * Unknown shapes → 'unknown' with a warning.
 *
 * NB: Why we DON'T fall back to `[key: string]: unknown` for unparseable
 * bodies: TS strict mode rejects assigning a named interface (e.g. `Task`)
 * to a type with an index signature unless the source interface also
 * declares an index signature. Concrete types like `Task` don't, so an
 * index-signature response type breaks the typecheck on `res.json(task)`.
 * Instead we emit an empty interface — which accepts any object — as the
 * permissive fallback. The LLM still gets a named type to import; the
 * downside is no field-name autocompletion, which is acceptable for
 * contract responses the router couldn't parse into structured fields.
 */
function emitTsBody(body, lines, warnings) {
  // String form — router emitted a free-form body string like
  // "{ id, title, completed, created_at }". Parse out field names.
  if (typeof body === 'string') {
    const fields = parseBodyStringToFields(body);
    if (fields.length > 0) {
      for (const f of fields) {
        lines.push(`  ${f}?: unknown;`);
      }
      return;
    }
    warnings.push(`api body string could not be parsed into fields: ${body.slice(0, 120)}`);
    // Empty interface — permissive: accepts any object including named types.
    return;
  }
  if (!isPlainObject(body)) {
    if (body !== undefined && body !== null) {
      warnings.push(`api body expected object or string, got ${typeof body}`);
    }
    // Empty interface — permissive (see NB above).
    return;
  }
  const keys = Object.keys(body);
  if (keys.length === 0) {
    // Empty interface — permissive (see NB above).
    return;
  }
  for (const key of keys) {
    const val = body[key];
    const { tsType, optional } = jsonShapeToTs(val, warnings);
    lines.push(`  ${key}${optional ? '?' : ''}: ${tsType};`);
  }
}

/**
 * Parse a free-form body string into a list of top-level field names.
 *
 * Handles common router outputs like:
 *   "{ id, title, completed, created_at }"           → [id, title, completed, created_at]
 *   "{ items: [...], total }"                        → [items, total]
 *   "{ items: [{ id, name }], total, summary: {...} }" → [items, total, summary]
 *   "{ id, role:'assistant', content, citations: [...] }" → [id, role, content, citations]
 *
 * Walks character-by-character to identify top-level field names while
 * skipping over nested brackets/parens/quotes. Returns deduplicated field
 * names in declaration order. Returns [] when the body doesn't look like
 * a `{ ... }` envelope or when parsing fails.
 */
function parseBodyStringToFields(s) {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];

  const fields = [];
  const seen = new Set();
  let depth = 0; // nesting depth across {}, [], ()
  let inSingle = false;
  let inDouble = false;
  let tokenStart = 0;
  const TOP_LEVEL_SEP = (i) => depth === 0 && !inSingle && !inDouble && inner[i] === ',';

  const flushToken = (endExclusive) => {
    const raw = inner.slice(tokenStart, endExclusive).trim();
    if (!raw) return;
    // Field name is everything up to the first ':' (key:value) or whitespace.
    let nameEnd = raw.length;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === ':' || /\s/.test(c)) { nameEnd = i; break; }
    }
    const name = raw.slice(0, nameEnd).trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !seen.has(name)) {
      fields.push(name);
      seen.add(name);
    }
  };

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inSingle) { if (c === "'" && inner[i - 1] !== '\\') inSingle = false; continue; }
    if (inDouble) { if (c === '"' && inner[i - 1] !== '\\') inDouble = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; continue; }
    if (TOP_LEVEL_SEP(i)) {
      flushToken(i);
      tokenStart = i + 1;
    }
  }
  flushToken(inner.length);
  return fields;
}

function jsonShapeToTs(val, warnings) {
  // String form: 'string' / 'number' / 'boolean' / 'array' / 'object' / 'integer'
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    if (v === 'string') return { tsType: 'string', optional: false };
    if (v === 'number' || v === 'integer' || v === 'float') return { tsType: 'number', optional: false };
    if (v === 'boolean' || v === 'bool') return { tsType: 'boolean', optional: false };
    if (v === 'array') return { tsType: 'unknown[]', optional: false };
    if (v === 'object') return { tsType: 'Record<string, unknown>', optional: false };
    if (v === 'null') return { tsType: 'null', optional: false };
    if (v === 'any') return { tsType: 'unknown', optional: false };
    warnings.push(`unknown api type string '${val}' — falling back to 'unknown'`);
    return { tsType: 'unknown', optional: false };
  }
  // Object form: { type: '...', optional?: true }
  if (isPlainObject(val) && typeof val.type === 'string') {
    const inner = jsonShapeToTs(val.type, warnings);
    return { tsType: inner.tsType, optional: Boolean(val.optional) };
  }
  // Array form: [shape] → shape[]
  if (Array.isArray(val) && val.length > 0) {
    const inner = jsonShapeToTs(val[0], warnings);
    return { tsType: `${inner.tsType}[]`, optional: false };
  }
  // Nested object: emit inline.
  if (isPlainObject(val)) {
    // Cheap inline: collapse to Record<string, unknown> to avoid deep
    // nested interface emission complexity in v1. Future work can lift this.
    return { tsType: 'Record<string, unknown>', optional: false };
  }
  warnings.push(`unhandled api shape ${JSON.stringify(val)} — falling back to 'unknown'`);
  return { tsType: 'unknown', optional: false };
}

// ── Pydantic emission ─────────────────────────────────────────────────────

/**
 * Emit Pydantic models from contracts. Returns the full Python source
 * string with imports and class definitions.
 *
 * @param {{ version: number, data: object }} envelope
 * @returns {{ source: string, warnings: string[] }}
 */
export function emitPydanticModels(envelope) {
  const warnings = [];
  const data = envelope?.data || {};

  const lines = [];
  lines.push(`# ${PY_HEADER_TAG}`);
  lines.push(`# Source contracts version: ${envelope?.version || '?'}, generated ${new Date().toISOString()}`);
  lines.push('');

  // Collect imports as we emit so we only `from datetime import ...` what's used.
  const imports = {
    typing: new Set(),
    datetime: new Set(),
    pydantic: new Set(['BaseModel']),
  };

  const body = [];

  // data_model → row classes
  const dataModel = getField(data, 'data_model', 'dataModel');
  const tables = (dataModel && Array.isArray(dataModel.tables)) ? dataModel.tables : [];
  if (tables.length > 0) {
    body.push('# ── data_model ────────────────────────────────────────────────────────');
    body.push('');
    for (const table of tables) {
      const className = toPascal(singularize(table.name));
      body.push(`class ${className}(BaseModel):`);
      body.push(`    """Row type for table \`${table.name}\`."""`);
      const columns = table.columns || [];
      if (columns.length === 0) {
        body.push('    pass');
      } else {
        for (const col of columns) {
          const { py, field, pyImports } = sqlToPy(col.type, warnings);
          mergeImports(imports, pyImports);
          if (field) {
            imports.pydantic.add('Field');
            body.push(`    ${col.name}: ${py} = Field(description=${JSON.stringify(field)})`);
          } else {
            body.push(`    ${col.name}: ${py}`);
          }
        }
      }
      body.push('');
    }
  }

  // api_contract → request/response classes
  const apiContract = getField(data, 'api_contract', 'apiContract');
  const endpoints = (apiContract && Array.isArray(apiContract.endpoints)) ? apiContract.endpoints : [];
  if (endpoints.length > 0) {
    body.push('# ── api_contract ──────────────────────────────────────────────────────');
    body.push('');
    for (const ep of endpoints) {
      const ident = endpointIdent(ep.method, ep.path);
      body.push(`# ${String(ep.method).toUpperCase()} ${ep.path}`);
      if (ep.request) {
        body.push(`class ${ident}Request(BaseModel):`);
        emitPyBody(ep.request, body, warnings, imports);
        body.push('');
      }
      if (ep.response) {
        const respBody = ep.response.body !== undefined ? ep.response.body : ep.response;
        body.push(`class ${ident}Response(BaseModel):`);
        emitPyBody(respBody, body, warnings, imports);
        // Mirror of the TS whoami extension — see emitTsContracts.
        if (String(ep.method).toUpperCase() === 'GET' && /whoami|^\/me$/i.test(String(ep.path))) {
          imports.typing.add('Optional');
          imports.typing.add('List');
          body.push('    # dev-role-switcher (local dev only) — absent in production');
          body.push('    devMode: Optional[bool] = None');
          body.push('    availableRoles: Optional[List[str]] = None');
        }
        body.push('');
      }
    }
  }

  // Emit imports header
  if (imports.typing.size > 0) {
    lines.push(`from typing import ${Array.from(imports.typing).sort().join(', ')}`);
  }
  if (imports.datetime.size > 0) {
    lines.push(`from datetime import ${Array.from(imports.datetime).sort().join(', ')}`);
  }
  lines.push(`from pydantic import ${Array.from(imports.pydantic).sort().join(', ')}`);
  lines.push('');
  lines.push('');

  // Stitch
  const out = [...lines, ...body];
  // Ensure parseable even for empty contracts.
  if (body.length === 0) {
    out.push('# (no contract entities emitted)');
    out.push('class _ContractsModule(BaseModel):');
    out.push('    """Placeholder so the module is importable when no contracts have been defined."""');
    out.push('    pass');
    out.push('');
  }

  return { source: out.join('\n'), warnings };
}

function emitPyBody(body, lines, warnings, imports) {
  if (!isPlainObject(body) || Object.keys(body).length === 0) {
    lines.push('    pass');
    return;
  }
  for (const [key, val] of Object.entries(body)) {
    const { pyType, optional } = jsonShapeToPy(val, warnings, imports);
    if (optional) {
      imports.typing.add('Optional');
      lines.push(`    ${key}: Optional[${pyType}] = None`);
    } else {
      lines.push(`    ${key}: ${pyType}`);
    }
  }
}

function jsonShapeToPy(val, warnings, imports) {
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    if (v === 'string') return { pyType: 'str', optional: false };
    if (v === 'integer') return { pyType: 'int', optional: false };
    if (v === 'number' || v === 'float') return { pyType: 'float', optional: false };
    if (v === 'boolean' || v === 'bool') return { pyType: 'bool', optional: false };
    if (v === 'array') {
      imports.typing.add('Any');
      return { pyType: 'list[Any]', optional: false };
    }
    if (v === 'object') {
      imports.typing.add('Any');
      return { pyType: 'dict[str, Any]', optional: false };
    }
    if (v === 'null') return { pyType: 'None', optional: false };
    if (v === 'any') {
      imports.typing.add('Any');
      return { pyType: 'Any', optional: false };
    }
    warnings.push(`unknown api type string '${val}' — falling back to 'Any'`);
    imports.typing.add('Any');
    return { pyType: 'Any', optional: false };
  }
  if (isPlainObject(val) && typeof val.type === 'string') {
    const inner = jsonShapeToPy(val.type, warnings, imports);
    return { pyType: inner.pyType, optional: Boolean(val.optional) };
  }
  if (Array.isArray(val) && val.length > 0) {
    const inner = jsonShapeToPy(val[0], warnings, imports);
    return { pyType: `list[${inner.pyType}]`, optional: false };
  }
  if (isPlainObject(val)) {
    imports.typing.add('Any');
    return { pyType: 'dict[str, Any]', optional: false };
  }
  warnings.push(`unhandled api shape ${JSON.stringify(val)} — falling back to 'Any'`);
  imports.typing.add('Any');
  return { pyType: 'Any', optional: false };
}

function mergeImports(target, src) {
  if (!src) return;
  for (const key of Object.keys(src)) {
    if (!target[key]) target[key] = new Set();
    for (const v of src[key]) target[key].add(v);
  }
}

// ── Validation entrypoint ─────────────────────────────────────────────────

/**
 * Validate a contracts envelope. Throws on the FIRST error with a precise
 * JSON-path so the orchestrator can attach the field reference to its
 * recovery dispatch. Use `validate` from contracts-schema.js directly if
 * you want the full error list.
 */
export function validateContractsSchema(envelope) {
  const { ok, errors } = validateSchema(envelope);
  if (ok) return;
  const first = errors[0];
  const err = new Error(
    `contracts.json invalid at ${first.path || '(root)'} — ${first.message}` +
    (errors.length > 1 ? ` (+${errors.length - 1} more)` : '')
  );
  err.path = first.path;
  err.allErrors = errors;
  throw err;
}

// ── tsc self-test ─────────────────────────────────────────────────────────

/**
 * Locate a `tsc` binary the harness can run. Order:
 *   1. WORKSPACE/frontend/node_modules/.bin/tsc
 *   2. WORKSPACE/backend/node_modules/.bin/tsc
 *   3. plain `tsc` on PATH (via PATH lookup)
 *   4. `npx -y typescript` (last-resort, network)
 * Returns null when nothing is reachable; caller treats that as "skip
 * self-test with a warning" (telemetry-class per L.5).
 */
function resolveTscCommand(workspaceDir) {
  const candidates = [
    path.join(workspaceDir, 'frontend', 'node_modules', '.bin', 'tsc'),
    path.join(workspaceDir, 'backend', 'node_modules', '.bin', 'tsc'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { cmd: c, args: [] };
  }
  // PATH lookup — execFileSync respects PATH when given a bare name. We
  // confirm `tsc` is reachable by spawning with `--version` (tight timeout)
  // before committing to it; otherwise the real self-test would explode
  // with a confusing ENOENT.
  try {
    execFileSync('tsc', ['--version'], { stdio: 'ignore', timeout: 3_000 });
    return { cmd: 'tsc', args: [] };
  } catch {
    // not on PATH
  }
  // Last resort: `npx -y typescript`. Will hit network on first run, but
  // gracefully falls back to the npm cache on subsequent runs.
  try {
    execFileSync('npx', ['-y', '-p', 'typescript', '--', 'tsc', '--version'], {
      stdio: 'ignore', timeout: 8_000,
    });
    return { cmd: 'npx', args: ['-y', '-p', 'typescript', '--', 'tsc'] };
  } catch {
    return null;
  }
}

/**
 * Self-test generated TS source via `tsc --noEmit`. Writes the source to
 * a temp file and invokes tsc against it with strict flags matching the
 * subagent target. Throws on failure with the tsc output captured.
 *
 * Soft-skip when no tsc reachable: returns `{ skipped: true, reason: '...' }`
 * so the caller can log a warning and continue (per L.5). Hard failure
 * (tsc reports diagnostics) throws.
 *
 * @param {string} source - TS source to compile
 * @param {string} label - human-readable tag for error messages
 * @param {string} workspaceDir - used to locate a local tsc
 * @returns {{ skipped?: boolean, reason?: string }}
 */
export function selfTestTs(source, label, workspaceDir) {
  const tsc = resolveTscCommand(workspaceDir);
  if (!tsc) {
    return { skipped: true, reason: 'no tsc binary reachable (checked workspace node_modules and PATH)' };
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'contract-types-selftest-'));
  const tmpFile = path.join(tmpDir, 'contracts.ts');
  writeFileSync(tmpFile, source, 'utf-8');
  try {
    execFileSync(
      tsc.cmd,
      [
        ...tsc.args,
        '--noEmit',
        '--target', 'es2022',
        '--module', 'esnext',
        '--moduleResolution', 'bundler',
        '--strict',
        '--lib', 'es2022',
        tmpFile,
      ],
      { stdio: 'pipe', timeout: TSC_SELF_TEST_MS, encoding: 'utf-8' }
    );
    return { skipped: false };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : '';
    const stderr = err.stderr ? String(err.stderr) : '';
    const tscOut = (stdout + stderr).trim() || err.message;
    const failure = new Error(`tsc --noEmit self-test failed for ${label}:\n${tscOut}`);
    failure.tscOutput = tscOut;
    throw failure;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── Atomic write helper ───────────────────────────────────────────────────

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, targetPath);
}

// ── Telemetry log ─────────────────────────────────────────────────────────

function appendTelemetry(workspaceDir, record) {
  try {
    const dir = getHarnessDir(workspaceDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'contract-types-generator.log');
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    logAndSwallow(err, '[contract-types-generator] telemetry append failed');
  }
}

// ── Public entrypoint ─────────────────────────────────────────────────────

/**
 * Generate contract types for the given workspace.
 *
 * Discovers which scopes are present from `contracts.file_structure` and
 * emits into the matching `generated/` subdir for each.
 *
 * @param {string} workspaceDir
 * @param {{ skipSelfTest?: boolean, sessionId?: string }} [opts]
 *   - skipSelfTest: bypass the `tsc --noEmit` self-test (CLI / debugging only).
 *   - sessionId: stamped into the file header for audit.
 * @returns {{ written: string[], skipped: string[], errors: string[] }}
 */
export function generateContractTypes(workspaceDir, opts = {}) {
  const result = { written: [], skipped: [], errors: [] };
  const startedAt = Date.now();

  let envelope;
  try {
    envelope = readContracts(workspaceDir);
  } catch (err) {
    const msg = `readContracts failed: ${err.message}`;
    result.errors.push(msg);
    appendTelemetry(workspaceDir, { ts: new Date().toISOString(), event: 'error', message: msg });
    return result;
  }

  if (!envelope) {
    const msg = '.harness/contracts.json not found — nothing to generate';
    result.skipped.push(msg);
    appendTelemetry(workspaceDir, { ts: new Date().toISOString(), event: 'skip', message: msg });
    return result;
  }

  try {
    validateContractsSchema(envelope);
  } catch (err) {
    const msg = `schema validation failed: ${err.message}`;
    result.errors.push(msg);
    appendTelemetry(workspaceDir, {
      ts: new Date().toISOString(),
      event: 'validate_error',
      path: err.path || '',
      message: err.message,
      allErrors: err.allErrors || [],
    });
    return result;
  }

  // Discover scopes from file_structure.
  const fileStructure = getField(envelope.data, 'file_structure', 'fileStructure') || {};
  const hasBackend = Boolean(fileStructure.backend);
  const hasFrontend = Boolean(fileStructure.frontend);
  const backendLanguage = (fileStructure.backend && fileStructure.backend.language) || 'node';

  // ── Backend (Node OR Python) ─────────────────────────────────────────
  if (hasBackend) {
    if (backendLanguage === 'python') {
      const target = path.join(workspaceDir, 'backend', 'generated', 'models.py');
      try {
        const { source, warnings } = emitPydanticModels(envelope);
        for (const w of warnings) result.errors.push(`[backend/python] ${w}`);
        atomicWrite(target, source);
        result.written.push(target);
        appendTelemetry(workspaceDir, {
          ts: new Date().toISOString(), event: 'write', target, scope: 'backend-python', warnings,
        });
      } catch (err) {
        result.errors.push(`backend(python) emit failed: ${err.message}`);
        appendTelemetry(workspaceDir, {
          ts: new Date().toISOString(), event: 'error', target, scope: 'backend-python', message: err.message,
        });
      }
    } else {
      const target = path.join(workspaceDir, 'backend', 'src', 'generated', 'contracts.ts');
      try {
        const { source, warnings } = emitTsContracts(envelope, { scope: 'backend' });
        for (const w of warnings) result.errors.push(`[backend/node] ${w}`);
        if (!opts.skipSelfTest) {
          const selfTest = selfTestTs(source, 'backend/contracts.ts', workspaceDir);
          if (selfTest.skipped) {
            // Non-fatal — log and continue.
            appendTelemetry(workspaceDir, {
              ts: new Date().toISOString(), event: 'selftest_skipped', scope: 'backend-node', reason: selfTest.reason,
            });
          }
        }
        atomicWrite(target, source);
        result.written.push(target);
        appendTelemetry(workspaceDir, {
          ts: new Date().toISOString(), event: 'write', target, scope: 'backend-node', warnings,
        });
      } catch (err) {
        result.errors.push(`backend(node) emit failed: ${err.message}`);
        appendTelemetry(workspaceDir, {
          ts: new Date().toISOString(), event: 'error', target, scope: 'backend-node', message: err.message,
        });
      }
    }
  }

  // ── Frontend ─────────────────────────────────────────────────────────
  if (hasFrontend) {
    const target = path.join(workspaceDir, 'frontend', 'src', 'generated', 'contracts.ts');
    try {
      const { source, warnings } = emitTsContracts(envelope, { scope: 'frontend' });
      for (const w of warnings) result.errors.push(`[frontend] ${w}`);
      if (!opts.skipSelfTest) {
        const selfTest = selfTestTs(source, 'frontend/contracts.ts', workspaceDir);
        if (selfTest.skipped) {
          appendTelemetry(workspaceDir, {
            ts: new Date().toISOString(), event: 'selftest_skipped', scope: 'frontend', reason: selfTest.reason,
          });
        }
      }
      atomicWrite(target, source);
      result.written.push(target);
      appendTelemetry(workspaceDir, {
        ts: new Date().toISOString(), event: 'write', target, scope: 'frontend', warnings,
      });
    } catch (err) {
      result.errors.push(`frontend emit failed: ${err.message}`);
      appendTelemetry(workspaceDir, {
        ts: new Date().toISOString(), event: 'error', target, scope: 'frontend', message: err.message,
      });
    }
  }

  if (!hasBackend && !hasFrontend) {
    result.skipped.push('no backend or frontend scope in file_structure — no types to emit');
  }

  appendTelemetry(workspaceDir, {
    ts: new Date().toISOString(),
    event: 'summary',
    written: result.written.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
    durationMs: Date.now() - startedAt,
  });

  return result;
}

// ── Small helpers ─────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}
