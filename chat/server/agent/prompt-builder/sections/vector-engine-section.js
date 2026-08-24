/**
 * Build the "=== VECTOR ENGINE ===" section for vectordb + backend + integration spawns.
 * Step 7e: vectordb engine choice (pgvector / qdrant / chroma) is a cross-scope
 * coordination decision the router makes. Closes the t32 class — vectordb
 * agent mixed pgvector init scripts with qdrant Dockerfile because nothing
 * told it which engine the rest of the build expected.
 *
 * Each engine has incompatible artifacts (Dockerfile FROM, init style,
 * healthcheck, env vars, backend client). All three using-scopes read the
 * same engine value from their spawn message.
 *
 * Scope-gated: vectordb + backend + integration only (frontend + database
 * + docs are unaffected).
 */
export function buildVectorEngineSection(vectorEngine, scope) {
  if (scope !== 'vectordb' && scope !== 'backend' && scope !== 'integration') return null;
  if (!vectorEngine) return null;

  const engineGuidance = {
    pgvector: {
      vectordb: 'Use Dockerfile.pgvector. Init scripts under vectordb/init/*.sql with `CREATE EXTENSION IF NOT EXISTS vector;`. Healthcheck: `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}`. Port 5432.',
      backend:  'Use pg.Pool with vector type extension (npm: pgvector). Connect via VECTORDB_HOST=vectordb VECTORDB_PORT=5432 VECTORDB_USER/PASSWORD/NAME (separate from relational DATABASE_*). Embeddings stored as VECTOR(N) column.',
      integration: 'vectordb service: postgres-style env (POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD), pg_isready healthcheck, port 5432 internal, EFS volume mount at /data.',
    },
    qdrant: {
      vectordb: 'Use Dockerfile.qdrant. NO SQL init scripts — collections created via API at runtime by the backend or a separate init-collection.py. Healthcheck: HTTP GET /readyz on port 6333. Port 6333 (REST), 6334 (gRPC).',
      backend:  'Use @qdrant/js-client-rest (Node) or qdrant-client (Python). Connect via QDRANT_URL=http://vectordb:6333. Collection creation via REST API on first connect.',
      integration: 'vectordb service: QDRANT_URL env shared with backend, healthcheck `wget -q --spider http://localhost:6333/readyz`, port 6333 internal, volume mount at /data/qdrant. Do NOT pass POSTGRES_* env to qdrant — it will start as postgres and crash.',
    },
    chroma: {
      vectordb: 'Use Dockerfile.chroma. NO SQL init scripts — collections created via API at runtime. Healthcheck: HTTP GET /api/v1/heartbeat on port 8000. Port 8000.',
      backend:  'Use chromadb client (Python) or chromadb-default-embed (Node, via REST). Connect via CHROMA_URL=http://vectordb:8000. Collection creation via API on first connect.',
      integration: 'vectordb service: CHROMA_URL env shared with backend, HTTP healthcheck on :8000, port 8000 internal, volume mount at /data/chroma. Do NOT pass POSTGRES_* env to chroma.',
    },
  };

  const guidance = engineGuidance[vectorEngine] && engineGuidance[vectorEngine][scope];
  if (!guidance) return null;

  return (
    '=== VECTOR ENGINE ===\n' +
    `Engine: ${vectorEngine}\n\n` +
    'Engine choice from the router — vectordb + backend + integration agents read the same value, so artifacts agree mechanically. Do NOT mix engines (e.g., pgvector init scripts with qdrant Dockerfile, or qdrant healthcheck with pgvector image).\n\n' +
    `For ${scope}: ${guidance}`
  );
}
