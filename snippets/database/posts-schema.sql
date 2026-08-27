-- scopes: [database]
-- flags: [long-form-content]
-- description: Schema for blog/wiki/docs posts with draft-publish + author + edit history.

-- Long-form content schema: posts with draft/published states, author
-- ownership, and append-only edit history. Designed to be merged with the
-- planner's data_model — adapt column names to match what the planner
-- emitted, but the structural choices (separate revisions table, status
-- enum, RLS-friendly user_id) are platform conventions.

-- Posts: the canonical content record. `status` separates drafts (work in
-- progress, only the author + admins see) from published (everyone sees).
CREATE TABLE IF NOT EXISTS posts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         VARCHAR(200) NOT NULL,
  slug          VARCHAR(200) NOT NULL,
  body          TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','published','archived')),
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS posts_user_status_idx
  ON posts (user_id, status, created_at DESC);

-- Public-list index: lets a "/posts" feed endpoint efficiently fetch
-- the most recent published posts across all authors.
CREATE INDEX IF NOT EXISTS posts_published_recent_idx
  ON posts (published_at DESC)
  WHERE status = 'published';

-- Edit history: append-only row per save. Lets you show a "version 5 of 8"
-- selector in the UI and recover from accidental overwrites. Keeping
-- revisions in a separate table avoids bloating the hot-path posts table.
CREATE TABLE IF NOT EXISTS post_revisions (
  id          SERIAL PRIMARY KEY,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       VARCHAR(200) NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS post_revisions_post_idx
  ON post_revisions (post_id, created_at DESC);

-- Trigger: every UPDATE to posts.body or posts.title appends a revision row.
-- Idempotent (CREATE OR REPLACE), safe for repeated init runs.
CREATE OR REPLACE FUNCTION posts_record_revision() RETURNS trigger AS $$
BEGIN
  IF (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title) THEN
    INSERT INTO post_revisions (post_id, user_id, title, body)
    VALUES (OLD.id, OLD.user_id, OLD.title, OLD.body);
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS posts_revision_trigger ON posts;
CREATE TRIGGER posts_revision_trigger
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_record_revision();
