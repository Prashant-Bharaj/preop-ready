// sql-prepare-gate.js — validate the backend's SQL against the real schema using
// Postgres as the oracle (PREPARE), replacing the regex column check that
// false-positived on JOINs.
//
// Flow: AST-extract the backend's static queries → load the build's schema
// (init.sql + .sh init scripts + DDL the app runs in code) into a throwaway DB
// in the warm validator container → `PREPARE` each query (parse + name/type
// analysis, NO execution) → a query that selects a column a loaded table
// doesn't have raises a definitive Postgres error → hard finding.
//
// FAIL-OPEN by construction. The ONLY hard block is "column does not exist" on
// a table we actually loaded. "relation does not exist" (table missing) is NOT
// blocked: a table can come from init.sql, a .sh init, app code, or a migration
// — sources we can't all see — so the signal is unreliable, and blocking on it
// drove the re-engage loop to corrupt correct code. Dynamic SQL (skipped at
// extraction), other errors, or unavailable infra → no finding, never a block.
// Postgres resolves joins/aliases/`'literals'`/pgvector ops, so the original
// regex false-positive is impossible.

import fs from 'node:fs';
import path from 'node:path';
import { tlog } from '../util/timestamped-log.js';
import { extractBackendQueries } from './sql-extract/extract-queries.js';
import { withValidationDbs } from './sql-validation-db.js';

const MAX_QUERIES = 300; // backstop against pathological extraction

// The ONLY hard-blocking outcome: a column that doesn't exist on a table the
// validation DB actually loaded. "relation does not exist" is intentionally
// NOT blocked (fail-open) — see the gate loop for why.
const UNDEFINED_COLUMN = /column "([^"]+)" does not exist/i;

// Backend scope → validation-DB key. The relational DB (database/init) and the
// vector DB (vectordb/init) are separate Postgres instances in production, so
// each gets its own validation DB — never merged (same-named tables collide).
const SCOPE_DIRS = { relational: 'database', vector: 'vectordb' };

function collectInitSqlByScope(workspaceDir) {
  const out = { relational: [], vector: [] };
  for (const [key, dirName] of Object.entries(SCOPE_DIRS)) {
    const dir = path.join(workspaceDir, dirName, 'init');
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    // Both .sql and .sh — docker-entrypoint-initdb.d runs both, and the
    // pgvector scaffold defines the vector schema in a .sh psql heredoc. Sorted
    // by name so they apply in the same order the container would run them.
    for (const f of entries.filter((n) => n.endsWith('.sql') || n.endsWith('.sh')).sort()) {
      out[key].push(path.join(dir, f));
    }
  }
  return out;
}

// Every query is validated against ALL loaded schemas, and is considered valid
// if ANY of them accepts it; it's only flagged when EVERY schema rejects it.
//
// We deliberately do NOT route by pool name. The backend uses two Postgres
// instances (relational + vector), but a query's receiver is often a generic
// transaction handle (`client`/`conn`/`tx` from `vectorPool.connect()`) whose
// target pool can't be known without dataflow analysis — guessing by name
// mis-routed real queries to the wrong schema and false-blocked correct builds.
// "Accept if any schema has it" also handles same-named tables across the two
// scopes (each query matches whichever schema actually has its columns) while
// still catching a genuinely undeclared column/table (rejected everywhere).

// The leading SQL keyword, ignoring leading whitespace and comments.
function leadingKeyword(sql) {
  let s = sql;
  const strip = /^(\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)/;
  let prev;
  do { prev = s; s = s.replace(strip, ''); } while (s !== prev);
  return (s.match(/^([a-zA-Z]+)/)?.[1] || '').toUpperCase();
}

// DDL the app runs at startup (CREATE TABLE/INDEX/EXTENSION, ALTER, DROP). It's
// part of the real schema even though it lives in code rather than init.sql, so
// we EXECUTE it into the validation DB before PREPAREing the DML — otherwise a
// query against an app-created table (e.g. a pgvector `contract_chunks` made via
// `CREATE TABLE IF NOT EXISTS` in vectordb.ts) would be wrongly flagged as
// referencing an undeclared relation. PREPARE doesn't accept DDL anyway.
const DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP']);
const isDdl = (sql) => DDL_KEYWORDS.has(leadingKeyword(sql));

/**
 * Run the PREPARE oracle. Returns { ran, findings, checked }.
 *   - ran=false → gate skipped (no queries, no schema, or infra unavailable)
 *   - findings  → hard mismatches in the reconciler's shape
 */
export async function runSqlPrepareGate(workspaceDir, { sessionId } = {}) {
  const queries = extractBackendQueries(workspaceDir).slice(0, MAX_QUERIES);
  if (queries.length === 0) return { ran: false, findings: [], checked: 0 };

  const schemaSets = collectInitSqlByScope(workspaceDir);
  if (schemaSets.relational.length === 0 && schemaSets.vector.length === 0) {
    return { ran: false, findings: [], checked: 0 };
  }

  // Separate the schema the app creates in code (DDL) from the queries we
  // validate (DML). DDL is applied to the validation DB; DML is PREPAREd.
  const ddl = queries.filter((q) => isDdl(q.sql));
  const dml = queries.filter((q) => !isDdl(q.sql));

  const findings = [];
  let ran = false;
  try {
    await withValidationDbs(schemaSets, async ({ runSql, available }) => {
      if (available.size === 0) return; // no schema loaded cleanly → fail-open
      ran = true;
      const scopes = [...available];
      // 1. Apply app-created schema (into every scope) so queries against
      //    app-managed tables aren't mistaken for undeclared relations.
      //    Failures are ignored (fail-open).
      for (const q of ddl) {
        for (const scope of scopes) {
          await runSql(scope, q.sql);
        }
      }
      // 2. PREPARE the DML against every schema; valid if ANY accepts it.
      for (const q of dml) {
        // PREPARE against each schema; a query is valid if ANY accepts it.
        // Only when EVERY schema rejects it is it a real finding.
        const errs = [];
        let acceptedSomewhere = false;
        for (const scope of scopes) {
          const { ok, stderr } = await runSql(scope, `PREPARE _c AS ${q.sql}`);
          if (ok) { acceptedSomewhere = true; break; }
          errs.push(stderr);
        }
        if (acceptedSomewhere) continue;

        // ONLY block on a bad column against a table the validation DB actually
        // has (undefined_column means some schema HAS the table but not the
        // column — the precise, trustworthy bug class, e.g. the original JOIN
        // typo). We deliberately do NOT block on undefined_relation (table
        // missing): a table can legitimately be created in init.sql, a .sh init
        // script, app code, or a migration — sources we can't all see — so
        // "table missing" is an unreliable signal. Worse, blocking on it makes
        // the re-engage loop tell the agent to "fix" a table that's actually
        // fine, which corrupts correct code. So relation-missing → fail-open.
        const colErr = errs.find((e) => UNDEFINED_COLUMN.test(e));
        if (colErr) {
          findings.push({
            kind: 'sql-undeclared-column', scope: 'backend', severity: 'hard',
            file: q.file, line: q.line, sql: q.sql,
            contract: `query references column "${UNDEFINED_COLUMN.exec(colErr)[1]}" not present in the schema (init.sql, .sh init, or app-created tables)`,
            actual: colErr.split('\n')[0],
          });
        }
        // undefined_relation and any other psql error → fail-open (ignore)
      }
    });
  } catch (err) {
    // validator unavailable / docker down → skip the gate entirely
    tlog('[sql-prepare-gate] skipped (fail-open): %s', (err.message || '').slice(0, 140));
    return { ran: false, findings: [], checked: queries.length };
  }

  if (!ran) return { ran: false, findings: [], checked: dml.length };

  tlog('[sql-prepare-gate] checked %d quer(ies) (+%d app DDL applied) → %d undeclared-column/relation finding(s)%s',
    dml.length, ddl.length, findings.length, sessionId ? ` [${sessionId}]` : '');
  return { ran: true, findings, checked: dml.length };
}
