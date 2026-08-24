/**
 * Extract HTTP fetch calls from frontend source.
 *
 * Coverage:
 *   - `fetch('/api/...', { method: 'X', body: JSON.stringify({...}) })`
 *     and template-literal variants (`fetch(\`/api/${id}\`, ...)`).
 *   - axios shorthand: `axios.<method>('/api/...', body, config?)`.
 *   - axios config form: `axios({ method: 'X', url: '/api/...', data: {...} })`
 *     — common but a tertiary shape; we recognize it best-effort.
 *
 * Path normalization: strips the leading `/api/` (or `/api`) since that
 * prefix is added by the frontend to route through Traefik/nginx — backend
 * routes are registered without it.
 *
 * Body shape: best-effort parse of `JSON.stringify({ ... })` literal-object
 * top-level keys. Identifiers like `body: someObj` produce `requestFields: null`.
 *
 * Skip silently per the project's "don't block builds on extractor confusion"
 * stance.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

function debug(...args) {
  if (process.env.DEBUG && /\breconciler\b/.test(process.env.DEBUG)) {
    console.error('[reconciler]', ...args);
  }
}

function walkDir(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.') || ent.name === 'dist' || ent.name === 'build') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkDir(abs, files);
    } else if (ent.isFile() && FILE_EXTS.has(path.extname(ent.name))) {
      files.push(abs);
    }
  }
  return files;
}

// `fetch('/api/foo', ...)`, `fetch(\`/api/${x}\`, ...)`. Strips template-literal
// expression placeholders to ${...} so the path string is comparable.
// We deliberately match only the URL+leading-comma; the options object is
// extracted via brace-balanced scan (regex \{[\s\S]*?\} stops at the first
// inner `}` like `headers: {…}`, dropping body fields).
const FETCH_RE = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g;

// `axios.get('/api/foo')`, `axios.post('/api/foo', body)`.
const AXIOS_METHOD_RE = /\baxios\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+)\2(?:\s*,\s*([^)]+))?/g;

// `axios({ method: 'POST', url: '/api/foo', data: {...} })`. Loose match; we
// don't try to enforce inner key order.
const AXIOS_CONFIG_RE = /\baxios\s*\(\s*(\{[\s\S]*?\})\s*\)/g;

function lineNumberAt(content, charIndex) {
  let n = 1;
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}

// Given the index of the closing paren of `fetch(...)`'s URL argument, find
// the next argument's options-object source if present. Returns the raw
// `{...}` source string (including outer braces) or null. Brace-balanced —
// handles nested `{}` like `headers: { 'Content-Type': '...' }`.
function readFetchOptionsAfter(content, urlMatchEndIndex) {
  let i = urlMatchEndIndex;
  // Skip whitespace.
  while (i < content.length && /\s/.test(content[i])) i++;
  if (content[i] !== ',') return null;
  i++;
  while (i < content.length && /\s/.test(content[i])) i++;
  if (content[i] !== '{') return null;
  const start = i;
  let depth = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip string/template literal.
      const q = ch;
      i++;
      while (i < content.length && content[i] !== q) {
        if (content[i] === '\\') i += 2;
        else if (q === '`' && content[i] === '$' && content[i + 1] === '{') {
          // Skip ${...} interpolation including any nested braces.
          i += 2;
          let bd = 1;
          while (i < content.length && bd > 0) {
            if (content[i] === '{') bd++;
            else if (content[i] === '}') bd--;
            i++;
          }
        } else {
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

function normalizePath(p) {
  // Replace ${...} in template literals with :param-ish placeholder so paths
  // compare against backend `:id` route patterns. Leave plain segments intact.
  let out = p.replace(/\$\{[^}]+\}/g, ':param');
  // Strip /api or /api/ prefix.
  out = out.replace(/^\/api(?=\/|$)/, '');
  if (out === '') out = '/';
  // Drop query string for path comparison; record it separately if needed later.
  out = out.split('?')[0];
  return out;
}

// Extract method from a fetch options object source string.
function methodFromFetchOpts(optsSrc) {
  if (!optsSrc) return 'GET';
  const m = optsSrc.match(/\bmethod\s*:\s*['"]([A-Z]+)['"]/i);
  return m ? m[1].toUpperCase() : 'GET';
}

// Extract top-level keys from a `JSON.stringify({...})` literal in fetch opts.
function fieldsFromFetchOpts(optsSrc) {
  if (!optsSrc) return null;
  const m = optsSrc.match(/\bbody\s*:\s*JSON\.stringify\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!m) return null;
  return parseObjectLiteralKeys(m[1]);
}

// Parse top-level keys from an object-literal fragment. Crude but enough to
// cover `{ a: 1, b, c: someVar, d: { nested } }` — we only want top-level
// names, not nested structure.
function parseObjectLiteralKeys(inner) {
  const keys = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      keys.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) keys.push(buf);
  const names = [];
  for (const part of keys) {
    // `name: value` or shorthand `name`. Skip spread `...x`.
    const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$|,)/);
    if (m) names.push(m[1]);
  }
  return names.length ? names : null;
}

function extractFromFile(file, content) {
  const out = [];

  // fetch
  let m;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(content)) !== null) {
    const [_, _q, rawPath] = m;
    // Skip protocol-relative (//host/...) and external URLs.
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) continue;
    const optsSrc = readFetchOptionsAfter(content, m.index + m[0].length);
    const normalized = normalizePath(rawPath);
    out.push({
      file,
      line: lineNumberAt(content, m.index),
      method: methodFromFetchOpts(optsSrc),
      path: normalized,
      requestFields: fieldsFromFetchOpts(optsSrc),
      raw: rawPath,
    });
  }

  // axios.<method>(...)
  AXIOS_METHOD_RE.lastIndex = 0;
  while ((m = AXIOS_METHOD_RE.exec(content)) !== null) {
    const [_, method, _q, rawPath, bodyArg] = m;
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) continue;
    let requestFields = null;
    if (bodyArg && bodyArg.trim().startsWith('{')) {
      const inner = bodyArg.trim().replace(/^\{/, '').replace(/\}$/, '');
      requestFields = parseObjectLiteralKeys(inner);
    }
    out.push({
      file,
      line: lineNumberAt(content, m.index),
      method: method.toUpperCase(),
      path: normalizePath(rawPath),
      requestFields,
      raw: rawPath,
    });
  }

  // axios({ method, url, data })
  AXIOS_CONFIG_RE.lastIndex = 0;
  while ((m = AXIOS_CONFIG_RE.exec(content)) !== null) {
    const cfg = m[1];
    const methM = cfg.match(/\bmethod\s*:\s*['"]([A-Za-z]+)['"]/);
    const urlM = cfg.match(/\burl\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!urlM || !urlM[1].startsWith('/')) continue;
    const dataM = cfg.match(/\bdata\s*:\s*\{([\s\S]*?)\}/);
    out.push({
      file,
      line: lineNumberAt(content, m.index),
      method: (methM ? methM[1] : 'GET').toUpperCase(),
      path: normalizePath(urlM[1]),
      requestFields: dataM ? parseObjectLiteralKeys(dataM[1]) : null,
      raw: urlM[1],
    });
  }

  return out;
}

/**
 * Walk `<workspaceDir>/frontend/` and extract HTTP fetch calls.
 * @param {string} workspaceDir
 * @returns {Array<{file:string, line:number, method:string, path:string, requestFields:?string[], raw:string}>}
 */
export function extractFrontendFetches(workspaceDir) {
  const root = path.join(workspaceDir, 'frontend');
  if (!fs.existsSync(root)) return [];
  const files = walkDir(root);
  const fetches = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      debug('skip unreadable file', file, err.message);
      continue;
    }
    try {
      fetches.push(...extractFromFile(file, content));
    } catch (err) {
      debug('extractor threw on', file, err.message);
    }
  }
  fetches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return fetches;
}
