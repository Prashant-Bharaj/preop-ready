/**
 * vector-search-helper-generator.js — emits a contract-driven pgvector
 * similarity-search helper at `backend/src/lib/vector-search.ts`.
 *
 * Emitted ONLY when the contract has `vector_engine === 'pgvector'` AND the
 * data_model contains a table with a `VECTOR(N)` column. Otherwise returns
 * null and the probe skips pre-staging this file.
 *
 * The helper encapsulates the pgvector `<=>` operator + cosine-similarity
 * conversion + threshold + limit cap. Subagents call it instead of writing
 * raw SQL — which closes the most consistent semantic drift we observed
 * in the tHARD probes (0/3 runs used `<=>` despite contract.vector_engine
 * being 'pgvector').
 */

const VECTOR_RE = /^\s*VECTOR\s*\(\s*(\d+)\s*\)\s*$/i;
const REFERENCES_RE = /REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)/i;

/**
 * Detect the chunks table + parent (document-like) table + owner column
 * from the contract's data_model.
 *
 * Returns null when the schema doesn't have a recognizable
 * "embeddings under owner-scoped parent" shape.
 */
export function detectVectorSchema(contract) {
  if (contract?.vectorEngine !== 'pgvector' && contract?.vector_engine !== 'pgvector') return null;
  const tables = contract?.dataModel?.tables || contract?.data_model?.tables || [];
  if (!Array.isArray(tables) || tables.length === 0) return null;

  // 1. Find the table with a VECTOR column.
  let chunkTable = null;
  let vectorCol = null;
  for (const t of tables) {
    for (const c of (t.columns || [])) {
      if (VECTOR_RE.test(String(c.type || ''))) {
        chunkTable = t;
        vectorCol = c.name;
        break;
      }
    }
    if (chunkTable) break;
  }
  if (!chunkTable) return null;

  // 2. Find the FK column in chunkTable that references another table.
  let parentRefCol = null;
  let parentTableName = null;
  for (const c of chunkTable.columns) {
    const m = REFERENCES_RE.exec(String(c.type || ''));
    if (m) {
      parentRefCol = c.name;
      parentTableName = m[1].toLowerCase();
      break;
    }
  }
  if (!parentRefCol || !parentTableName) return null;

  // 3. Find the parent table (case-insensitive name match).
  const parentTable = tables.find(t => String(t.name).toLowerCase() === parentTableName);
  if (!parentTable) return null;

  // 4. Find the owner column in the parent table (owner_id / user_id / created_by).
  const OWNER_CANDIDATES = ['owner_id', 'user_id', 'created_by'];
  const ownerCol = parentTable.columns.find(c => OWNER_CANDIDATES.includes(String(c.name).toLowerCase()));
  if (!ownerCol) return null;

  // 5. Find a "text" column in chunkTable so the helper can return it.
  const TEXT_CANDIDATES = ['text', 'content', 'body', 'chunk_text'];
  const textCol = chunkTable.columns.find(c => TEXT_CANDIDATES.includes(String(c.name).toLowerCase()));

  // 6. Find the per-chunk metadata column (section/heading for citations).
  const META_CANDIDATES = ['metadata', 'meta'];
  const metaCol = chunkTable.columns.find(c => META_CANDIDATES.includes(String(c.name).toLowerCase()));

  return {
    chunkTable: chunkTable.name,
    vectorCol,
    parentRefCol,
    parentTable: parentTable.name,
    ownerCol: ownerCol.name,
    textCol: textCol ? textCol.name : null,
    metaCol: metaCol ? metaCol.name : null,
  };
}

/**
 * Emit the helper source. Returns { source, schema } or null when the
 * contract doesn't have the required shape.
 */
export function generateVectorSearchHelper(contract) {
  const schema = detectVectorSchema(contract);
  if (!schema) return null;

  const { chunkTable, vectorCol, parentRefCol, parentTable, ownerCol, textCol, metaCol } = schema;
  const textSelect = textCol ? `c.${textCol} AS text` : `'' AS text`;
  const metaSelect = metaCol ? `c.${metaCol} AS metadata` : `NULL AS metadata`;

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — emitted from data_model + vector_engine='pgvector'`);
  lines.push(`// Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Cosine-similarity search over \`${chunkTable}.${vectorCol}\` (pgvector \`<=>\` operator),`);
  lines.push(` * scoped to a single owner via the \`${parentTable}.${ownerCol}\` join.`);
  lines.push(` *`);
  lines.push(` * Call this from your /search handler. Do NOT reinvent the SQL — pgvector's`);
  lines.push(` * \`<=>\` operator is what makes the HNSW index usable; computing cosine in JS`);
  lines.push(` * bypasses the index and degrades performance by orders of magnitude.`);
  lines.push(` */`);
  lines.push(`import type { Pool } from 'pg';`);
  lines.push('');
  lines.push(`export interface RankedChunk {`);
  lines.push(`  chunk_id: number;`);
  lines.push(`  ${parentRefCol}: number;`);
  lines.push(`  text: string;`);
  lines.push(`  metadata: Record<string, unknown> | null;  // ${metaCol ? `${chunkTable}.${metaCol}` : 'no metadata column declared'} — section/heading for citations (e.g. metadata.section)`);
  lines.push(`  score: number;   // cosine similarity in [0, 1]`);
  lines.push(`  rank: number;    // 1-based, by score DESC`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export interface FindSimilarChunksOpts {`);
  lines.push(`  pool: Pool;`);
  lines.push(`  queryVector: number[];   // 1536-dim embedding`);
  lines.push(`  ownerId: number;         // scope to this owner's documents`);
  lines.push(`  limit: number;           // capped at 100 internally`);
  lines.push(`  threshold: number;       // score >= threshold passes`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export async function findSimilarChunks(opts: FindSimilarChunksOpts): Promise<RankedChunk[]> {`);
  lines.push(`  const limitCapped = Math.min(Math.max(1, opts.limit | 0), 100);`);
  lines.push(`  const vecParam = '[' + opts.queryVector.join(',') + ']';`);
  lines.push(`  const res = await opts.pool.query<{`);
  lines.push(`    chunk_id: number; ${parentRefCol}: number; text: string; metadata: Record<string, unknown> | null; score: number;`);
  lines.push(`  }>(`);
  lines.push(`    \`SELECT c.id AS chunk_id,`);
  lines.push(`            c.${parentRefCol} AS ${parentRefCol},`);
  lines.push(`            ${textSelect},`);
  lines.push(`            ${metaSelect},`);
  lines.push(`            1 - (c.${vectorCol} <=> $1::vector) AS score`);
  lines.push(`       FROM ${chunkTable} c`);
  lines.push(`       INNER JOIN ${parentTable} p ON p.id = c.${parentRefCol}`);
  lines.push(`      WHERE p.${ownerCol} = $2`);
  lines.push(`        AND 1 - (c.${vectorCol} <=> $1::vector) >= $3`);
  lines.push(`      ORDER BY c.${vectorCol} <=> $1::vector`);
  lines.push(`      LIMIT $4\`,`);
  lines.push(`    [vecParam, opts.ownerId, opts.threshold, limitCapped]`);
  lines.push(`  );`);
  lines.push(`  return res.rows.map((row, i) => ({`);
  lines.push(`    chunk_id: row.chunk_id,`);
  lines.push(`    ${parentRefCol}: row.${parentRefCol},`);
  lines.push(`    text: row.text,`);
  lines.push(`    metadata: row.metadata ?? null,`);
  lines.push(`    score: row.score,`);
  lines.push(`    rank: i + 1,`);
  lines.push(`  }));`);
  lines.push(`}`);
  lines.push('');

  return { source: lines.join('\n'), schema };
}
