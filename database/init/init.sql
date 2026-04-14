-- ============================================================================
-- DATABASE INITIALIZATION SCRIPT
-- ============================================================================
-- This script runs automatically when the database container starts for the
-- first time. Add your schema definitions here.
--
-- Works with: PostgreSQL, pgvector, MySQL
-- For vector databases (Chroma, Qdrant): Use their respective APIs instead
-- ============================================================================

-- Example: Users table (PostgreSQL syntax)
-- CREATE TABLE IF NOT EXISTS users (
--     id SERIAL PRIMARY KEY,
--     email VARCHAR(255) NOT NULL UNIQUE,
--     name VARCHAR(255) NOT NULL,
--     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- Example: Enable pgvector extension (for Dockerfile.pgvector)
-- CREATE EXTENSION IF NOT EXISTS vector;
--
-- CREATE TABLE IF NOT EXISTS documents (
--     id SERIAL PRIMARY KEY,
--     content TEXT,
--     embedding vector(1536)  -- OpenAI embedding dimension
-- );

-- Add your tables below:


