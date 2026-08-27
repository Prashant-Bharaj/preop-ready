/**
 * scopes: [backend, vectordb]
 * flags: [ai-rag]
 * description: pgvector connection pattern (TypeScript) for RAG.
 */

/**
 * Vector Database Connection (pgvector, TypeScript)
 *
 * Connection pattern for pgvector — the canonical vector engine.
 * Uses VECTORDB_* environment variables auto-injected by the platform.
 *
 * IMPORTANT: pgvector requires per-Client type registration.
 *
 * The `pgvector` npm package's `registerType(client)` function MUST be called
 * on a `pg.Client` instance (not a `pg.Pool`). Pool objects don't expose
 * `client.setTypeParser` — calling `registerType(pool)` crashes at module
 * load with `TypeError: client.setTypeParser is not a function` and the
 * backend container exits with code 1, failing compose-up entirely.
 *
 * The correct pattern: register on every new connection via the `connect`
 * event handler. The pool will register types on every client it opens —
 * including reconnects after idle timeout.
 */

import { Pool, type PoolConfig, type PoolClient } from 'pg';
import pgvector from 'pgvector/pg';

// ── pgvector (PostgreSQL with vector extension) ──
const vectorConfig: PoolConfig = {
  host: process.env.VECTORDB_HOST || 'vectordb',
  port: parseInt(process.env.VECTORDB_PORT || '5432', 10),
  database: process.env.VECTORDB_NAME || 'vectors',
  user: process.env.VECTORDB_USER || 'vectordb_user',
  password: process.env.VECTORDB_PASSWORD || 'localdev123',
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
};

export const vectorPool: Pool = new Pool(vectorConfig);

// Register pgvector types on every new client the pool opens. This is the
// only correct pattern with a Pool — see comment block above.
vectorPool.on('connect', async (client: PoolClient) => {
  await pgvector.registerType(client);
});

vectorPool.on('error', (err: Error) => {
  console.error('Unexpected error on idle vector client', err);
  process.exit(-1);
});

/**
 * Example query: cosine similarity search.
 *
 * NOTE on dimensions and column type — for embeddings > 2000 dims (e.g.
 * text-embedding-3-large = 3072), the vectordb scope writes a HALFVEC column
 * with halfvec_*_ops indexing (pgvector HNSW caps at 2000 dims for VECTOR,
 * 4000 for HALFVEC). The cast in your query MUST match the column type:
 *
 *   - VECTOR(<=2000) columns:  cast as $1::vector
 *   - HALFVEC(<=4000) columns: cast as $1::halfvec
 *
 * Inspect the vectordb scope's init.sql to confirm which type is in use.
 */
export async function similaritySearch(
  embedding: number[],
  k: number,
  table: string = 'doc_chunks',
): Promise<Array<{ id: number; document_id: number; chunk_index: number; content: string; distance: number }>> {
  const vec = `[${embedding.join(',')}]`;
  const result = await vectorPool.query(
    `SELECT id, document_id, chunk_index, content, embedding <=> $1::vector AS distance
     FROM ${table}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vec, k],
  );
  return result.rows;
}

export default { vectorPool, similaritySearch };
