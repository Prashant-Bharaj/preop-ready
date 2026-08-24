/**
 * CSV parser — uses csv-parse in sync mode. For very large files we still
 * cap the preview bytes; the AI can fetch more rows via file tools if needed.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseCSV } from 'csv-parse/sync';

const PREVIEW_BYTES = 2048;
const MAX_PREVIEW_ROWS = 20;

export default {
  extensions: ['csv', 'tsv'],
  async parse(absPath) {
    const buf = await readFile(absPath);
    const raw = buf.toString('utf-8');
    const isTsv = absPath.toLowerCase().endsWith('.tsv');
    let records = [];
    try {
      records = parseCSV(raw, {
        delimiter: isTsv ? '\t' : ',',
        relax_quotes: true,
        relax_column_count: true,
        skip_empty_lines: true,
      });
    } catch {
      // Malformed CSV — fall back to raw preview
      return {
        preview: raw.slice(0, PREVIEW_BYTES),
        summary: `CSV file, parse failed, ${buf.length} bytes`,
        structure: { bytes: buf.length },
        mime: 'text/csv',
      };
    }
    const header = records[0] || [];
    const rowCount = records.length;
    const previewRows = records.slice(0, MAX_PREVIEW_ROWS)
      .map((r) => r.join(isTsv ? '\t' : ','))
      .join('\n');
    return {
      preview: previewRows.slice(0, PREVIEW_BYTES),
      summary: `${isTsv ? 'TSV' : 'CSV'} with ${rowCount} row${rowCount === 1 ? '' : 's'}${header.length ? `, ${header.length} columns (${header.slice(0, 6).join(', ')}${header.length > 6 ? '…' : ''})` : ''}`,
      structure: { rowCount, columns: header, bytes: buf.length },
      mime: isTsv ? 'text/tab-separated-values' : 'text/csv',
    };
  },
};
