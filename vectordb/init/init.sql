-- ============================================================================
-- VECTOR DATABASE INITIALIZATION SCRIPT
-- ============================================================================
-- This script runs automatically when the pgvector container starts for the
-- first time. For Chroma/Qdrant, use their respective APIs instead.
-- ============================================================================

-- Enable pgvector extension (required for vector operations)
CREATE EXTENSION IF NOT EXISTS vector;

-- Example: Documents table with embeddings
-- CREATE TABLE IF NOT EXISTS documents (
--     id SERIAL PRIMARY KEY,
--     content TEXT NOT NULL,
--     embedding vector(1536),  -- OpenAI embedding dimension
--     metadata JSONB,
--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- Example: Create an index for fast similarity search
-- CREATE INDEX IF NOT EXISTS documents_embedding_idx
--     ON documents USING ivfflat (embedding vector_cosine_ops)
--     WITH (lists = 100);

-- Add your tables below:


