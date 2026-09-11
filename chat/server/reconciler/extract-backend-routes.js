/**
 * Extract HTTP route declarations from backend source.
 *
 * Outputs structured records the comparator can match against frontend fetch
 * calls and the router's api_contract. No LLM, no AST — just regex against
 * patterns observed in real agent output.
 *
 * Coverage:
 *   - Express: `app.<method>(...)` and `router.<method>(...)` (any identifier
 *     ending in router/Router works too — `apiRouter.get`, etc.).
 *   - FastAPI: `@app.<method>("/path")` and `@router.<method>("/path")` on
 *     the line above a `def` / `async def`.
 *
 * Body shape is best-effort. We look for a `const { a, b } = req.body`
 * destructuring within the next ~60 lines after the route declaration. If we
 * can't recognize the pattern, we record the route with `requestFields = null`
 * and move on — the comparator still gets path+method.
 *
 * Skip silently on parse errors per the project's "don't block builds on
 * extractor confusion" stance. Debug-log via DEBUG=reconciler env var.
 */

import fs from 'node:fs';
import path from 'node:path';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];
const FILE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py']);

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
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkDir(abs, files);
    } else if (ent.isFile() && FILE_EXTS.has(path.extname(ent.name))) {
      files.push(abs);
    }
  }
  return files;
}

// `app.get('/path'`, `router.post(\`/path\``, `myRouter.delete("/path"`
// Captures: identifier, method, quote, path
const EXPRESS_ROUTE_RE = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])([^'"`]+)\3/g;

// `@app.get("/path")`, `@router.post('/path')`. Optional kwargs after path.
const FASTAPI_ROUTE_RE = /^\s*@\s*([A-Za-z_][\w]*)\.(get|post|put|patch|delete|head|options)\s*\(\s*(['"])([^'"]+)\3/gm;

// `const { a, b, c } = req.body` or `let { a } = req.body`
const REQ_BODY_DESTRUCTURE_RE = /(?:const|let)\s*\{\s*([^}]+?)\s*\}\s*=\s*req\.body\b/;

// `def x(body: SomeModel)` or `def x(payload: SomeModel = ...)`
const FASTAPI_BODY_PARAM_RE = /\bdef\s+\w+\s*\([^)]*?\b(\w+)\s*:\s*([A-Z][A-Za-z0-9_]*)/;

function extractFieldsFromDestructure(slice) {
  const m = slice.match(REQ_BODY_DESTRUCTURE_RE);
  if (!m) return null;
  const fields = m[1]
    .split(',')
    .map(s => s.trim().split(/[:=]/)[0].trim())
    .filter(Boolean);
  return fields.length ? fields : null;
}

// Given the index where a route declaration starts (e.g. `app.get(...)`), find
// the slice of source covering ONLY this route's handler body. Without this
// we'd greedily match the next route's `req.body` destructure and attribute
// its fields to an earlier route — observed t31 (2026-05-09): GET /health was
// reported with body { title, notes, due_date } because POST /tasks's
// destructure sat 200 lines later.
//
// Strategy: from the declaration index, find the first `=>` or `function`
// keyword (start of handler), then the next `{` (handler block open), then
// brace-balance to the matching `}`. Returns the slice between those braces,
// or '' if no block-bodied handler (e.g. inline arrow `(req, res) => res.json(...)`).
function extractHandlerBody(content, startIndex) {
  // Find handler-start marker: `=>` (arrow) or `function` (regular). Limit
  // search to ~500 chars after declaration to avoid skipping into the next
  // route on malformed input.
  const probe = content.slice(startIndex, startIndex + 500);
  const arrowIdx = probe.search(/=>/);
  const funcIdx = probe.search(/\bfunction\s*\(/);
  let handlerStart = -1;
  if (arrowIdx >= 0 && (funcIdx < 0 || arrowIdx < funcIdx)) {
    handlerStart = startIndex + arrowIdx + 2;
  } else if (funcIdx >= 0) {
    handlerStart = startIndex + funcIdx;
  }
  if (handlerStart < 0) return '';

  // Skip whitespace; if next non-whitespace isn't `{`, this is an inline-
  // expression arrow (no body to scan).
  let i = handlerStart;
  while (i < content.length && /\s/.test(content[i])) i++;
  if (content[i] !== '{') return '';

  // Brace-balance, ignoring braces inside strings, template literals, and
  // line/block comments. Conservative: bail out if we walk past 8000 chars.
  const cap = Math.min(content.length, i + 8000);
  let depth = 0;
  const start = i;
  while (i < cap) {
    const ch = content[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < cap && content[i] !== q) {
        if (content[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < cap && content[i] !== '`') {
        if (content[i] === '\\') i += 2;
        else if (content[i] === '$' && content[i + 1] === '{') {
          i += 2;
          let bd = 1;
          while (i < cap && bd > 0) {
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
    if (ch === '/' && content[i + 1] === '/') {
      while (i < cap && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < cap - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
    i++;
  }
  return content.slice(start, i); // unbalanced — best effort
}

function lineNumberAt(content, charIndex) {
  let n = 1;
  for (let i = 0; i < charIndex && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}

// Blank out comment lines while preserving line numbers, so the route regex
// can't match usage examples in doc headers. Observed live: the locked
// mga-client.ts header shows `app.post('/api/chat/stream', ...)` as an
// example — the scanner flagged it as a real route, the judge ruled it
// legitimate, and contract adoption wrote a phantom endpoint.
function blankCommentLines(content) {
  return content
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .join('\n');
}

function extractRoutesFromExpressFile(file, rawContent) {
  const out = [];
  // Skip files that don't look like an Express app (avoids matching e.g. a
  // util file's `obj.get(...)` accessor that happens to share the shape).
  // Real Express files import express, mount routers, or call .listen().
  const looksLikeExpress = /\b(require\(['"]express['"]\)|from\s+['"]express['"])|\.listen\s*\(/.test(rawContent);
  if (!looksLikeExpress) return out;
  const content = blankCommentLines(rawContent);

  let m;
  EXPRESS_ROUTE_RE.lastIndex = 0;
  while ((m = EXPRESS_ROUTE_RE.exec(content)) !== null) {
    const [_, ident, method, _q, routePath] = m;
    // Filter false positives: only treat as a route if the identifier looks
    // like an Express app/router. Empirically, real cases are `app`, `router`,
    // or `<word>Router`. Reject things like `obj.get('foo')` (lookup).
    if (ident !== 'app' && ident !== 'router' && !/Router$/.test(ident)) continue;

    const line = lineNumberAt(content, m.index);
    // Body shape: scan ONLY this route's handler body (brace-balanced) so a
    // later route's req.body destructure isn't attributed here.
    const handlerBody = extractHandlerBody(content, m.index);
    const requestFields = handlerBody ? extractFieldsFromDestructure(handlerBody) : null;
    out.push({
      file,
      line,
      method: method.toUpperCase(),
      path: routePath,
      requestFields: requestFields || null,
    });
  }
  return out;
}

function extractRoutesFromFastApiFile(file, rawContent) {
  const out = [];
  const looksLikeFastApi = /\b(from\s+fastapi|import\s+fastapi)\b/.test(rawContent);
  if (!looksLikeFastApi) return out;
  const content = blankCommentLines(rawContent).split('\n')
    .map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');

  let m;
  FASTAPI_ROUTE_RE.lastIndex = 0;
  while ((m = FASTAPI_ROUTE_RE.exec(content)) !== null) {
    const [_, ident, method, _q, routePath] = m;
    if (ident !== 'app' && ident !== 'router' && !/router$/i.test(ident)) continue;

    const line = lineNumberAt(content, m.index);
    // FastAPI body: scan the next 30 lines for the `def x(body: Model)`
    // signature. We capture the model class name; field-level resolution would
    // require parsing the Pydantic class, which is out of scope here.
    const slice = content.slice(m.index, m.index + 2000);
    const bodyMatch = slice.match(FASTAPI_BODY_PARAM_RE);
    const requestModel = bodyMatch ? bodyMatch[2] : null;
    out.push({
      file,
      line,
      method: method.toUpperCase(),
      path: routePath,
      requestFields: null,
      requestModel,
    });
  }
  return out;
}

/**
 * Walk `<workspaceDir>/backend/` and extract HTTP routes.
 * @param {string} workspaceDir
 * @returns {Array<{file:string, line:number, method:string, path:string, requestFields:?string[], requestModel:?string}>}
 */
export function extractBackendRoutes(workspaceDir) {
  const root = path.join(workspaceDir, 'backend');
  if (!fs.existsSync(root)) return [];
  const files = walkDir(root);
  const routes = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      debug('skip unreadable file', file, err.message);
      continue;
    }
    const ext = path.extname(file);
    try {
      if (ext === '.py') {
        routes.push(...extractRoutesFromFastApiFile(file, content));
      } else {
        routes.push(...extractRoutesFromExpressFile(file, content));
      }
    } catch (err) {
      debug('extractor threw on', file, err.message);
    }
  }
  // Stable sort: file path then line number.
  routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return routes;
}
