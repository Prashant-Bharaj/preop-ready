/**
 * scopes: [backend]
 * flags: [snowflake]
 * description: Snowflake data warehouse connection (TypeScript stub).
 */

/**
 * Snowflake Data Warehouse Connection (TypeScript)
 *
 * Connect to Snowflake and execute queries.
 *
 * Environment variables:
 *   SNOWFLAKE_ACCOUNT   — Snowflake account identifier
 *   SNOWFLAKE_USER      — Username
 *   SNOWFLAKE_PASSWORD  — Password
 *   SNOWFLAKE_DATABASE  — Database name
 *   SNOWFLAKE_SCHEMA    — Schema name (default: PUBLIC)
 *   SNOWFLAKE_WAREHOUSE — Warehouse name
 *
 * Dependencies: snowflake-sdk (`npm install snowflake-sdk`).
 *
 * TODO: Replace this placeholder with your actual implementation.
 *
 * Example:
 *   import { querySnowflake } from './snowflake.js';
 *   const rows = await querySnowflake('SELECT * FROM my_table LIMIT 10');
 */

export type SnowflakeBind = string | number | boolean | Date | null;

export type SnowflakeRow = Record<string, unknown>;

export async function querySnowflake(
  _sql: string,
  _binds: SnowflakeBind[] = []
): Promise<SnowflakeRow[]> {
  throw new Error('Snowflake connection not configured — replace this placeholder');
}
