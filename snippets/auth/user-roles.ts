/**
 * scopes: [backend]
 * flags: [has-admin]
 * description: Role check middleware (TypeScript) — gate routes by user role (employee/manager/admin).
 *
 * SNIPPET: User Roles & Access Control (Express + PostgreSQL)
 * CATEGORY: Authentication
 * LANGUAGE: TypeScript (Express)
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
 *   npm install pg express-rate-limit
 *
 * ENV:
 *   SECRET_3 or INITIAL_ADMIN_EMAILS — comma-separated list of
 *   bootstrap admin email addresses (auto-approved + admin role)
 *
 * USAGE:
 *   import { createUserRouter, requireApproved, requireRole } from './user-roles.js';
 *
 *   // Attach after userIdentityMiddleware (see user-identity.ts)
 *   app.use('/auth', createUserRouter(pool));
 *
 *   // Protect routes
 *   app.use('/api', requireApproved(pool));
 *   app.get('/api/admin/stats', requireRole(pool, 'admin'), handler);
 */

import express, {
  type Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';
import type { Pool } from 'pg';
import rateLimit from 'express-rate-limit';

export type UserRole = 'user' | 'expert' | 'admin';
export type AccountStatus = 'pending' | 'approved' | 'denied';

export interface DbUser {
  id: number;
  oidc_user_id: string;
  email: string | null;
  name: string | null;
  role: UserRole;
  account_status: AccountStatus;
  created_at: Date;
  last_login: Date;
}

export interface AuditEntry {
  userId: number;
  action: string;
  entityType?: string;
  entityId?: string | number;
  details?: Record<string, unknown>;
}

const VALID_ROLES: readonly UserRole[] = ['user', 'expert', 'admin'];
const VALID_STATUSES: readonly AccountStatus[] = ['pending', 'approved', 'denied'];

/**
 * Comma-separated list of bootstrap admin emails.
 * These users are auto-approved with admin role on first login.
 */
export const ADMIN_EMAILS: string[] = (
  process.env.SECRET_3 ||
  process.env.INITIAL_ADMIN_EMAILS ||
  ''
)
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * Create or update a user session on login.
 * If the user's email is in ADMIN_EMAILS, they are auto-approved as admin.
 * Uses INSERT...ON CONFLICT (upsert) with RETURNING for atomicity.
 */
export async function createSession(pool: Pool, req: Request): Promise<DbUser> {
  if (!req.user) throw new Error('createSession called without req.user');
  const { userId, email, name } = req.user;
  const isBootstrapAdmin = Boolean(
    email && ADMIN_EMAILS.includes(email.toLowerCase())
  );

  const role: UserRole = isBootstrapAdmin ? 'admin' : 'user';
  const status: AccountStatus = isBootstrapAdmin ? 'approved' : 'pending';

  const result = await pool.query<DbUser>(
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
 */
export function requireApproved(pool: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const result = await pool.query<{ account_status: AccountStatus }>(
        'SELECT account_status FROM users WHERE oidc_user_id = $1',
        [req.user.userId]
      );

      if (!result.rows.length) {
        res.status(403).json({ error: 'User not found. Please log in first.' });
        return;
      }

      if (result.rows[0].account_status !== 'approved') {
        res.status(403).json({
          error: 'Account not approved',
          status: result.rows[0].account_status,
        });
        return;
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
 */
export function requireRole(pool: Pool, ...roles: UserRole[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      const result = await pool.query<{ role: UserRole }>(
        'SELECT role FROM users WHERE oidc_user_id = $1',
        [req.user.userId]
      );

      if (!result.rows.length) {
        res.status(403).json({ error: 'User not found' });
        return;
      }

      if (!roles.includes(result.rows[0].role)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
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
 */
export async function logAudit(pool: Pool, entry: AuditEntry): Promise<void> {
  const { userId, action, entityType, entityId, details } = entry;
  await pool.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      action,
      entityType || null,
      entityId || null,
      JSON.stringify(details || {}),
    ]
  );
}

/**
 * Create an Express router for user management endpoints.
 */
export function createUserRouter(pool: Pool): Router {
  const router = express.Router();
  // Every handler below hits the database; cap abusive callers per IP.
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

  // GET / — return the current user's identity (from OIDC middleware)
  router.get('/', (req: Request, res: Response) => {
    res.json(req.user);
  });

  // POST /session — upsert user on login, return DB record
  router.post('/session', async (req: Request, res: Response) => {
    try {
      const dbUser = await createSession(pool, req);
      res.json(dbUser);
    } catch (err) {
      console.error('POST /session error:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // GET /users — list all users (admin only), optional ?account_status filter
  router.get(
    '/users',
    requireRole(pool, 'admin'),
    async (req: Request, res: Response) => {
      try {
        const accountStatus = req.query.account_status;
        let query = 'SELECT * FROM users ORDER BY created_at DESC';
        const params: unknown[] = [];

        if (
          typeof accountStatus === 'string' &&
          VALID_STATUSES.includes(accountStatus as AccountStatus)
        ) {
          query =
            'SELECT * FROM users WHERE account_status = $1 ORDER BY created_at DESC';
          params.push(accountStatus);
        }

        const result = await pool.query<DbUser>(query, params);
        res.json(result.rows);
      } catch (err) {
        console.error('GET /users error:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
      }
    }
  );

  // PUT /users/:id/role — update a user's role (admin only)
  router.put(
    '/users/:id/role',
    requireRole(pool, 'admin'),
    async (req: Request, res: Response) => {
      try {
        const { role } = req.body as { role?: UserRole };
        if (!role || !VALID_ROLES.includes(role)) {
          res.status(400).json({
            error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
          });
          return;
        }

        const result = await pool.query<DbUser>(
          'UPDATE users SET role = $1 WHERE id = $2 RETURNING *',
          [role, req.params.id]
        );

        if (!result.rows.length) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        // Get admin's DB user for audit log
        if (req.user) {
          const admin = await pool.query<{ id: number }>(
            'SELECT id FROM users WHERE oidc_user_id = $1',
            [req.user.userId]
          );
          if (admin.rows.length) {
            await logAudit(pool, {
              userId: admin.rows[0].id,
              action: 'change_role',
              entityType: 'user',
              entityId: req.params.id,
              details: { newRole: role },
            });
          }
        }

        res.json(result.rows[0]);
      } catch (err) {
        console.error('PUT /users/:id/role error:', err);
        res.status(500).json({ error: 'Failed to update role' });
      }
    }
  );

  // PUT /users/:id/access — approve or deny a user (admin only)
  router.put(
    '/users/:id/access',
    requireRole(pool, 'admin'),
    async (req: Request, res: Response) => {
      try {
        const { account_status } = req.body as { account_status?: AccountStatus };
        if (
          !account_status ||
          !(['approved', 'denied'] as AccountStatus[]).includes(account_status)
        ) {
          res
            .status(400)
            .json({ error: 'Invalid status. Must be approved or denied.' });
          return;
        }

        const result = await pool.query<DbUser>(
          'UPDATE users SET account_status = $1 WHERE id = $2 RETURNING *',
          [account_status, req.params.id]
        );

        if (!result.rows.length) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        if (req.user) {
          const admin = await pool.query<{ id: number }>(
            'SELECT id FROM users WHERE oidc_user_id = $1',
            [req.user.userId]
          );
          if (admin.rows.length) {
            await logAudit(pool, {
              userId: admin.rows[0].id,
              action: account_status === 'approved' ? 'approve_user' : 'deny_user',
              entityType: 'user',
              entityId: req.params.id,
              details: { newStatus: account_status },
            });
          }
        }

        res.json(result.rows[0]);
      } catch (err) {
        console.error('PUT /users/:id/access error:', err);
        res.status(500).json({ error: 'Failed to update access' });
      }
    }
  );

  return router;
}

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
