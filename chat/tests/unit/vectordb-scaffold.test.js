// vectordb-scaffold.test.js — deterministic vectordb scope scaffold.
//
// Pins the invariant that killed the live SOP-assistant build: the chunk
// table name must come from ONE source. The init.sql and the backend
// vector-search helper are both generated from resolveVectorTables(), so
// `doc_chunks` vs `documents` drift is impossible by construction. Also
// pins the two-instance schema split: VECTOR tables never land in the
// relational database init when a vectordb service exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_CHUNKS_TABLE,
  resolveVectorTables,
  generateVectordbInit,
  describeChunkTable,
  generateVectordbSearchHelper,
  synthesizeVectordbReport,
} from '../../server/agent/coordinator/vectordb-scaffold-generator.js';
import { generateSchema } from '../../server/agent/coordinator/schema-generator.js';

const relationalTables = [
  { name: 'users', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'role', type: 'VARCHAR(50)' }] },
  { name: 'sops', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'review_date', type: 'DATE NOT NULL' }, { name: 'created_at', type: 'TIMESTAMPTZ DEFAULT NOW()' }] },
];

const declaredChunks = {
  name: 'sop_chunks',
  columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'sop_id', type: 'INTEGER NOT NULL' },
    { name: 'chunk_text', type: 'TEXT NOT NULL' },
    { name: 'embedding', type: 'VECTOR(1536)' },
  ],
};

test('resolveVectorTables: falls back to canonical doc_chunks when contract declares none', () => {
  const { tables, canonical } = resolveVectorTables({ dataModel: { tables: relationalTables } });
  assert.equal(canonical, true);
  assert.equal(tables[0].name, 'doc_chunks');
  assert.equal(tables[0], CANONICAL_CHUNKS_TABLE);
});

test('resolveVectorTables: uses declared VECTOR tables when present', () => {
  const { tables, canonical } = resolveVectorTables({
    dataModel: { tables: [...relationalTables, declaredChunks] },
  });
  assert.equal(canonical, false);
  assert.deepEqual(tables.map((t) => t.name), ['sop_chunks']);
});

test('generateVectordbInit: pgvector → extension + table + hnsw index; else null', () => {
  const init = generateVectordbInit({ vectorEngine: 'pgvector', dataModel: { tables: relationalTables } });
  assert.ok(init.source.includes('CREATE EXTENSION IF NOT EXISTS vector;'));
  assert.ok(init.source.includes('CREATE TABLE IF NOT EXISTS doc_chunks'));
  assert.ok(init.source.includes('USING hnsw (embedding vector_cosine_ops)'));
  assert.equal(init.canonical, true);
  assert.deepEqual(init.tableNames, ['doc_chunks']);

  assert.equal(generateVectordbInit({ vectorEngine: null, dataModel: { tables: relationalTables } }), null);
});

test('describeChunkTable: canonical shape resolves working columns (incl. metadata)', () => {
  const d = describeChunkTable(CANONICAL_CHUNKS_TABLE);
  assert.deepEqual(d, { chunkTable: 'doc_chunks', vectorCol: 'embedding', textCol: 'content', refCol: 'source_id', metaCol: 'metadata' });
});

test('helper and init are generated from the SAME table name (the drift-killer)', () => {
  for (const contract of [
    { vectorEngine: 'pgvector', dataModel: { tables: relationalTables } },
    { vectorEngine: 'pgvector', dataModel: { tables: [...relationalTables, declaredChunks] } },
  ]) {
    const init = generateVectordbInit(contract);
    const helper = generateVectordbSearchHelper(contract);
    const tableName = init.tableNames[0];
    assert.ok(helper.source.includes(`export const CHUNK_TABLE = '${tableName}';`));
    assert.ok(helper.source.includes(`FROM ${tableName} c`));
    assert.ok(init.source.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`));
  }
});

test('helper: two-instance shape — no parent join, optional sourceIds filter, <=> operator', () => {
  const helper = generateVectordbSearchHelper({ vectorEngine: 'pgvector', dataModel: { tables: relationalTables } });
  assert.ok(!helper.source.includes('INNER JOIN'));
  assert.ok(helper.source.includes('sourceIds?: number[]'));
  assert.ok(helper.source.includes('<=>'));
  assert.ok(helper.source.includes('findSimilarChunks'));
});

test('helper: threads the chunk metadata column into RankedChunk (section citations)', () => {
  // Canonical table HAS a metadata column → selected and returned verbatim.
  const canonical = generateVectordbSearchHelper({ vectorEngine: 'pgvector', dataModel: { tables: relationalTables } });
  assert.ok(canonical.source.includes('metadata: Record<string, unknown> | null;'));
  assert.ok(canonical.source.includes('c.metadata AS metadata'));
  assert.ok(canonical.source.includes('metadata: row.metadata ?? null,'));

  // Declared chunk table WITHOUT a metadata column → stable shape, NULL source.
  const noMeta = generateVectordbSearchHelper({ vectorEngine: 'pgvector', dataModel: { tables: [...relationalTables, declaredChunks] } });
  assert.ok(noMeta.source.includes('metadata: Record<string, unknown> | null;'));
  assert.ok(noMeta.source.includes('NULL AS metadata'));
  assert.ok(!noMeta.source.includes('c.metadata AS metadata'));
  assert.ok(noMeta.source.includes('metadata: row.metadata ?? null,'));
});

test('describeChunkTable: declared table without a metadata column → metaCol null', () => {
  assert.equal(describeChunkTable(declaredChunks).metaCol, null);
});

test('schema split: VECTOR tables excluded from database init when vectordb scope exists', () => {
  const contract = {
    vectorEngine: 'pgvector',
    dataModel: { tables: [...relationalTables, declaredChunks] },
    tasks: [{ scope: 'database' }, { scope: 'vectordb' }, { scope: 'backend' }],
  };
  const schema = generateSchema(contract);
  assert.deepEqual(schema.tableNames.sort(), ['sops', 'users']);
  assert.ok(!schema.source.includes('sop_chunks'));
  assert.ok(!schema.source.includes('CREATE EXTENSION'));
});

test('schema split: without a vectordb scope the single-instance behavior is unchanged', () => {
  const contract = {
    vectorEngine: 'pgvector',
    dataModel: { tables: [...relationalTables, declaredChunks] },
    tasks: [{ scope: 'database' }, { scope: 'backend' }],
  };
  const schema = generateSchema(contract);
  assert.ok(schema.tableNames.includes('sop_chunks'));
  assert.ok(schema.source.includes('CREATE EXTENSION IF NOT EXISTS vector;'));
});

test('schema split: all-vector data_model with vectordb scope → database init is null', () => {
  const contract = {
    vectorEngine: 'pgvector',
    dataModel: { tables: [declaredChunks] },
    tasks: [{ scope: 'vectordb' }],
  };
  assert.equal(generateSchema(contract), null);
});

test('synthesizeVectordbReport: names the table and mandates the helper', () => {
  const report = synthesizeVectordbReport({ vectorEngine: 'pgvector', dataModel: { tables: relationalTables } });
  assert.ok(report.includes('**Scope:** vectordb'));
  assert.ok(report.includes('doc_chunks'));
  assert.ok(report.includes('vector-search.ts'));
  assert.ok(report.includes('VECTORDB_'));
});

// ── Frontend kit staging ──────────────────────────────────────────────────

import { stageFrontendKit, KIT_CATALOG } from '../../server/agent/coordinator/frontend-kit-generator.js';
import { mkdtempSync as mkdtempK } from 'node:fs';
import { tmpdir as tmpdirK } from 'node:os';
import { existsSync as existsK, readFileSync as readK } from 'node:fs';
import pathK from 'node:path';

test('frontend kit: stages all files into generated/kit with a barrel and tokens', () => {
  const ws = mkdtempK(pathK.join(tmpdirK(), 'kit-stage-'));
  const staged = stageFrontendKit(ws);
  assert.ok(Array.isArray(staged) && staged.length >= 13, `expected >=13 files, got ${staged?.length}`);
  assert.ok(existsK(pathK.join(ws, 'frontend/src/generated/kit/index.ts')));
  assert.ok(existsK(pathK.join(ws, 'frontend/src/generated/kit/tokens.css')));
  const barrel = readK(pathK.join(ws, 'frontend/src/generated/kit/index.ts'), 'utf-8');
  for (const name of ['Button', 'AppShell', 'DataTable', 'ConfirmDialog', 'useToast', 'EmptyState', 'MarkdownText', 'FileDropzone', 'FormField']) {
    assert.ok(barrel.includes(name), `barrel missing ${name}`);
  }
  assert.ok(barrel.includes("import './tokens.css'"));
});

test('frontend kit: catalog names every barrel export family and the composition rules', () => {
  for (const marker of ['=== UI KIT', 'AppShell', 'DataTable', 'ConfirmDialog', 'MarkdownText', 'Do NOT create your own components/ui/']) {
    assert.ok(KIT_CATALOG.includes(marker), `catalog missing: ${marker}`);
  }
});
