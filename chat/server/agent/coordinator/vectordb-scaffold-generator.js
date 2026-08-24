/**
 * vectordb-scaffold-generator.js — deterministic scaffold for the vectordb
 * scope (pgvector service) + the matching backend search helper.
 *
 * Why: the vector schema is the seam between two scopes that previously each
 * invented their own table name (observed live: vectordb init created
 * `documents`, backend queried `doc_chunks` → 42P01 on the core RAG
 * endpoint, unfixable by the probe loop because init.sql doesn't re-run on a
 * populated volume). The seam is fully known ahead of time, so — like the
 * database scope — nothing here needs an LLM:
 *
 *   - vectordb/Dockerfile        already pre-staged from Dockerfile.pgvector
 *   - vectordb/init/01_init.sql  emitted here from the contract (or the
 *                                canonical chunks table when the contract
 *                                doesn't declare one)
 *   - backend/src/lib/vector-search.ts  emitted here from the SAME schema,
 *                                so backend and vectordb cannot drift
 *
 * With all three staged, the vectordb subagent dispatch is skipped entirely
 * (mirrors databaseHandled) — which also removes the vectordb agent's
 * no-tool-call stall failure mode.
 *
 * Two-instance model: chunks live in the VECTORDB Postgres, relational rows
 * in the DATABASE Postgres. Cross-database joins are impossible, so the
 * helper filters by the chunk table's source-reference column instead of
 * joining a parent table (unlike vector-search-helper-generator.js, which
 * targets the single-instance shape and requires a same-DB REFERENCES).
 */

import { generateSchema } from './schema-generator.js';

const VECTOR_RE = /^\s*VECTOR\s*\(\s*(\d+)\s*\)/i;

// Canonical chunks table, used when the contract declares no VECTOR(N)
// table. 1536 dims = the MGA embedding model (same constant the pre-staged
// embed.ts helper produces).
export const CANONICAL_CHUNKS_TABLE = {
  name: 'doc_chunks',
  columns: [
    { name: 'id', type: 'SERIAL PRIMARY KEY' },
    { name: 'source_id', type: 'INTEGER NOT NULL' },
    { name: 'chunk_index', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'content', type: 'TEXT NOT NULL' },
    { name: 'embedding', type: 'VECTOR(1536)' },
    { name: 'metadata', type: "JSONB DEFAULT '{}'" },
    { name: 'created_at', type: 'TIMESTAMPTZ DEFAULT NOW()' },
  ],
};

function hasVectorColumn(table) {
  return (table?.columns || []).some((c) => VECTOR_RE.test(String(c.type || '')));
}

/**
 * The tables that belong in the vectordb instance: every data_model table
 * with a VECTOR(N) column, or the canonical chunks table when none is
 * declared. Returns { tables, canonical }.
 */
export function resolveVectorTables(contract) {
  const declared = (contract?.dataModel?.tables || contract?.data_model?.tables || [])
    .filter(hasVectorColumn);
  if (declared.length > 0) return { tables: declared, canonical: false };
  return { tables: [CANONICAL_CHUNKS_TABLE], canonical: true };
}

/**
 * Emit `vectordb/init/01_init.sql`. Only applies when the contract's
 * vector_engine is pgvector; returns null otherwise.
 */
export function generateVectordbInit(contract) {
  const vectorEngine = contract?.vectorEngine || contract?.vector_engine || null;
  if (vectorEngine !== 'pgvector') return null;
  const { tables, canonical } = resolveVectorTables(contract);
  const schema = generateSchema({ dataModel: { tables }, vectorEngine: 'pgvector' });
  if (!schema) return null;
  return { source: schema.source, tableNames: schema.tableNames, canonical };
}

/**
 * Locate the working columns of a chunk table: the vector column, a text
 * column, and the source-reference column (REFERENCES <t>(id) or *_id).
 */
export function describeChunkTable(table) {
  const cols = table?.columns || [];
  const vectorCol = cols.find((c) => VECTOR_RE.test(String(c.type || '')));
  if (!vectorCol) return null;
  const TEXT_CANDIDATES = ['text', 'content', 'body', 'chunk_text'];
  const textCol = cols.find((c) => TEXT_CANDIDATES.includes(String(c.name).toLowerCase()));
  const refCol = cols.find((c) => /REFERENCES/i.test(String(c.type || '')))
    || cols.find((c) => /_id$/i.test(String(c.name)) && !/PRIMARY\s+KEY/i.test(String(c.type || '')));
  // The section/heading captured per chunk at ingest lives here; retrieval
  // must return it so citations can name the real section (not "General").
  const META_CANDIDATES = ['metadata', 'meta'];
  const metaCol = cols.find((c) => META_CANDIDATES.includes(String(c.name).toLowerCase()));
  return {
    chunkTable: table.name,
    vectorCol: vectorCol.name,
    textCol: textCol ? textCol.name : null,
    refCol: refCol ? refCol.name : null,
    metaCol: metaCol ? metaCol.name : null,
  };
}

/**
 * Emit the two-instance `backend/src/lib/vector-search.ts` from the SAME
 * schema the vectordb init was generated from. Returns { source, schema }
 * or null when not a pgvector app.
 */
export function generateVectordbSearchHelper(contract) {
  const vectorEngine = contract?.vectorEngine || contract?.vector_engine || null;
  if (vectorEngine !== 'pgvector') return null;
  const { tables } = resolveVectorTables(contract);
  const schema = describeChunkTable(tables[0]);
  if (!schema) return null;

  const { chunkTable, vectorCol, textCol, refCol, metaCol } = schema;
  const textSelect = textCol ? `c.${textCol} AS text` : `'' AS text`;
  const refSelect = refCol ? `c.${refCol} AS source_ref,` : `NULL AS source_ref,`;
  const metaSelect = metaCol ? `c.${metaCol} AS metadata` : `NULL AS metadata`;

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — emitted from the same schema as vectordb/init/01_init.sql`);
  lines.push(`// The chunk table in the vector database is \`${chunkTable}\`; this helper is the`);
  lines.push(`// ONLY supported way to query it. Do not hand-write pgvector SQL elsewhere —`);
  lines.push(`// the \`<=>\` operator below is what makes the HNSW index usable.`);
  lines.push('');
  lines.push(`import type { Pool } from 'pg';`);
  lines.push('');
  lines.push(`export const CHUNK_TABLE = '${chunkTable}';`);
  lines.push('');
  lines.push(`export interface RankedChunk {`);
  lines.push(`  chunk_id: number;`);
  lines.push(`  source_ref: number | null;  // ${refCol ? `${chunkTable}.${refCol}` : 'no source column declared'}`);
  lines.push(`  text: string;`);
  lines.push(`  metadata: Record<string, unknown> | null;  // ${metaCol ? `${chunkTable}.${metaCol}` : 'no metadata column declared'} — section/heading for citations (e.g. metadata.section)`);
  lines.push(`  score: number;   // cosine similarity in [0, 1]`);
  lines.push(`  rank: number;    // 1-based, by score DESC`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export interface FindSimilarChunksOpts {`);
  lines.push(`  pool: Pool;              // the VECTORDB pool (VECTORDB_* env), not the main DB`);
  lines.push(`  queryVector: number[];   // 1536-dim embedding from lib/embed`);
  lines.push(`  limit: number;           // capped at 100 internally`);
  lines.push(`  threshold?: number;      // score >= threshold passes (default 0)`);
  if (refCol) lines.push(`  sourceIds?: number[];    // optional filter on ${refCol}`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export async function findSimilarChunks(opts: FindSimilarChunksOpts): Promise<RankedChunk[]> {`);
  lines.push(`  const limitCapped = Math.min(Math.max(1, opts.limit | 0), 100);`);
  lines.push(`  const threshold = opts.threshold ?? 0;`);
  lines.push(`  const vecParam = '[' + opts.queryVector.join(',') + ']';`);
  lines.push(`  const params: unknown[] = [vecParam, threshold, limitCapped];`);
  if (refCol) {
    lines.push(`  let sourceFilter = '';`);
    lines.push(`  if (opts.sourceIds && opts.sourceIds.length > 0) {`);
    lines.push(`    params.push(opts.sourceIds);`);
    lines.push(`    sourceFilter = \`AND c.${refCol} = ANY($\${params.length}::int[])\`;`);
    lines.push(`  }`);
  } else {
    lines.push(`  const sourceFilter = '';`);
  }
  lines.push(`  const res = await opts.pool.query(`);
  lines.push(`    \`SELECT c.id AS chunk_id,`);
  lines.push(`            ${refSelect}`);
  lines.push(`            ${textSelect},`);
  lines.push(`            ${metaSelect},`);
  lines.push(`            1 - (c.${vectorCol} <=> $1::vector) AS score`);
  lines.push(`       FROM ${chunkTable} c`);
  lines.push(`      WHERE 1 - (c.${vectorCol} <=> $1::vector) >= $2`);
  lines.push(`        \${sourceFilter}`);
  lines.push(`      ORDER BY c.${vectorCol} <=> $1::vector`);
  lines.push(`      LIMIT $3\``);
  lines.push(`    , params`);
  lines.push(`  );`);
  lines.push(`  return res.rows.map((row: any, i: number) => ({`);
  lines.push(`    chunk_id: row.chunk_id,`);
  lines.push(`    source_ref: row.source_ref,`);
  lines.push(`    text: row.text,`);
  lines.push(`    metadata: row.metadata ?? null,`);
  lines.push(`    score: Number(row.score),`);
  lines.push(`    rank: i + 1,`);
  lines.push(`  }));`);
  lines.push(`}`);
  lines.push('');
  return { source: lines.join('\n'), schema };
}

/**
 * Synthesized PHASE AGENT REPORT for the skipped vectordb dispatch, so
 * sibling subagents see the staged schema under CROSS-SCOPE COORDINATION.
 */
export function synthesizeVectordbReport(contract) {
  const init = generateVectordbInit(contract);
  if (!init) return null;
  const { tables } = resolveVectorTables(contract);
  const tableLines = tables.map((t) =>
    `- ${t.name}(${(t.columns || []).map((c) => c.name).join(', ')})`);
  return [
    '--- PHASE AGENT REPORT ---',
    '**Scope:** vectordb',
    '**Status:** complete (deterministically scaffolded — no LLM dispatch)',
    '**Files written:**',
    '- vectordb/Dockerfile (pgvector base image)',
    '- vectordb/init/01_init.sql',
    '**Tables (in the VECTOR database, reachable via VECTORDB_* env):**',
    ...tableLines,
    '**Notes for siblings:**',
    `- Backend MUST query chunks through the pre-staged \`backend/src/lib/vector-search.ts\` (CHUNK_TABLE = '${init.tableNames[0]}'). Do not hand-write pgvector SQL or invent table names.`,
    '- Integration wires the vectordb service with the VECTORDB_* environment variables.',
    '--- END REPORT ---',
  ].join('\n');
}
