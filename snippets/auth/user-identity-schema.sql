/**
 * SNIPPET: User-Specific Data Schema (OIDC)
 * CATEGORY: Authentication
 * LANGUAGE: SQL (PostgreSQL + MySQL variants)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Schema for storing user-specific data keyed on the OIDC `sub` claim
 *   (available as user.userId from the user-identity middleware).
 *   The `sub` is the ONLY stable identifier — it never changes across
 *   sessions. Do NOT key user data on email or name: both can change
 *   in Azure AD.
 *
 * SETUP:
 *   Copy the variant for your database into database/init/ so it runs
 *   on first deployment. For schema changes AFTER first deploy, use
 *   migrations instead (see snippets/config/db-migrations.js).
 *
 * DEPENDENCIES:
 *   PostgreSQL 13+ or MySQL 8+
 *
 * RELATED:
 *   - snippets/auth/user-identity.js (Express middleware, req.user)
 *   - snippets/auth/user-identity.py (FastAPI dependency)
 */

-- ==============================================
-- PostgreSQL variant
-- ==============================================

CREATE TABLE IF NOT EXISTS user_settings (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,   -- OIDC sub claim (user.userId) — stable across sessions
    user_email VARCHAR(255),                -- Convenience only, may change — never use as key
    user_name VARCHAR(255),                 -- Convenience only, may change
    -- your user-specific fields here
    settings JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);

-- ==============================================
-- MySQL variant
-- ==============================================
-- (Use ONE variant — delete the other when copying to database/init/)

CREATE TABLE IF NOT EXISTS user_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,   -- OIDC sub claim (user.userId) — stable across sessions
    user_email VARCHAR(255),                -- Convenience only, may change — never use as key
    user_name VARCHAR(255),                 -- Convenience only, may change
    -- your user-specific fields here
    settings JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
);
