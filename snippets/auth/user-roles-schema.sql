/**
 * SNIPPET: User Roles & Audit Log Schema (PostgreSQL)
 * CATEGORY: Authentication
 * LANGUAGE: SQL (PostgreSQL)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Database schema for role-based access control with audit logging.
 *   Roles: user (default), expert, admin.
 *   Account statuses: pending (default), approved, denied.
 *
 *   New users start as role='user' and account_status='pending'.
 *   An admin must approve them before they can access the app.
 *   Admin emails bootstrapped via INITIAL_ADMIN_EMAILS env var
 *   are auto-approved on first login (see user-roles.js).
 *
 * SETUP:
 *   Copy this file to your database/init/ folder so it runs
 *   on container startup (e.g., PostgreSQL's docker-entrypoint-initdb.d).
 *
 * DEPENDENCIES:
 *   PostgreSQL 13+
 *
 * RELATED:
 *   - snippets/auth/user-roles.js (backend logic)
 *   - snippets/auth/UserManagement.jsx (admin UI)
 */

-- ==============================================
-- Users table with role-based access control
-- ==============================================
-- Roles: user | expert | admin
-- Account statuses: pending | approved | denied

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    oidc_user_id VARCHAR(255) NOT NULL UNIQUE,
    email VARCHAR(255),
    name VARCHAR(255),
    department VARCHAR(255),
    role VARCHAR(50) DEFAULT 'user',
    account_status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- ==============================================
-- Audit log for tracking admin actions
-- ==============================================

CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id VARCHAR(255),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
