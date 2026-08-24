-- Tasks database schema
-- PostgreSQL 16
-- Init script runs on first deployment only (empty database)

CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for sorting by creation time (most recent first)
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);