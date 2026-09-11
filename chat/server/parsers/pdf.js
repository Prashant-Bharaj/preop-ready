/**
 * PDF parser — uses pdf-parse for text extraction and page count.
 * Deep-imports `pdf-parse/lib/pdf-parse.js` to skip its test fixture side-effect.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const PREVIEW_BYTES = 2048;

export default {
  extensions: ['pdf'],
  async parse(absPath) {
    const buf = await readFile(absPath);
    const data = await pdfParse(buf);
    const text = (data.text || '').trim();
    const pages = data.numpages || 0;
    return {
      preview: text.slice(0, PREVIEW_BYTES),
      summary: `${pages}-page PDF, ~${text.length} chars of text`,
      extractedText: text.length <= 16 * 1024 ? text : undefined,
      structure: { pageCount: pages, charCount: text.length },
      mime: 'application/pdf',
    };
  },
};
