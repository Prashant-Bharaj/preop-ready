/**
 * Spreadsheet parser — uses ExcelJS. Each sheet is flattened to CSV-ish
 * rows for a short text preview; the structure field lists sheet names and
 * row counts so the AI can reason about what's inside.
 */

import ExcelJS from 'exceljs';

const PREVIEW_BYTES = 2048;
const MAX_ROWS_PER_SHEET = 50;

export default {
  extensions: ['xlsx', 'xls'],
  async parse(absPath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(absPath);
    const sheetSummaries = [];
    const previewChunks = [];
    let totalRows = 0;

    wb.eachSheet((sheet) => {
      const rows = [];
      let rowCount = 0;
      sheet.eachRow((row) => {
        rowCount++;
        if (rows.length < MAX_ROWS_PER_SHEET) {
          // row.values is 1-indexed; slice(1) trims the leading undefined
          const cells = row.values.slice(1).map((v) =>
            v == null ? '' : typeof v === 'object' ? (v.text || v.result || JSON.stringify(v)) : String(v)
          );
          rows.push(cells.join(','));
        }
      });
      totalRows += rowCount;
      sheetSummaries.push({ name: sheet.name, rows: rowCount });
      previewChunks.push(`[Sheet: ${sheet.name} — ${rowCount} rows]\n${rows.join('\n')}`);
    });

    const preview = previewChunks.join('\n\n').slice(0, PREVIEW_BYTES);
    return {
      preview,
      summary: `Spreadsheet with ${sheetSummaries.length} sheet${sheetSummaries.length === 1 ? '' : 's'} (${sheetSummaries.map((s) => `${s.name}: ${s.rows} rows`).join(', ')})`,
      structure: { sheets: sheetSummaries, totalRows },
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  },
};
