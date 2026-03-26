/**
 * SNIPPET: Runtime App Settings (DB-backed)
 * CATEGORY: Configuration
 * LANGUAGE: JavaScript (Node.js / Express)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Runtime configuration backed by PostgreSQL with in-memory caching.
 *   Reads from DB first, falls back to environment variable, then default value.
 *   Includes Express router for admin settings management.
 *
 *   Cache has a 5-minute TTL so DB changes propagate without restart.
 *
 * DEPENDENCIES:
 *   npm install pg express
 *
 * USAGE:
 *   const { getConfig, setConfig, getAllSettings, settingsRouter } = require('./app-settings');
 *
 *   // Read a setting (DB -> env var -> default)
 *   const assistantId = await getConfig(pool, 'mga_assistant_id', 'MGA_ASSISTANT_ID', 'asst_default');
 *
 *   // Update a setting
 *   await setConfig(pool, 'mga_assistant_id', 'asst_new_id', 'admin@bayer.com');
 *
 *   // Mount admin routes
 *   app.use('/api', settingsRouter(pool));
 *   // GET  /api/settings       -> list all settings (admin only)
 *   // PUT  /api/settings/:key  -> update a setting (admin only)
 *
 * RELATED:
 *   - snippets/config/app-settings-schema.sql (database schema)
 *   - snippets/auth/user-roles.js (requireRole middleware for admin protection)
 */

const express = require('express');

// ---------------------------------------------------------------------------
// In-memory cache with TTL
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map();

/**
 * Get a cached value if it exists and hasn't expired.
 * @param {string} key
 * @returns {string|undefined}
 */
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Set a value in cache.
 * @param {string} key
 * @param {string} value
 */
function setCached(key, value) {
  cache.set(key, { value, timestamp: Date.now() });
}

/**
 * Invalidate a single cache entry.
 * @param {string} key
 */
function invalidateCache(key) {
  cache.delete(key);
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
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @param {string} key - Setting key
 * @param {string} [fallbackEnvVar] - Environment variable name to check if not in DB
 * @param {string} [defaultValue] - Default value if not found anywhere
 * @returns {Promise<string|null>} Setting value or defaultValue
 */
async function getConfig(pool, key, fallbackEnvVar, defaultValue) {
  // 1. Check cache
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  // 2. Check database
  try {
    const result = await pool.query(
      'SELECT value FROM app_settings WHERE key = $1',
      [key]
    );
    if (result.rows.length > 0) {
      const value = result.rows[0].value;
      setCached(key, value);
      return value;
    }
  } catch (error) {
    console.error(`[AppSettings] DB read failed for key "${key}":`, error.message);
    // Fall through to env var / default
  }

  // 3. Check environment variable
  if (fallbackEnvVar && process.env[fallbackEnvVar]) {
    const value = process.env[fallbackEnvVar];
    setCached(key, value);
    return value;
  }

  // 4. Default value
  return defaultValue !== undefined ? defaultValue : null;
}

/**
 * Set a configuration value. Upserts to database and invalidates cache.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @param {string} key - Setting key
 * @param {string} value - Setting value
 * @param {string} [updatedBy] - Who made the change (email, username, etc.)
 * @returns {Promise<object>} The upserted row
 */
async function setConfig(pool, key, value, updatedBy) {
  try {
    const result = await pool.query(
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
    console.error(`[AppSettings] DB write failed for key "${key}":`, error.message);
    throw new Error(`Failed to save setting "${key}": ${error.message}`);
  }
}

/**
 * Get all settings from the database (for admin page).
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @returns {Promise<object[]>} Array of { key, value, description, updated_by, updated_at }
 */
async function getAllSettings(pool) {
  try {
    const result = await pool.query(
      'SELECT key, value, description, updated_by, updated_at FROM app_settings ORDER BY key'
    );
    return result.rows;
  } catch (error) {
    console.error('[AppSettings] Failed to fetch all settings:', error.message);
    throw new Error(`Failed to fetch settings: ${error.message}`);
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
 *
 * Requires requireRole middleware from user-roles snippet.
 * If requireRole is not available, falls back to a basic check.
 *
 * @param {import('pg').Pool} pool - PostgreSQL connection pool
 * @param {object} [options]
 * @param {function} [options.requireRole] - Role middleware from user-roles snippet
 * @returns {import('express').Router}
 */
function settingsRouter(pool, options = {}) {
  const router = express.Router();

  // Use provided requireRole or create a fallback that checks req.user.role
  const requireAdmin = options.requireRole
    ? options.requireRole('admin')
    : (req, res, next) => {
        if (!req.user || req.user.role !== 'admin') {
          return res.status(403).json({ error: 'Admin access required' });
        }
        next();
      };

  /**
   * GET /settings - List all settings
   */
  router.get('/settings', requireAdmin, async (req, res) => {
    try {
      const settings = await getAllSettings(pool);
      res.json({ success: true, settings });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * PUT /settings/:key - Update a setting
   * Body: { value: "new value" }
   */
  router.put('/settings/:key', requireAdmin, async (req, res) => {
    try {
      const { key } = req.params;
      const { value } = req.body;

      if (value === undefined || value === null) {
        return res.status(400).json({ error: 'Missing "value" in request body' });
      }

      const updatedBy = req.user?.email || req.user?.name || 'unknown';
      const setting = await setConfig(pool, key, String(value), updatedBy);

      res.json({ success: true, setting });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = {
  getConfig,
  setConfig,
  getAllSettings,
  settingsRouter,
  // Exposed for testing
  invalidateCache,
};
