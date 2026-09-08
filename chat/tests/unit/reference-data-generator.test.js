/**
 * Unit tests for the reference-data generator (starter rows for tables the
 * API acts on via :id routes but never creates).
 *
 * Module under test:
 *   chat/server/agent/coordinator/reference-data-generator.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findReferenceTables,
  generateReferenceData,
  REFERENCE_DATA_FILE,
} from '../../server/agent/coordinator/reference-data-generator.js';

const users = { name: 'users', columns: [
  { name: 'id', type: 'SERIAL PRIMARY KEY' },
  { name: 'oidc_sub', type: 'TEXT UNIQUE NOT NULL' },
  { name: 'email', type: 'VARCHAR(255) NOT NULL' },
] };
const lines = { name: 'lines', columns: [
  { name: 'id', type: 'SERIAL PRIMARY KEY' },
  { name: 'name', type: 'VARCHAR(100) NOT NULL' },
  { name: 'current_status', type: "VARCHAR(20) NOT NULL DEFAULT 'down' CHECK (current_status IN ('running','blocked','down'))" },
] };
const statusChanges = { name: 'status_changes', columns: [
  { name: 'id', type: 'SERIAL PRIMARY KEY' },
  { name: 'line_id', type: 'INTEGER REFERENCES lines(id) NOT NULL' },
  { name: 'old_status', type: 'VARCHAR(20) NOT NULL' },
  { name: 'changed_at', type: 'TIMESTAMPTZ DEFAULT NOW()' },
] };

// The realtime-status-board contract that failed silently live.
const realtime = {
  dataModel: { tables: [users, lines, statusChanges] },
  apiContract: { endpoints: [
    { method: 'GET', path: '/whoami' },
    { method: 'GET', path: '/lines' },
    { method: 'GET', path: '/lines/:id' },
    { method: 'POST', path: '/lines/:id/status', request: { status: 'string required, one of: running|blocked|down' } },
    { method: 'GET', path: '/history', request: { limit: 'number optional' } },
  ] },
};

test('realtime-status-board: only `lines` is a reference table; users and history are not', () => {
  const found = findReferenceTables(realtime);
  assert.deepEqual(found.map((f) => [f.table.name, f.prefixes]), [['lines', ['/lines']]]);

  const out = generateReferenceData(realtime, { now: new Date('2026-01-01T00:00:00Z') });
  assert.deepEqual(out.seeded, [{ table: 'lines', rows: 3, columns: ['name'] }]);
  assert.deepEqual(out.skipped, []);
  assert.match(out.source, /IF NOT EXISTS \(SELECT 1 FROM lines\)/);
  assert.match(out.source, /INSERT INTO lines \(name\) VALUES\n\s+\('Line 1'\),\n\s+\('Line 2'\),\n\s+\('Line 3'\);/);
  // DEFAULT column left to the database; identity table never touched.
  assert.doesNotMatch(out.source, /current_status/);
  assert.doesNotMatch(out.source, /INSERT INTO users/);
  assert.equal(REFERENCE_DATA_FILE, 'database/init/02_reference_data.sql');
});

test('a collection POST makes the table creatable → nothing seeded (CRUD app)', () => {
  const crud = {
    dataModel: { tables: [users, { name: 'entries', columns: [
      { name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'title', type: 'TEXT NOT NULL' },
    ] }] },
    apiContract: { endpoints: [
      { method: 'POST', path: '/entries', request: { title: 'string required' } },
      { method: 'GET', path: '/entries/:id' },
      { method: 'PUT', path: '/entries/:id' },
      { method: 'DELETE', path: '/entries/:id' },
    ] },
  };
  assert.deepEqual(findReferenceTables(crud), []);
  assert.equal(generateReferenceData(crud), null);
});

test('creator detection: nested POST, field overlap, and file upload all count as creators', () => {
  const tasks = { name: 'tasks', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'title', type: 'TEXT NOT NULL' }] };
  const reports = { name: 'reports', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'prompt', type: 'TEXT NOT NULL' }] };
  const documents = { name: 'documents', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'file_path', type: 'TEXT NOT NULL' }] };
  const contract = {
    dataModel: { tables: [tasks, reports, documents] },
    apiContract: { endpoints: [
      { method: 'POST', path: '/projects/:id/tasks', request: { title: 'string required' } },
      { method: 'PATCH', path: '/tasks/:id' },
      { method: 'POST', path: '/generate', request: { prompt: 'string required' } },
      { method: 'GET', path: '/reports/:id' },
      { method: 'POST', path: '/upload', request: { file: 'file required' } },
      { method: 'DELETE', path: '/documents/:id' },
    ] },
  };
  assert.deepEqual(findReferenceTables(contract), []);
});

test('an update route alone is not a creator; singular/plural and admin prefixes match', () => {
  const categories = { name: 'categories', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'name', type: 'TEXT NOT NULL' }] };
  const contract = {
    dataModel: { tables: [categories] },
    apiContract: { endpoints: [
      { method: 'PUT', path: '/admin/category/:id', request: { name: 'string required' } },
      { method: 'GET', path: '/categories' },
    ] },
  };
  const found = findReferenceTables(contract);
  assert.deepEqual(found.map((f) => [f.table.name, f.prefixes]), [['categories', ['/admin/category']]]);
});

test('value derivation covers enums, numbers, booleans, dates, json, codes, and FK-to-seeded tables', () => {
  const plants = { name: 'plants', columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'code', type: 'VARCHAR(10) UNIQUE NOT NULL' },
    { name: 'active', type: 'BOOLEAN NOT NULL' },
  ] };
  const machines = { name: 'machines', columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'plant_id', type: 'INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE' },
    { name: 'name', type: 'TEXT' },
    { name: 'kind', type: "TEXT NOT NULL CHECK (kind IN ('press', 'mill'))" },
    { name: 'capacity', type: 'NUMERIC(10,2) NOT NULL' },
    { name: 'installed_on', type: 'DATE NOT NULL' },
    { name: 'settings', type: 'JSONB NOT NULL' },
    { name: 'notes', type: 'TEXT' },
  ] };
  const contract = {
    dataModel: { tables: [machines, plants] }, // deliberately out of FK order
    apiContract: { endpoints: [
      { method: 'PATCH', path: '/plants/:id' },
      { method: 'PATCH', path: '/machines/:id/status' },
    ] },
  };
  const out = generateReferenceData(contract);
  assert.deepEqual(out.seeded.map((s) => s.table), ['plants', 'machines']);
  assert.match(out.source, /INSERT INTO plants \(code, active\) VALUES\n\s+\('PLANT-1', TRUE\)/);
  assert.match(out.source, /INSERT INTO machines \(plant_id, name, kind, capacity, installed_on, settings\) VALUES/);
  assert.match(out.source, /\(\(SELECT MIN\(id\) FROM plants\), 'Machine 1', 'press', 1, CURRENT_DATE, '\{\}'\)/);
  assert.match(out.source, /'Machine 2', 'mill', 2/);
  assert.match(out.source, /'Machine 3', 'press', 3/);
  assert.doesNotMatch(out.source, /notes/);
});

test('unsafe tables are skipped whole: NOT NULL FK to an unseeded table, unknown type, too-short VARCHAR', () => {
  const shifts = { name: 'shifts', columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'supervisor_id', type: 'INTEGER NOT NULL REFERENCES users(id)' },
  ] };
  const zones = { name: 'zones', columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'area', type: 'GEOMETRY NOT NULL' },
  ] };
  const tags = { name: 'tags', columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'name', type: 'VARCHAR(3) NOT NULL' },
  ] };
  const ok = { name: 'racks', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }] };
  const contract = {
    dataModel: { tables: [users, shifts, zones, tags, ok] },
    apiContract: { endpoints: [
      { method: 'PUT', path: '/shifts/:id' }, { method: 'PUT', path: '/zones/:id' },
      { method: 'PUT', path: '/tags/:id' }, { method: 'PUT', path: '/racks/:id' },
      { method: 'PUT', path: '/users/:id' },
    ] },
  };
  const out = generateReferenceData(contract);
  assert.deepEqual(out.seeded, [{ table: 'racks', rows: 3, columns: [] }]);
  assert.deepEqual(out.skipped.map((s) => s.table).sort(), ['shifts', 'tags', 'zones']);
  assert.match(out.source, /INSERT INTO racks DEFAULT VALUES;\n\s+INSERT INTO racks DEFAULT VALUES;\n\s+INSERT INTO racks DEFAULT VALUES;/);
  assert.doesNotMatch(out.source, /users/);
});

test('no tables, no endpoints, or vector tables → null / excluded', () => {
  assert.equal(generateReferenceData({}), null);
  assert.equal(generateReferenceData({ dataModel: { tables: [lines] }, apiContract: { endpoints: [] } }), null);
  const chunks = { name: 'chunks', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'embedding', type: 'VECTOR(1536) NOT NULL' }] };
  assert.deepEqual(findReferenceTables({ dataModel: { tables: [chunks] }, apiContract: { endpoints: [{ method: 'DELETE', path: '/chunks/:id' }] } }), []);
});

test('snake_case contract spelling is accepted', () => {
  const out = generateReferenceData({ data_model: realtime.dataModel, api_contract: realtime.apiContract });
  assert.equal(out.seeded[0].table, 'lines');
});
