/**
 * PostgreSQL Connection Pool
 *
 * Uses environment variables auto-injected by the platform:
 *   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD
 */

import { Pool, type PoolConfig } from 'pg';

const config: PoolConfig = {
  host: process.env.DATABASE_HOST || 'database',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME || 'myapp',
  user: process.env.DATABASE_USER || 'myapp_user',
  password: process.env.DATABASE_PASSWORD || 'localdev123',
};

export const pool: Pool = new Pool(config);