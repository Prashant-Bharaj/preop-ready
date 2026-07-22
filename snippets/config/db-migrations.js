/**
 * SNIPPET: Database Migrations Runner
 * CATEGORY: Configuration
 * LANGUAGE: JavaScript (Node.js + pg)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Simple migration runner: tracks applied migrations in a _migrations
 *   table and runs pending .sql files from backend/migrations/ in order
 *   on startup.
 *
 *   WHY MIGRATIONS: init scripts in database/init/ only run ONCE, on
 *   first deployment when the database is empty. After that, editing
 *   init.sql does NOTHING — the database already exists. All schema
 *   changes after first deploy must go through migrations so existing
 *   data stays safe.
 *
 * MIGRATION RULES:
 *   - Always ADD new migrations, never edit old ones (already applied)
 *   - Name files sequentially: 001_add_user_email.sql, 002_..., etc.
 *     (files run in alphabetical order)
 *   - Make migrations idempotent when possible:
 *       CREATE TABLE IF NOT EXISTS ...
 *       ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)
 *   - Test migrations locally (docker-compose) before deploying
 *   - Never delete data columns without backing up first
 *   - Never rename tables/columns (add new, migrate data, drop old)
 *
 * DEPENDENCIES:
 *   npm install pg
 *
 * USAGE:
 *   1. Create backend/migrations/ and add ordered .sql files:
 *        backend/migrations/001_add_user_email.sql
 *        backend/migrations/002_add_created_at.sql
 *
 *   2. Run on startup (in server.js, after the pool is created):
 *        const { runMigrations } = require('./db/migrations');
 *        await runMigrations(pool);
 *        console.log('Database migrations complete');
 */

const fs = require('fs');
const path = require('path');

// Directory containing ordered .sql migration files. Resolved from the
// process working directory — the backend always starts in its own root
// (container WORKDIR /app, or `cd backend && node ...` locally) — so this is
// backend/migrations/ NO MATTER where this runner file was copied to.
// ⛔ Migration files MUST live in backend/migrations/: the backend image only
// contains backend/, so files in database/ or the repo root can NEVER run.
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

/**
 * Run all pending migrations, in filename order.
 * Safe to call on every startup — already-applied migrations are skipped.
 * @param {import('pg').Pool} pool - pg connection pool
 */
async function runMigrations(pool) {
  // Track applied migrations (idempotent — safe on every startup)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    // Loud, not silent: a missing dir usually means migration files were
    // placed somewhere the backend cannot see (database/migrations/ or the
    // repo root are NOT inside the backend image).
    console.warn(`[migrations] No ${MIGRATIONS_DIR} directory — 0 migrations ran. ` +
      'Migration .sql files must live in backend/migrations/.');
    return;
  }

  // Ordered by filename: 001_..., 002_..., etc.
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT name FROM _migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`Running migration: ${file}`);

    // Each migration runs in its own transaction — all or nothing
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (name) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Migration failed: ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations };
