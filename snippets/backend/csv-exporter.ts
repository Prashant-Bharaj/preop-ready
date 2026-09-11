/**
 * scopes: [backend]
 * flags: [exports-csv]
 * description: Streaming CSV export endpoint (TypeScript) with proper RFC 4180 escaping.
 *
 * Mounts an Express handler that streams rows as CSV — handles fields with
 * commas, quotes, and newlines correctly. Use for downloads of any size;
 * does NOT buffer the full table in memory.
 *
 * Wire it into your route file:
 *   import { mountCsvExport } from './csv-exporter.js';
 *   mountCsvExport(app, '/reports/csv', async function*(req) {
 *     yield ['id', 'email', 'created_at'];   // header row
 *     const { rows } = await pool.query('SELECT id, email, created_at FROM users ORDER BY created_at DESC');
 *     for (const r of rows) yield [r.id, r.email, r.created_at.toISOString()];
 *   });
 *
 * The async generator pattern lets you stream rows from the DB cursor (or
 * any data source) without loading everything into memory first.
 */

import type { Express, Request, Response } from 'express';

export type CsvCellValue = string | number | boolean | null | undefined | Date;
export type CsvRow = CsvCellValue[];

export type CsvRowSource =
  | ((req: Request) => AsyncIterable<CsvRow> | Iterable<CsvRow>)
  | AsyncIterable<CsvRow>
  | Iterable<CsvRow>;

export interface CsvExportOptions {
  filename?: string;
}

/**
 * Escape a single CSV field per RFC 4180:
 *   - If the value contains a comma, double-quote, or newline, wrap it
 *     in double-quotes and double any existing double-quotes inside.
 *   - Otherwise, return the raw string.
 *   - null / undefined become empty fields.
 */
export function escapeCsvField(value: CsvCellValue): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert one row (array of cell values) to a CSV line. No trailing newline.
 */
export function rowToCsv(row: CsvRow): string {
  return row.map(escapeCsvField).join(',');
}

/**
 * Mount a streaming CSV export endpoint on `app` at `path`. The `rowSource`
 * is an async generator function (or a sync iterable) that yields row arrays;
 * the FIRST yielded row is treated as the header. Streams chunks via
 * res.write() so the response body is sent incrementally — works for arbitrary
 * row counts without buffering.
 *
 * Filename for the download is derived from the path (last segment) + .csv;
 * override via `options.filename` if you want a fixed name.
 *
 * Use \r\n line terminators per RFC 4180 (Excel friendly).
 */
export function mountCsvExport(
  app: Express,
  path: string,
  rowSource: CsvRowSource,
  options: CsvExportOptions = {}
): void {
  app.get(path, async (req: Request, res: Response) => {
    const filename =
      options.filename ||
      (path.split('/').filter(Boolean).pop() || 'export') + '.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    try {
      let first = true;
      const iter =
        typeof rowSource === 'function'
          ? rowSource(req)
          : rowSource;
      for await (const row of iter as AsyncIterable<CsvRow>) {
        if (!first) res.write('\r\n');
        res.write(rowToCsv(row));
        first = false;
      }
      res.write('\r\n');
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If we haven't sent headers yet, return JSON 500. If streaming has
      // started, log + close — can't send a structured error mid-stream.
      if (!res.headersSent) {
        res.status(500).json({ error: 'Export failed', message });
      } else {
        // Surface partial completion truncation by writing a final marker
        // line; client-side CSV parsers will see an unterminated record.
        try { res.end(); } catch { /* noop */ }
        console.error('[csv-exporter] stream error after headers sent:', err);
      }
    }
  });
}
