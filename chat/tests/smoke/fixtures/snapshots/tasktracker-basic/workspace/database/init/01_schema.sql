-- AUTO-GENERATED — DO NOT EDIT — emitted from data_model + vector_engine
-- Generated 2026-05-25T18:05:13.361Z
-- Tables: users, tasks

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  oidc_sub TEXT UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  title VARCHAR(255) NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_created_at_desc_idx ON users (created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks (user_id);
CREATE INDEX IF NOT EXISTS tasks_created_at_desc_idx ON tasks (created_at DESC);