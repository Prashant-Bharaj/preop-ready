/**
 * scopes: [backend]
 * flags: []
 * description: PostgreSQL connection pool (TypeScript) with platform env vars.
 */

/**
 * PostgreSQL Connection Pool (TypeScript)
 *
 * Uses environment variables auto-injected by the platform:
 *   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD
 *
 * Defaults match docker-compose local dev values.
 * ALWAYS use parameterized queries: pool.query('SELECT * FROM x WHERE id = $1', [id])
 */

import { Pool, type PoolConfig } from 'pg';

const config: PoolConfig = {
  host: process.env.DATABASE_HOST || 'database',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME || 'myapp',
  user: process.env.DATABASE_USER || 'myapp_user',
  password: process.env.DATABASE_PASSWORD || 'localdev123',
};

const pool: Pool = new Pool(config);

export default pool;
