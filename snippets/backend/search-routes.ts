/**
 * scopes: [backend]
 * flags: [search-ui]
 * description: Filterable search routes (TypeScript, SQL LIKE / trigram) with pagination, sort, and filters.
 *
 * Pattern for in-app search over a structured table — NOT semantic / vector
 * search (that's `ai-rag`). Use when the user wants "find by name", "filter
 * by status", "sort by date" type UX. Pairs with frontend/SearchPage.tsx.
 *
 * Wire it into your route file:
 *   import { mountSearchRoutes } from './search-routes.js';
 *   mountSearchRoutes(app, '/customers', pool, {
 *     table: 'customers',
 *     searchableColumns: ['name', 'email'],
 *     filters: { status: { type: 'enum', values: ['active', 'archived'] } },
 *     sortable: ['created_at', 'name'],
 *     defaultSort: 'created_at DESC',
 *   });
 *
 * Mounts:
 *   GET /customers?q=<term>&status=active&sort=name&order=asc&limit=50&offset=0
 *
 * Returns:
 *   { results: [...rows], total: <int>, limit, offset, q }
 */

import type { Express, Request, Response } from 'express';
import type { Pool } from 'pg';

export type SearchFilterSpec =
  | { type: 'enum'; values: string[] }
  | { type: 'equals' };

export interface MountSearchOptions {
  table: string;
  searchableColumns?: string[];
  filters?: Record<string, SearchFilterSpec>;
  sortable?: string[];
  defaultSort?: string;
  selectColumns?: string;
  pageSizeMax?: number;
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

function assertSafeIdent(name: string, label: string): void {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`unsafe ${label}: ${name}`);
  }
}

export function mountSearchRoutes(
  app: Express,
  path: string,
  pool: Pool,
  opts: MountSearchOptions
): void {
  const {
    table,
    searchableColumns = [],
    filters = {},
    sortable = [],
    defaultSort = 'created_at DESC',
    selectColumns = '*',
    pageSizeMax = 100,
  } = opts;

  // Validate identifiers ONCE at mount time so SQL string concat is safe.
  // Any column or table name we splice into SQL has been allowlist-checked.
  assertSafeIdent(table, 'table');
  for (const c of searchableColumns) assertSafeIdent(c, 'searchable column');
  for (const c of sortable) assertSafeIdent(c, 'sortable column');
  for (const k of Object.keys(filters)) assertSafeIdent(k, 'filter key');

  app.get(path, async (req: Request, res: Response) => {
    try {
      const params: unknown[] = [];
      const where: string[] = [];

      // Free-text search across searchableColumns using ILIKE.
      const q = String(req.query.q || '').trim();
      if (q && searchableColumns.length > 0) {
        params.push(`%${q}%`);
        const idx = params.length;
        const orClauses = searchableColumns.map((c) => `${c} ILIKE $${idx}`);
        where.push(`(${orClauses.join(' OR ')})`);
      }

      // Per-field filters (enum + equality). Skip values not in the spec.
      for (const [key, spec] of Object.entries(filters)) {
        const raw = req.query[key];
        if (raw === undefined || raw === '') continue;
        const rawStr = String(raw);
        if (spec.type === 'enum') {
          if (!spec.values.includes(rawStr)) continue;
          params.push(rawStr);
          where.push(`${key} = $${params.length}`);
        } else if (spec.type === 'equals') {
          params.push(rawStr);
          where.push(`${key} = $${params.length}`);
        }
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      // Sort: defaults to defaultSort. User sort must be in `sortable` allowlist.
      let orderBy = defaultSort;
      const sortParam = req.query.sort ? String(req.query.sort) : '';
      if (sortParam && sortable.includes(sortParam)) {
        const order =
          String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        orderBy = `${sortParam} ${order}`;
      }

      // Pagination — clamp to a max so a malicious caller can't ask for 1M rows.
      const limit = Math.max(
        1,
        Math.min(parseInt(String(req.query.limit || ''), 10) || 50, pageSizeMax)
      );
      const offset = Math.max(0, parseInt(String(req.query.offset || ''), 10) || 0);

      // Count + page in two queries against the same WHERE. Could be one query
      // with COUNT() OVER() but two queries plan better on most schemas.
      const countSql = `SELECT COUNT(*)::int AS n FROM ${table} ${whereSql}`;
      const dataSql = `SELECT ${selectColumns} FROM ${table} ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

      const [countRes, dataRes] = await Promise.all([
        pool.query(countSql, params),
        pool.query(dataSql, params),
      ]);

      res.json({
        results: dataRes.rows,
        total: countRes.rows[0].n,
        limit,
        offset,
        q,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}
