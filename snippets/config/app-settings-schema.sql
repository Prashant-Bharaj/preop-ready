/**
 * SNIPPET: App Settings Schema (PostgreSQL)
 * CATEGORY: Configuration
 * LANGUAGE: SQL (PostgreSQL)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Simple key-value settings table for runtime configuration without redeployment.
 *   Intended for use with an admin settings page. Values can be read by backend
 *   code (see app-settings.js) with DB-first, env-var fallback, default-value pattern.
 *
 *   Use cases:
 *     - Swap an LLM assistant ID without redeploying
 *     - Toggle feature flags at runtime
 *     - Store admin-configurable thresholds, messages, etc.
 *
 * SETUP:
 *   Copy this file to your database/init/ folder so it runs
 *   on container startup (e.g., PostgreSQL's docker-entrypoint-initdb.d).
 *
 * DEPENDENCIES:
 *   PostgreSQL 13+
 *
 * RELATED:
 *   - snippets/config/app-settings.js (backend logic + Express router)
 */

-- ==============================================
-- Runtime application settings (key-value store)
-- ==============================================
-- Allows admins to change configuration at runtime without redeployment.
-- Read by backend via getConfig() which checks DB first, then env vars, then defaults.

CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================
-- Example settings
-- ==============================================

INSERT INTO app_settings (key, value, description, updated_by) VALUES
    ('mga_assistant_id', 'asst_your_id_here', 'MGA Assistant ID for the AI chat feature', 'system'),
    ('max_upload_size_mb', '10', 'Maximum file upload size in megabytes', 'system'),
    ('maintenance_mode', 'false', 'When true, show maintenance page to non-admin users', 'system'),
    ('welcome_message', 'Welcome to the application!', 'Message shown on the dashboard', 'system')
ON CONFLICT (key) DO NOTHING;
