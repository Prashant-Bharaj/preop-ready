/**
 * Parser registry — dispatches a file to the first parser whose `extensions`
 * list matches the file extension. Drop a new module into this directory to
 * extend support without touching call sites.
 *
 * Each parser module must export:
 *   { extensions: string[],            // without leading dot, lowercase
 *     parse: async (absPath) => {
 *       preview: string,               // human-readable excerpt (~2KB)
 *       summary: string,               // one-line description
 *       extractedText?: string,        // optional: full text for short files
 *       structure?: object,            // optional: type-specific metadata
 *       mime: string,                  // MIME type for the frontend
 *     } }
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { logAndSwallow } from '../util/log-helpers.js';

const PARSERS_DIR = path.dirname(new URL(import.meta.url).pathname);

// Registry: extension → parser module
const registry = new Map();

async function loadParsers() {
  const files = readdirSync(PARSERS_DIR).filter(
    (f) => (f.endsWith('.js') || f.endsWith('.ts')) && f !== 'index.js' && f !== 'index.ts'
  );
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(PARSERS_DIR, file)).href);
      const parser = mod.default || mod;
      if (!parser?.extensions || typeof parser.parse !== 'function') {
        console.warn(`[parsers] Skipping ${file}: missing extensions/parse`);
        continue;
      }
      for (const ext of parser.extensions) {
        const key = ext.toLowerCase().replace(/^\./, '');
        if (!registry.has(key)) registry.set(key, parser);
      }
    } catch (err) {
      logAndSwallow(err, `[parsers] Failed to load ${file}`);
    }
  }
}

// Eagerly load parsers at module import. `loadParsers` returns a promise, but
// for a Node server this resolves well before the first upload arrives.
const ready = loadParsers();

/**
 * Resolve the parser for a given absolute file path, then run it.
 * Returns `null` when no parser matches the extension.
 */
export async function parseFile(absPath) {
  await ready;
  const ext = path.extname(absPath).replace(/^\./, '').toLowerCase();
  const parser = registry.get(ext);
  if (!parser) return null;
  try {
    return await parser.parse(absPath);
  } catch (err) {
    return logAndSwallow(err, `[parsers] ${ext} parser failed on ${path.basename(absPath)}`, null);
  }
}

/** Extensions the registry currently handles — for diagnostics. */
export async function listExtensions() {
  await ready;
  return [...registry.keys()].sort();
}
