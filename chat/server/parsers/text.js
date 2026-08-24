/**
 * Plain-text parser — handles everything that's safe to read as UTF-8.
 * Acts as the catch-all when no richer parser is registered.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIME_BY_EXT = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  log: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
};

const PREVIEW_BYTES = 2048;
const FULL_TEXT_MAX = 16 * 1024;

export default {
  extensions: ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'log', 'xml', 'html', 'htm'],
  async parse(absPath) {
    const buf = await readFile(absPath);
    const text = buf.toString('utf-8');
    const ext = path.extname(absPath).replace(/^\./, '').toLowerCase();
    const lines = text.split('\n').length;
    return {
      preview: text.slice(0, PREVIEW_BYTES),
      summary: `${ext.toUpperCase()} file, ${lines} line${lines === 1 ? '' : 's'}, ${buf.length} bytes`,
      extractedText: text.length <= FULL_TEXT_MAX ? text : undefined,
      structure: { lines, bytes: buf.length },
      mime: MIME_BY_EXT[ext] || 'text/plain',
    };
  },
};
