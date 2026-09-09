/**
 * scopes: [backend]
 * flags: []
 * description: Numbered SQL migration runner (TypeScript, ESM) — applies backend/migrations/*.sql once each at startup, ledger in _migrations.
 */

/**
 * Database Migration Runner
 *
 * The harness stages this file at backend/src/lib/migrate.ts. Call it once
 * at startup, BEFORE app.listen:
 *
 *   import { pool } from './db.js';
 *   import { runMigrations } from './lib/migrate.js';
 *   await runMigrations(pool);
 *   app.listen(PORT, ...);
 *
 * Migration files live in backend/migrations/ (the Dockerfile ships that
 * folder into the runtime image) and are named NNN_description.sql:
 *   001_add_projects.sql, 002_add_notes_category.sql, ...
 * Files run in name order, each once, each in its own transaction; the
 * _migrations table records what ran. Init scripts (database/init/) only
 * run on the FIRST boot of an empty volume — every schema change after that
 * is a migration. Write idempotent SQL anyway (IF NOT EXISTS / IF EXISTS).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// dist/lib/migrate.js → /app/migrations (compiled) — src/lib/migrate.ts →
// backend/migrations (ts-node/dev). Resolved from this file, never from the
// working directory, which depends on how the process was launched.
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export async function runMigrations(pool: Pool): Promise<string[]> {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log(`[migrations] no ${MIGRATIONS_DIR} directory — nothing to apply`);
    return [];
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('[migrations] no migration files — nothing to apply');
    return [];
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrations] applied ${file}`);
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrations] FAILED ${file}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      client.release();
    }
  }
  console.log(`[migrations] ${ran.length} applied, ${files.length - ran.length} already applied`);
  return ran;
}

export default runMigrations;
