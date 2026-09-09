/**
 * migration-verify.js — after compose up, prove that every
 * backend/migrations/*.sql was applied by the runner inside the backend
 * container (ledger table `_migrations`).
 *
 * The harness used to psql-apply `database/migrations/*.sql` into the local
 * DB itself. That made local builds pass while production never ran the
 * files (the backend image contains only backend/, and nothing else applies
 * SQL there). Verifying the runner's own ledger holds local to the same
 * mechanism production uses. Pure except readLedger (injected).
 */

import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_DIR = 'backend/migrations';
export const LEDGER_TABLE = '_migrations';

/** Sorted *.sql names under backend/migrations, [] when absent. */
export function listMigrationFiles(workspaceDir) {
  const dir = path.join(workspaceDir, MIGRATIONS_DIR);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

/**
 * @param {object} args
 * @param {string[]} args.files - migration file names on disk
 * @param {string[]|null} args.ledger - names recorded in _migrations; null when
 *   the table does not exist (the runner never ran)
 * @returns {{ status: 'none'|'done'|'warn', applied: string[], pending: string[], detail: string }}
 */
export function computeMigrationStatus({ files, ledger }) {
  if (files.length === 0) return { status: 'none', applied: [], pending: [], detail: '' };
  if (ledger === null) {
    return {
      status: 'warn',
      applied: [],
      pending: files,
      detail: `${files.length} file(s) in ${MIGRATIONS_DIR} but the ${LEDGER_TABLE} table does not exist — the migration runner never ran; the backend must \`await runMigrations(pool)\` (src/lib/migrate.ts) before app.listen`,
    };
  }
  const recorded = new Set(ledger);
  const applied = files.filter((f) => recorded.has(f));
  const pending = files.filter((f) => !recorded.has(f));
  if (pending.length === 0) {
    return { status: 'done', applied, pending, detail: `${applied.length} applied by the backend runner (${applied.join(', ')})` };
  }
  return {
    status: 'warn',
    applied,
    pending,
    detail: `${pending.length} migration(s) not recorded in ${LEDGER_TABLE}: ${pending.join(', ')} — the runner ran but skipped/failed them (check the backend log for [migrations] lines) or the file is not in the image`,
  };
}

/**
 * @param {string} workspaceDir
 * @param {() => string[]|null} readLedger - returns recorded names, or null when the table is missing
 */
export function verifyMigrationsApplied(workspaceDir, readLedger) {
  const files = listMigrationFiles(workspaceDir);
  if (files.length === 0) return computeMigrationStatus({ files, ledger: [] });
  let ledger = null;
  try { ledger = readLedger(); } catch { ledger = null; }
  return computeMigrationStatus({ files, ledger });
}
