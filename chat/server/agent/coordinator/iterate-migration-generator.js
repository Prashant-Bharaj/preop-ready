/**
 * iterate-migration-generator.js — on an iterate, turn a PURELY ADDITIVE
 * data-model diff into `backend/migrations/NNN_contract_<slug>.sql`
 * deterministically, the way schema-generator emits the fresh schema.
 *
 * Emits only what is safe to apply to a live, populated database without
 * judgment: new tables (CREATE TABLE IF NOT EXISTS + conventional indexes)
 * and new columns that are nullable or carry a DEFAULT (ADD COLUMN IF NOT
 * EXISTS). Anything else — a prior column missing from the diff entry
 * (rename or drop), a NOT NULL column without DEFAULT (needs a backfill), a
 * declared removal or rename — returns null and the backend agent authors
 * the whole migration, as before. Prior columns are matched by NAME only:
 * the contract agent re-emits type text freely and a type change is the
 * agent's job either way (it sees the same diff). Emitting a partial file in those
 * cases is worse than nothing: a pre-staged ADD COLUMN body next to the
 * agent's guarded RENAME content→body would skip the rename and orphan the
 * data. Pure function.
 */

import { emitTable, emitIndexes, topologicalSort } from './schema-generator.js';

const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normType(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Column carrier on a change_tables entry. The canonical shape is a
// whole-table `columns` array (contract-agent.md § 11); `add_columns` is
// accepted for entries that list only what changed.
function columnsOf(entry) {
  const list = Array.isArray(entry.columns) ? entry.columns : (Array.isArray(entry.add_columns) ? entry.add_columns : []);
  return list.filter((c) => c && c.name && c.type);
}

function rawTableEntries(iterateDiffs) {
  const db = iterateDiffs?.database || iterateDiffs?.data_model || iterateDiffs?.dataModel || null;
  if (!db || typeof db !== 'object') return { entries: [], removals: false };
  const removals = ['remove_tables', 'remove_columns', 'rename_columns'].some((k) => Array.isArray(db[k]) && db[k].length > 0);
  const entries = [];
  for (const key of ['add_tables', 'change_tables', 'tables']) {
    if (Array.isArray(db[key])) entries.push(...db[key].filter((t) => t && typeof t.name === 'string'));
  }
  return { entries, removals };
}

export function nextMigrationName(existingFiles, slug) {
  let max = 0;
  for (const f of existingFiles || []) {
    const m = /^(\d+)[_-]/.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const clean = String(slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'iterate';
  return `${String(max + 1).padStart(3, '0')}_contract_${clean}.sql`;
}

/**
 * @returns {{ relPath: string, source: string, describe: string } | null}
 */
export function generateIterateMigration({ priorDataModel, dataModel, iterateDiffs, existingFiles = [], summary = '', now = new Date() } = {}) {
  const { entries, removals } = rawTableEntries(iterateDiffs);
  if (removals || entries.length === 0) return null;
  const priorTables = Array.isArray(priorDataModel?.tables) ? priorDataModel.tables : [];
  const mergedTables = Array.isArray(dataModel?.tables) ? dataModel.tables : [];
  const priorByName = new Map(priorTables.map((t) => [t.name, t]));
  const mergedByName = new Map(mergedTables.map((t) => [t.name, t]));

  const newTables = [];
  const addColumns = []; // { table, column }
  for (const entry of entries) {
    if (!SQL_IDENT.test(entry.name)) return null;
    const prior = priorByName.get(entry.name);
    const cols = columnsOf(entry);
    if (cols.some((c) => !SQL_IDENT.test(String(c.name)))) return null;
    if (!prior) {
      // New table: emit the MERGED definition (the contract store may have
      // normalized it) — fall back to the entry itself.
      newTables.push(mergedByName.get(entry.name) || entry);
      continue;
    }
    const priorNames = new Set((prior.columns || []).map((c) => c.name));
    if (!Array.isArray(entry.add_columns)) {
      // Whole-table entry: every prior column must still be listed — a
      // missing one is a rename or a drop, never ours to guess at.
      const entryNames = new Set(cols.map((c) => c.name));
      for (const name of priorNames) if (!entryNames.has(name)) return null;
    }
    for (const c of cols) {
      if (priorNames.has(c.name)) continue;
      const t = normType(c.type);
      if (/\bSERIAL\b|PRIMARY KEY/.test(t)) return null;
      if (/\bNOT NULL\b/.test(t) && !/\bDEFAULT\b/.test(t)) return null; // needs a backfill decision
      addColumns.push({ table: entry.name, column: c });
    }
  }
  if (newTables.length === 0 && addColumns.length === 0) return null;
  // A new table may reference an existing one (fine) or another new one
  // (order them); a reference to a table that exists nowhere is the agent's problem.
  const ordered = topologicalSort(newTables);

  const lines = [
    '-- AUTO-GENERATED from the contract diff — purely additive schema change.',
    `-- Generated ${now.toISOString()}${summary ? ` — ${summary.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`,
    '-- Applied once by backend/src/lib/migrate.ts (ledger: _migrations). Every',
    '-- statement is idempotent; renames, drops, type changes and NOT NULL',
    '-- backfills are never generated here — those are authored by hand.',
    '',
  ];
  for (const table of ordered) {
    emitTable(table, lines);
    emitIndexes(table, lines);
    lines.push('');
  }
  for (const { table, column } of addColumns) {
    lines.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column.name} ${String(column.type).trim()};`);
  }
  if (addColumns.length) lines.push('');

  const describe = [
    ordered.length ? `tables: ${ordered.map((t) => t.name).join(', ')}` : null,
    addColumns.length ? `columns: ${addColumns.map((c) => `${c.table}.${c.column.name}`).join(', ')}` : null,
  ].filter(Boolean).join('; ');
  return {
    relPath: `backend/migrations/${nextMigrationName(existingFiles, summary)}`,
    source: lines.join('\n'),
    describe,
  };
}
