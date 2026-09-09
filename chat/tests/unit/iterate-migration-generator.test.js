/**
 * Unit tests for deterministic iterate migrations (additive-only).
 *
 * Module under test:
 *   chat/server/agent/coordinator/iterate-migration-generator.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateIterateMigration, nextMigrationName } from '../../server/agent/coordinator/iterate-migration-generator.js';

const notes = { name: 'notes', columns: [
  { name: 'id', type: 'SERIAL PRIMARY KEY' },
  { name: 'title', type: 'VARCHAR(200) NOT NULL' },
  { name: 'content', type: 'TEXT NOT NULL' },
  { name: 'created_at', type: 'TIMESTAMPTZ DEFAULT NOW()' },
] };
const prior = { tables: [notes] };
const withCategory = { ...notes, columns: [...notes.columns, { name: 'category', type: "VARCHAR(20) NOT NULL DEFAULT 'general' CHECK (category IN ('general','urgent','info'))" }] };

test('add-field: defaulted column on an existing table → ADD COLUMN IF NOT EXISTS, numbered after existing files', () => {
  const mig = generateIterateMigration({
    priorDataModel: prior,
    dataModel: { tables: [withCategory] },
    iterateDiffs: { database: { change_tables: [withCategory] } },
    existingFiles: ['001_add_users.sql', 'notes.md'],
    summary: 'Add a category to notes',
    now: new Date('2026-01-01T00:00:00Z'),
  });
  assert.equal(mig.relPath, 'backend/migrations/002_contract_add_a_category_to_notes.sql');
  assert.match(mig.source, /ALTER TABLE notes ADD COLUMN IF NOT EXISTS category VARCHAR\(20\) NOT NULL DEFAULT 'general' CHECK/);
  assert.doesNotMatch(mig.source, /CREATE TABLE/);
  assert.equal(mig.describe, 'columns: notes.category');
});

test('add-entity: new table with FK to an existing one → CREATE TABLE IF NOT EXISTS + FK index; new FK column on notes', () => {
  const projects = { name: 'projects', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'name', type: 'VARCHAR(100) NOT NULL' }] };
  const notesWithProject = { ...withCategory, columns: [...withCategory.columns, { name: 'project_id', type: 'INTEGER REFERENCES projects(id) ON DELETE SET NULL' }] };
  const mig = generateIterateMigration({
    priorDataModel: { tables: [withCategory] },
    dataModel: { tables: [notesWithProject, projects] },
    iterateDiffs: { database: { add_tables: [projects], change_tables: [notesWithProject] } },
    existingFiles: ['001_a.sql'],
    summary: 'Add projects',
  });
  assert.match(mig.source, /CREATE TABLE IF NOT EXISTS projects \(/);
  assert.match(mig.source, /ALTER TABLE notes ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects\(id\) ON DELETE SET NULL;/);
  assert.ok(mig.source.indexOf('CREATE TABLE IF NOT EXISTS projects') < mig.source.indexOf('ALTER TABLE notes'));
  assert.equal(mig.describe, 'tables: projects; columns: notes.project_id');
  assert.equal(mig.relPath, 'backend/migrations/002_contract_add_projects.sql');
});

test('rename (prior column missing from the entry), declared rename, NOT NULL without default, removals → null', () => {
  const renamed = { ...notes, columns: notes.columns.map((c) => (c.name === 'content' ? { name: 'body', type: 'TEXT NOT NULL' } : c)) };
  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: { tables: [renamed] }, iterateDiffs: { database: { change_tables: [renamed] } } }), null);

  // Declared rename alongside an otherwise-additive entry → the agent owns it.
  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: { tables: [withCategory] }, iterateDiffs: { database: { change_tables: [withCategory], rename_columns: [{ table: 'notes', from: 'content', to: 'body' }] } } }), null);

  // Re-emitted type text differs but the column is still there by name → not a blocker.
  const retyped = { ...withCategory, columns: withCategory.columns.map((c) => (c.name === 'title' ? { ...c, type: 'varchar(200) not null' } : c)) };
  assert.match(generateIterateMigration({ priorDataModel: prior, dataModel: { tables: [retyped] }, iterateDiffs: { database: { change_tables: [retyped] } } }).source, /ADD COLUMN IF NOT EXISTS category/);

  const backfill = { ...notes, columns: [...notes.columns, { name: 'owner_id', type: 'INTEGER NOT NULL REFERENCES users(id)' }] };
  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: { tables: [backfill] }, iterateDiffs: { database: { change_tables: [backfill] } } }), null);

  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: { tables: [withCategory] }, iterateDiffs: { database: { change_tables: [withCategory], remove_columns: [{ table: 'notes', column: 'content' }] } } }), null);
});

test('add_columns entry (only what changed) is accepted as additive', () => {
  const mig = generateIterateMigration({
    priorDataModel: prior,
    dataModel: { tables: [withCategory] },
    iterateDiffs: { database: { change_tables: [{ name: 'notes', add_columns: [{ name: 'category', type: "VARCHAR(20) DEFAULT 'general'" }] }] } },
  });
  assert.match(mig.source, /ALTER TABLE notes ADD COLUMN IF NOT EXISTS category VARCHAR\(20\) DEFAULT 'general';/);
});

test('no database diff, partial entry, or unchanged table → null', () => {
  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: prior, iterateDiffs: { backend: { add_endpoints: [] } } }), null);
  const partial = { name: 'notes', columns: [{ name: 'category', type: 'VARCHAR(20)' }] }; // omits prior columns
  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: prior, iterateDiffs: { database: { change_tables: [partial] } } }), null);
  assert.equal(generateIterateMigration({ priorDataModel: prior, dataModel: prior, iterateDiffs: { database: { change_tables: [notes] } } }), null);
});

test('nextMigrationName pads and slugs', () => {
  assert.equal(nextMigrationName([], ''), '001_contract_iterate.sql');
  assert.equal(nextMigrationName(['009_x.sql', '010-y.sql'], 'Add "Search"!'), '011_contract_add_search.sql');
});
