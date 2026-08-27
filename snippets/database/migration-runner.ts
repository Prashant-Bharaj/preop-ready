/**
 * scopes: [backend]
 * flags: []
 * description: Numbered SQL migration runner (TypeScript) for post-deploy schema changes.
 */

/**
 * Database Migration Runner (TypeScript)
 *
 * Run numbered SQL migration files on startup, before the server starts.
 * Place migration files in backend/migrations/ with numbered names:
 *   001-create-users.sql, 002-add-email-column.sql, etc.
 *
 * Init scripts (database/init/) only run on FIRST deployment.
 * For schema changes after first deployment, use this migration runner.
 *
 * IMPORTANT: Always use IF NOT EXISTS / IF EXISTS guards for idempotency.
 * Never DROP tables without backing up data first.
 *
 * Usage: import runMigrations from './migrate.js'; await runMigrations(pool); server.listen(PORT);
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    try {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await pool.query(sql);
      console.log(`Migration applied: ${file}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Migration failed: ${file}`, message);
      throw err;
    }
  }
}

export default runMigrations;
