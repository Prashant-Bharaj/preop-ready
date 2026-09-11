// sql-validation-db.js — a long-lived, pre-warmed Postgres used only to VALIDATE
// generated SQL (via PREPARE), never to run the app.
//
// Why warm: booting a postgres container costs ~10s cold. We boot ONE pgvector
// container (`dd-sql-validator`) when the chat server starts and keep it; each
// build then just creates a throwaway DATABASE inside it (CREATE DATABASE → load
// schema → PREPARE → DROP), ~1-2s, no per-build container boot. Concurrent
// builds (smoke --parallel, separate processes) share the container and use
// uniquely-named DBs, so they don't collide. No host port is published — all
// access is via `docker exec … psql`, so it never conflicts with app ports.
//
// Everything fails OPEN: if docker is down, the image can't be pulled, or the
// container isn't ready, callers get a thrown error / and the SQL gate is simply
// skipped (no build is ever blocked because validation infra was unavailable).

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tlog } from '../util/timestamped-log.js';

const execFileP = promisify(execFile);

const CONTAINER = 'dd-sql-validator';
const IMAGE = 'pgvector/pgvector:0.7.4-pg16'; // superset: vector extension + plain postgres
const SUPERUSER = 'postgres';
const READY_TIMEOUT_MS = 60_000;

async function docker(args, { timeoutMs = 30_000 } = {}) {
  return execFileP('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}

async function isRunning() {
  try {
    const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeoutMs: 8_000 });
    return stdout.trim() === 'true';
  } catch {
    return false; // not present
  }
}

async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await docker(['exec', CONTAINER, 'pg_isready', '-U', SUPERUSER], { timeoutMs: 5_000 });
      return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * Idempotently ensure the validator container is running + accepting connections.
 * Safe under concurrency (a racing `docker run` that loses with "name in use"
 * is treated as success). Returns true when ready, false otherwise (fail-open).
 */
export async function ensureValidatorRunning() {
  if (await isRunning()) return waitReady();
  // Remove any stopped/stale container with the same name, then start fresh.
  try { await docker(['rm', '-f', CONTAINER], { timeoutMs: 15_000 }); } catch { /* none */ }
  try {
    await docker(
      ['run', '-d', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=validator`, '-e', `POSTGRES_USER=${SUPERUSER}`, IMAGE],
      { timeoutMs: 180_000 }, // first run may pull the image
    );
  } catch (err) {
    // Lost a create race → another process already started it: fine. Otherwise fail-open.
    if (!/already in use|Conflict/i.test(err.stderr?.toString() || err.message || '')) {
      tlog('[sql-validator] could not start %s (fail-open, SQL gate disabled): %s', CONTAINER, (err.message || '').slice(0, 160));
      return false;
    }
  }
  return waitReady();
}

/** Fire-and-forget warm-up for chat-server startup (never throws/blocks). */
export function startValidatorInBackground() {
  ensureValidatorRunning()
    .then((ok) => tlog('[sql-validator] warm-up %s', ok ? 'ready' : 'unavailable (SQL gate will fail-open)'))
    .catch(() => { /* fully best-effort */ });
}

/** Teardown for graceful shutdown. */
export async function stopValidator() {
  try { await docker(['rm', '-f', CONTAINER], { timeoutMs: 15_000 }); } catch { /* ignore */ }
}

function psqlArgs(dbName, sqlArgs) {
  return ['exec', '-i', CONTAINER, 'psql', '-U', SUPERUSER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', ...sqlArgs];
}

async function createDb() {
  const dbName = `v_${randomBytes(6).toString('hex')}`;
  // CREATE DATABASE must run against an existing DB (postgres).
  await docker(psqlArgs('postgres', ['-c', `CREATE DATABASE ${dbName}`]), { timeoutMs: 15_000 });
  return dbName;
}

async function dropDb(dbName) {
  // FORCE drops any lingering connections (PG13+). Best-effort.
  try { await docker(psqlArgs('postgres', ['-c', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]), { timeoutMs: 15_000 }); } catch { /* ignore */ }
}

// Pull the SQL out of a shell init script — the pgvector scaffold (and many DB
// images) define schema in a `.sh` that pipes a psql heredoc, e.g.
//   psql ... <<-EOSQL
//     CREATE TABLE ...;
//   EOSQL
// We extract heredoc bodies and any inline `psql -c "..."` so .sh-defined tables
// load too. (docker-entrypoint-initdb.d runs .sh and .sql alike; mirroring that
// is what lets the gate SEE the real schema instead of false-flagging it.)
function extractSqlFromShell(text) {
  const parts = [];
  const heredoc = /<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n[ \t]*\1\b/g;
  let m;
  while ((m = heredoc.exec(text))) parts.push(m[2]);
  const cflag = /psql[^\n]*?\s-c\s+(['"])([\s\S]*?)\1/g;
  while ((m = cflag.exec(text))) parts.push(m[2]);
  return parts.join('\n;\n');
}

// Load one scope's init schema into a fresh DB. Returns true if the whole schema
// applied cleanly, false if any file errored (→ that scope is unreliable and
// the gate won't judge queries against it: fail-open, never a false block).
async function loadSchema(dbName, sqlPaths) {
  await docker(psqlArgs(dbName, ['-c', 'CREATE EXTENSION IF NOT EXISTS vector']), { timeoutMs: 15_000 })
    .catch(() => { /* non-pgvector schemas don't need it; ignore */ });
  for (const p of sqlPaths) {
    let sql;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      sql = p.endsWith('.sh') ? extractSqlFromShell(raw) : raw;
    } catch { continue; }
    if (!sql.trim()) continue; // .sh with no extractable SQL → skip, not a failure
    try {
      // Pass the whole file as a single -c command (libpq runs all the
      // semicolon-separated statements). execFile passes args without a shell,
      // so there's nothing to escape — and async execFile has no stdin `input`
      // option, so `-f -` piping would silently load nothing.
      await docker(psqlArgs(dbName, ['-c', sql]), { timeoutMs: 30_000 });
    } catch {
      return false; // schema didn't fully apply
    }
  }
  return true;
}

/**
 * Validate against PER-SCOPE schemas. The backend uses two separate Postgres
 * instances (relational + vector); merging their schemas into one DB collides
 * on same-named tables (e.g. `documents`), so each scope gets its own DB.
 *
 * @param {{relational?: string[], vector?: string[]}} schemaSets — init.sql
 *   paths per scope. A scope with no paths is skipped.
 * @param {(ctx: {runSql: Function, available: Set<string>}) => Promise<any>} fn
 *   - `available` : the set of scope keys whose schema loaded cleanly.
 *   - `runSql(scopeKey, sql)` → { ok, stderr } : runs one statement against
 *     that scope's DB via `psql -c`; never throws. Returns ok:true (no-op) when
 *     the scope's DB isn't available, so callers can't false-positive on it.
 *
 * Returns whatever `fn` returns. Throws only if the validator container itself
 * is unavailable (callers catch → fail-open). Drops all created DBs on exit.
 */
export async function withValidationDbs(schemaSets, fn) {
  if (!(await ensureValidatorRunning())) {
    throw new Error('validator DB unavailable');
  }
  const dbByScope = {}; // scopeKey → dbName (only scopes that loaded cleanly)
  const created = [];
  try {
    for (const [scope, paths] of Object.entries(schemaSets)) {
      if (!paths || paths.length === 0) continue;
      const dbName = await createDb();
      created.push(dbName);
      if (await loadSchema(dbName, paths)) dbByScope[scope] = dbName;
    }
    const runSql = async (scope, sql) => {
      const dbName = dbByScope[scope];
      if (!dbName) return { ok: true, stderr: '' }; // scope unavailable → can't judge
      try {
        await docker(psqlArgs(dbName, ['-c', sql]), { timeoutMs: 10_000 });
        return { ok: true, stderr: '' };
      } catch (err) {
        return { ok: false, stderr: (err.stderr?.toString() || err.message || '').trim() };
      }
    };
    return await fn({ runSql, available: new Set(Object.keys(dbByScope)) });
  } finally {
    for (const dbName of created) await dropDb(dbName);
  }
}
