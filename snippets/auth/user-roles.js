/**
 * SNIPPET: User Roles & Access Control (Express + PostgreSQL)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (Express)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Role-based access control with admin approval workflow.
 *   Provides session creation (upsert on login), middleware for
 *   role/status checks, audit logging, and an Express router
 *   for user management endpoints.
 *
 *   Roles: user, expert, admin
 *   Account statuses: pending, approved, denied
 *
 *   Bootstrap admins are auto-approved on first login via the
 *   INITIAL_ADMIN_EMAILS (or SECRET_3) environment variable.
 *
 * DEPENDENCIES:
 *   npm install pg
 *
 * ENV:
 *   SECRET_3 or INITIAL_ADMIN_EMAILS — comma-separated list of
 *   bootstrap admin email addresses (auto-approved + admin role)
 *
 * USAGE:
 *   const { createUserRouter, requireApproved, requireRole } = require('./user-roles');
 *
 *   // Attach after userIdentityMiddleware (see user-identity.js)
 *   app.use('/auth', createUserRouter(pool));
 *
 *   // Protect routes
 *   app.use('/api', requireApproved(pool));
 *   app.get('/api/admin/stats', requireRole(pool, 'admin'), handler);
 *
 * RELATED:
 *   - snippets/auth/user-roles-schema.sql (database schema)
 *   - snippets/auth/UserManagement.jsx (admin UI)
 *   - snippets/auth/user-identity.js (OIDC identity extraction)
 */

const express = require('express');

// ============================================
// Constants
// ============================================

const VALID_ROLES = ['user', 'expert', 'admin'];
const VALID_STATUSES = ['pending', 'approved', 'denied'];

/**
 * Comma-separated list of bootstrap admin emails.
 * These users are auto-approved with admin role on first login.
 */
const ADMIN_EMAILS = (process.env.SECRET_3 || process.env.INITIAL_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

// ============================================
// Core Functions
// ============================================

/**
 * Create or update a user session on login.
 * If the user's email is in ADMIN_EMAILS, they are auto-approved as admin.
 * Uses INSERT...ON CONFLICT (upsert) with RETURNING for atomicity.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @param {Object} req - Express request (must have req.user from OIDC middleware)
 * @returns {Promise<Object>} The user record from the database
 */
async function createSession(pool, req) {
  const { userId, email, name } = req.user;
  const isBootstrapAdmin = email && ADMIN_EMAILS.includes(email.toLowerCase());

  const role = isBootstrapAdmin ? 'admin' : 'user';
  const status = isBootstrapAdmin ? 'approved' : 'pending';

  const result = await pool.query(
    `INSERT INTO users (oidc_user_id, email, name, role, account_status, last_login)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (oidc_user_id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       name = COALESCE(EXCLUDED.name, users.name),
       last_login = NOW()
     RETURNING *`,
    [userId, email, name, role, status]
  );

  return result.rows[0];
}

/**
 * Express middleware that requires the user's account to be approved.
 * Returns 403 if the account is pending or denied.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @returns {Function} Express middleware
 */
function requireApproved(pool) {
  return async (req, res, next) => {
    try {
      const result = await pool.query(
        'SELECT account_status FROM users WHERE oidc_user_id = $1',
        [req.user.userId]
      );

      if (!result.rows.length) {
        return res.status(403).json({ error: 'User not found. Please log in first.' });
      }

      if (result.rows[0].account_status !== 'approved') {
        return res.status(403).json({
          error: 'Account not approved',
          status: result.rows[0].account_status
        });
      }

      next();
    } catch (err) {
      console.error('requireApproved error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * Express middleware factory that checks the user's role against allowed roles.
 * Must be used after requireApproved() to ensure the user exists.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @param {...string} roles - Allowed roles (e.g., 'admin', 'expert')
 * @returns {Function} Express middleware
 */
function requireRole(pool, ...roles) {
  return async (req, res, next) => {
    try {
      const result = await pool.query(
        'SELECT role FROM users WHERE oidc_user_id = $1',
        [req.user.userId]
      );

      if (!result.rows.length) {
        return res.status(403).json({ error: 'User not found' });
      }

      if (!roles.includes(result.rows[0].role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    } catch (err) {
      console.error('requireRole error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * Insert an entry into the audit log.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @param {Object} entry - Audit log entry
 * @param {number} entry.userId - ID of the user performing the action
 * @param {string} entry.action - Action name (e.g., 'approve_user', 'change_role')
 * @param {string} [entry.entityType] - Type of entity acted upon (e.g., 'user')
 * @param {string} [entry.entityId] - ID of the entity acted upon
 * @param {Object} [entry.details] - Additional details (stored as JSONB)
 */
async function logAudit(pool, { userId, action, entityType, entityId, details }) {
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, action, entityType || null, entityId || null, JSON.stringify(details || {})]
  );
}

// ============================================
// Express Router
// ============================================

/**
 * Create an Express router for user management endpoints.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @returns {import('express').Router}
 */
function createUserRouter(pool) {
  const router = express.Router();

  // GET / — return the current user's identity (from OIDC middleware)
  router.get('/', (req, res) => {
    res.json(req.user);
  });

  // POST /session — upsert user on login, return DB record
  router.post('/session', async (req, res) => {
    try {
      const dbUser = await createSession(pool, req);
      res.json(dbUser);
    } catch (err) {
      console.error('POST /session error:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // GET /users — list all users (admin only), optional ?account_status filter
  router.get('/users', requireRole(pool, 'admin'), async (req, res) => {
    try {
      const { account_status } = req.query;
      let query = 'SELECT * FROM users ORDER BY created_at DESC';
      const params = [];

      if (account_status && VALID_STATUSES.includes(account_status)) {
        query = 'SELECT * FROM users WHERE account_status = $1 ORDER BY created_at DESC';
        params.push(account_status);
      }

      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error('GET /users error:', err);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // PUT /users/:id/role — update a user's role (admin only)
  router.put('/users/:id/role', requireRole(pool, 'admin'), async (req, res) => {
    try {
      const { role } = req.body;
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      }

      const result = await pool.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING *',
        [role, req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Get admin's DB user for audit log
      const admin = await pool.query('SELECT id FROM users WHERE oidc_user_id = $1', [req.user.userId]);
      if (admin.rows.length) {
        await logAudit(pool, {
          userId: admin.rows[0].id,
          action: 'change_role',
          entityType: 'user',
          entityId: req.params.id,
          details: { newRole: role }
        });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('PUT /users/:id/role error:', err);
      res.status(500).json({ error: 'Failed to update role' });
    }
  });

  // PUT /users/:id/access — approve or deny a user (admin only)
  router.put('/users/:id/access', requireRole(pool, 'admin'), async (req, res) => {
    try {
      const { account_status } = req.body;
      if (!['approved', 'denied'].includes(account_status)) {
        return res.status(400).json({ error: 'Invalid status. Must be approved or denied.' });
      }

      const result = await pool.query(
        'UPDATE users SET account_status = $1 WHERE id = $2 RETURNING *',
        [account_status, req.params.id]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: 'User not found' });
      }

      const admin = await pool.query('SELECT id FROM users WHERE oidc_user_id = $1', [req.user.userId]);
      if (admin.rows.length) {
        await logAudit(pool, {
          userId: admin.rows[0].id,
          action: account_status === 'approved' ? 'approve_user' : 'deny_user',
          entityType: 'user',
          entityId: req.params.id,
          details: { newStatus: account_status }
        });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('PUT /users/:id/access error:', err);
      res.status(500).json({ error: 'Failed to update access' });
    }
  });

  return router;
}

module.exports = {
  ADMIN_EMAILS,
  createSession,
  requireApproved,
  requireRole,
  logAudit,
  createUserRouter
};

// ============================================
// Frontend Pattern: Role-Based Navigation
// ============================================
//
// Filter sidebar items by user role so restricted pages
// are hidden from users who don't have access:
//
//   const navItems = [
//     { path: '/', label: 'Home', icon: 'H' },
//     { path: '/admin', label: 'Admin', icon: 'A', roles: ['admin'] },
//   ];
//   const visible = navItems.filter(i => !i.roles || i.roles.includes(userRole));
//
