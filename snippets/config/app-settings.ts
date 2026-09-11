/**
 * scopes: [backend]
 * flags: [app-settings]
 * description: Per-user application settings CRUD (TypeScript, Express + Postgres).
 */

/**
 * Runtime App Settings (DB-backed) — TypeScript
 *
 * Runtime configuration backed by PostgreSQL with in-memory caching.
 * Reads from DB first, falls back to environment variable, then default value.
 * Includes Express router for admin settings management.
 *
 * Cache has a 5-minute TTL so DB changes propagate without restart.
 *
 * Dependencies:
 *   npm install pg express
 *
 * Usage:
 *   import { getConfig, setConfig, getAllSettings, settingsRouter } from './app-settings.js';
 *
 *   // Read a setting (DB -> env var -> default)
 *   const assistantId = await getConfig(pool, 'mga_assistant_id', 'MGA_ASSISTANT_ID', 'asst_default');
 *
 *   // Update a setting
 *   await setConfig(pool, 'mga_assistant_id', 'asst_new_id', 'admin@bayer.com');
 *
 *   // Mount admin routes
 *   app.use('/api', settingsRouter(pool));
 *   //   GET  /api/settings       -> list all settings (admin only)
 *   //   PUT  /api/settings/:key  -> update a setting (admin only)
 *
 * Related:
 *   - snippets/config/app-settings-schema.sql (database schema)
 *   - snippets/auth/user-roles.ts (requireRole middleware for admin protection)
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
  type Router,
  type RequestHandler,
} from 'express';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// In-memory cache with TTL
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: string;
  timestamp: number;
}

const cache: Map<string, CacheEntry> = new Map();

function getCached(key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached(key: string, value: string): void {
  cache.set(key, { value, timestamp: Date.now() });
}

export function invalidateCache(key: string): void {
  cache.delete(key);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AppSettingRow {
  key: string;
  value: string;
  description: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export interface SettingsRouterOptions {
  /**
   * Pre-built requireRole middleware factory from `snippets/auth/user-roles.ts`.
   * If omitted, falls back to a simple `req.user.role === 'admin'` check.
   */
  requireRole?: (role: string) => RequestHandler;
}

// Augment Express Request to expose the OIDC-decoded user object that other
// middleware (e.g. user-identity.ts) attaches. Kept loose on purpose so apps
// can extend it further.
declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      email?: string;
      name?: string;
      role?: string;
      [key: string]: unknown;
    };
  }
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Read a configuration value. Checks sources in order:
 *   1. In-memory cache (5-minute TTL)
 *   2. Database (app_settings table)
 *   3. Environment variable (fallbackEnvVar)
 *   4. Default value
 */
export async function getConfig(
  pool: Pool,
  key: string,
  fallbackEnvVar?: string,
  defaultValue?: string
): Promise<string | null> {
  // 1. Check cache
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  // 2. Check database
  try {
    const result = await pool.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = $1',
      [key]
    );
    if (result.rows.length > 0) {
      const value = result.rows[0].value;
      setCached(key, value);
      return value;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AppSettings] DB read failed for key "${key}":`, message);
    // Fall through to env var / default
  }

  // 3. Check environment variable
  if (fallbackEnvVar && process.env[fallbackEnvVar]) {
    const value = process.env[fallbackEnvVar] as string;
    setCached(key, value);
    return value;
  }

  // 4. Default value
  return defaultValue !== undefined ? defaultValue : null;
}

/**
 * Set a configuration value. Upserts to database and invalidates cache.
 */
export async function setConfig(
  pool: Pool,
  key: string,
  value: string,
  updatedBy?: string
): Promise<AppSettingRow> {
  try {
    const result = await pool.query<AppSettingRow>(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [key, value, updatedBy || null]
    );
    invalidateCache(key);
    return result.rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[AppSettings] DB write failed for key %s: %s', String(key).replace(/[\r\n]+/g, ' '), message);
    throw new Error(`Failed to save setting "${key}": ${message}`);
  }
}

/**
 * Get all settings from the database (for admin page).
 */
export async function getAllSettings(pool: Pool): Promise<AppSettingRow[]> {
  try {
    const result = await pool.query<AppSettingRow>(
      'SELECT key, value, description, updated_by, updated_at FROM app_settings ORDER BY key'
    );
    return result.rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[AppSettings] Failed to fetch all settings:', message);
    throw new Error(`Failed to fetch settings: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Express Router
// ---------------------------------------------------------------------------

/**
 * Create an Express router for admin settings management.
 *
 * Routes:
 *   GET  /settings      - List all settings (admin only)
 *   PUT  /settings/:key - Update a setting value (admin only)
 */
export function settingsRouter(
  pool: Pool,
  options: SettingsRouterOptions = {}
): Router {
  const router = express.Router();

  // Use provided requireRole or create a fallback that checks req.user.role
  const requireAdmin: RequestHandler = options.requireRole
    ? options.requireRole('admin')
    : (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || req.user.role !== 'admin') {
          res.status(403).json({ error: 'Admin access required' });
          return;
        }
        next();
      };

  router.get('/settings', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const settings = await getAllSettings(pool);
      res.json({ success: true, settings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  router.put('/settings/:key', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { key } = req.params;
      const { value } = req.body as { value?: unknown };

      if (value === undefined || value === null) {
        res.status(400).json({ error: 'Missing "value" in request body' });
        return;
      }

      const updatedBy = req.user?.email || req.user?.name || 'unknown';
      const setting = await setConfig(pool, key, String(value), updatedBy);

      res.json({ success: true, setting });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
