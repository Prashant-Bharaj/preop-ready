/**
 * SNIPPET: Parameterized Database Queries
 * CATEGORY: Security
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: ✅ Ready
 * 
 * DESCRIPTION: 
 *   Safe database query patterns using parameterized queries.
 *   NEVER use string concatenation for SQL queries!
 *   Prevents SQL injection attacks.
 * 
 * DEPENDENCIES: 
 *   npm install pg         # For PostgreSQL
 *   npm install mysql2      # For MySQL
 * 
 * USAGE:
 *   const db = require('./db');
 *   const user = await db.getUserById(userId);
 *   const users = await db.searchUsers(searchTerm);
 */

// ============================================
// PostgreSQL (pg) - SAFE PATTERNS
// ============================================

const { Pool } = require('pg');

const pgPool = new Pool({
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT || 5432
});

const postgresQueries = {
  /**
   * Get user by ID - SAFE
   * ✅ Uses $1 parameter placeholder
   */
  async getUserById(id) {
    const result = await pgPool.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0];
  },

  /**
   * Search users - SAFE
   * ✅ Uses parameterized LIKE with proper escaping
   */
  async searchUsers(searchTerm) {
    const result = await pgPool.query(
      'SELECT * FROM users WHERE name ILIKE $1',
      [`%${searchTerm}%`]  // % wildcards go in the parameter
    );
    return result.rows;
  },

  /**
   * Insert user - SAFE
   * ✅ Uses multiple parameter placeholders
   */
  async createUser(name, email) {
    const result = await pgPool.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    return result.rows[0];
  },

  /**
   * Update user - SAFE
   * ✅ Parameters for both SET and WHERE
   */
  async updateUser(id, name, email) {
    const result = await pgPool.query(
      'UPDATE users SET name = $1, email = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      [name, email, id]
    );
    return result.rows[0];
  },

  /**
   * Delete user - SAFE
   * ✅ Parameterized WHERE clause
   */
  async deleteUser(id) {
    const result = await pgPool.query(
      'DELETE FROM users WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  },

  /**
   * Get users with pagination - SAFE
   * ✅ Parameters for LIMIT and OFFSET
   */
  async getUsers(page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    const result = await pgPool.query(
      'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return result.rows;
  },

  /**
   * Filter by multiple values (IN clause) - SAFE
   * ✅ Uses ANY() with array parameter
   */
  async getUsersByIds(ids) {
    const result = await pgPool.query(
      'SELECT * FROM users WHERE id = ANY($1)',
      [ids]  // Pass array directly
    );
    return result.rows;
  }
};

// ============================================
// MySQL (mysql2) - SAFE PATTERNS
// ============================================

const mysql = require('mysql2/promise');

const mysqlPool = mysql.createPool({
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.DATABASE_PORT || 3306
});

const mysqlQueries = {
  /**
   * Get user by ID - SAFE
   * ✅ Uses ? parameter placeholder
   */
  async getUserById(id) {
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM users WHERE id = ?',
      [id]
    );
    return rows[0];
  },

  /**
   * Search users - SAFE
   * ✅ Uses parameterized LIKE
   */
  async searchUsers(searchTerm) {
    const [rows] = await mysqlPool.execute(
      'SELECT * FROM users WHERE name LIKE ?',
      [`%${searchTerm}%`]
    );
    return rows;
  },

  /**
   * Insert user - SAFE
   * ✅ Multiple ? placeholders
   */
  async createUser(name, email) {
    const [result] = await mysqlPool.execute(
      'INSERT INTO users (name, email) VALUES (?, ?)',
      [name, email]
    );
    return { id: result.insertId, name, email };
  },

  /**
   * Filter by multiple values (IN clause) - SAFE
   * ✅ Generates correct number of placeholders
   */
  async getUsersByIds(ids) {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await mysqlPool.execute(
      `SELECT * FROM users WHERE id IN (${placeholders})`,
      ids
    );
    return rows;
  }
};

// ============================================
// ❌ DANGEROUS PATTERNS - NEVER DO THESE!
// ============================================

const DANGEROUS_EXAMPLES = {
  // ❌ String concatenation - SQL INJECTION VULNERABLE!
  dangerousGetUser_NEVER_DO_THIS: async (id) => {
    // ATTACKER INPUT: id = "1; DROP TABLE users;--"
    // RESULTING QUERY: SELECT * FROM users WHERE id = 1; DROP TABLE users;--
    const query = `SELECT * FROM users WHERE id = ${id}`;  // ❌ DANGEROUS!
    // return pgPool.query(query);
  },

  // ❌ Template literal with user input - SQL INJECTION VULNERABLE!
  dangerousSearch_NEVER_DO_THIS: async (name) => {
    // ATTACKER INPUT: name = "'; DELETE FROM users WHERE '1'='1"
    const query = `SELECT * FROM users WHERE name = '${name}'`;  // ❌ DANGEROUS!
    // return pgPool.query(query);
  },

  // ❌ String concatenation with sanitization attempt - STILL DANGEROUS!
  dangerousWithEscape_NEVER_DO_THIS: async (name) => {
    // Manual escaping is error-prone and can be bypassed!
    const escaped = name.replace(/'/g, "''");  // ❌ Insufficient!
    const query = `SELECT * FROM users WHERE name = '${escaped}'`;
    // return pgPool.query(query);
  }
};

module.exports = {
  // PostgreSQL
  pg: postgresQueries,
  pgPool,
  
  // MySQL
  mysql: mysqlQueries,
  mysqlPool
};
