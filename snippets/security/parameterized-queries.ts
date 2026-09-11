/**
 * scopes: [backend]
 * flags: []
 * description: Safe parameterised SQL patterns (TypeScript, pgvector / Postgres) — no string concat.
 */

/**
 * Parameterized Database Queries (TypeScript, PostgreSQL)
 *
 * Safe database query patterns using parameterized queries.
 * NEVER use string concatenation for SQL queries — that's the canonical
 * SQL-injection foot-gun.
 *
 * Dependencies:
 *   npm install pg
 *
 * Usage:
 *   import { pg, pgPool, type UserRow } from './parameterized-queries.js';
 *   const user = await pg.getUserById(userId);
 *   const users = await pg.searchUsers(searchTerm);
 */

import { Pool, type PoolConfig } from 'pg';

const config: PoolConfig = {
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
};

export const pgPool: Pool = new Pool(config);

export interface UserRow {
  id: number;
  name: string;
  email: string;
  created_at: Date;
  updated_at: Date | null;
}

// ============================================
// PostgreSQL (pg) — SAFE PATTERNS
// ============================================

export const pg = {
  /**
   * Get user by ID — SAFE: uses $1 placeholder.
   */
  async getUserById(id: number): Promise<UserRow | undefined> {
    const result = await pgPool.query<UserRow>(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0];
  },

  /**
   * Search users — SAFE: parameterized LIKE; wildcards live in the parameter.
   */
  async searchUsers(searchTerm: string): Promise<UserRow[]> {
    const result = await pgPool.query<UserRow>(
      'SELECT * FROM users WHERE name ILIKE $1',
      [`%${searchTerm}%`]
    );
    return result.rows;
  },

  /**
   * Insert user — SAFE: multiple placeholders.
   */
  async createUser(name: string, email: string): Promise<UserRow> {
    const result = await pgPool.query<UserRow>(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    return result.rows[0];
  },

  /**
   * Update user — SAFE: placeholders for both SET and WHERE.
   */
  async updateUser(
    id: number,
    name: string,
    email: string
  ): Promise<UserRow | undefined> {
    const result = await pgPool.query<UserRow>(
      'UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, email, id]
    );
    return result.rows[0];
  },

  /**
   * Delete user — SAFE: parameterized WHERE clause.
   */
  async deleteUser(id: number): Promise<UserRow | undefined> {
    const result = await pgPool.query<UserRow>(
      'DELETE FROM users WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  },

  /**
   * Get users with pagination — SAFE: parameters for LIMIT and OFFSET.
   */
  async getUsers(page = 1, limit = 10): Promise<UserRow[]> {
    const offset = (page - 1) * limit;
    const result = await pgPool.query<UserRow>(
      'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return result.rows;
  },

  /**
   * Filter by multiple IDs — SAFE: uses ANY() with an array parameter.
   */
  async getUsersByIds(ids: number[]): Promise<UserRow[]> {
    const result = await pgPool.query<UserRow>(
      'SELECT * FROM users WHERE id = ANY($1)',
      [ids]
    );
    return result.rows;
  },
};

// ============================================
// DANGEROUS PATTERNS — NEVER DO THESE
// ============================================
// The block below exists ONLY as a documentation reference of what NOT to
// write. None of these functions are exported or called. They are commented
// to make their dangerous nature explicit even when copy-pasted by accident.

/*
async function dangerousGetUser_NEVER_DO_THIS(id: string) {
  // ATTACKER INPUT: id = "1; DROP TABLE users;--"
  // RESULTING QUERY: SELECT * FROM users WHERE id = 1; DROP TABLE users;--
  const query = `SELECT * FROM users WHERE id = ${id}`; // DANGEROUS
  return pgPool.query(query);
}

async function dangerousSearch_NEVER_DO_THIS(name: string) {
  // ATTACKER INPUT: name = "'; DELETE FROM users WHERE '1'='1"
  const query = `SELECT * FROM users WHERE name = '${name}'`; // DANGEROUS
  return pgPool.query(query);
}

async function dangerousWithEscape_NEVER_DO_THIS(name: string) {
  // Manual escaping is error-prone and can be bypassed!
  const escaped = name.replace(/'/g, "''");
  const query = `SELECT * FROM users WHERE name = '${escaped}'`; // STILL DANGEROUS
  return pgPool.query(query);
}
*/
