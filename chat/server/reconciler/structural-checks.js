/**
 * W3.RECOV — Section K Gap 1. Per-file structural invariants that survive
 * any legitimate agent edits.
 *
 * Why this module (vs the existing snippet pre-stage in routes.js): the
 * harness `fs.copyFileSync()`s `snippets/<scope>/Dockerfile.<lang>` to
 * `<scope>/Dockerfile` BEFORE the subagent spawns, but agents can
 * legitimately `replace_in_file` the Dockerfile after — adding `ENV`,
 * `RUN apt-get install`, `HEALTHCHECK`, etc. for app-specific needs.
 * Hash compare is therefore the wrong fix. Instead we encode the
 * structural rules that must hold regardless of what the agent added:
 *
 *   - Dockerfile: FROM ∈ whitelist for language; CMD references the
 *     canonical entry path; EXPOSE matches scope-port; WORKDIR present.
 *   - frontend/nginx.conf: `listen 8080;`; `location /api/ { proxy_pass
 *     http://backend:3000/; }` with both trailing slashes locked.
 *
 * Free to add anywhere (no enforcement): additional ENV / RUN / HEALTHCHECK /
 * USER / COPY lines in Dockerfile; caching/gzip/CSP/error_page in nginx.conf;
 * any extra deps in package.json/requirements.txt.
 *
 * Each helper returns `{ ok: bool, violations: [{ file, rule, found, expected }] }`.
 * `runStructuralChecks(workspaceDir, scopes)` aggregates across the per-file
 * checks relevant to the provided scopes and returns the combined report.
 *
 * Implementation: simple line-based parsing. No external deps. ~50 lines
 * per file type. Designed to be fast (<10ms across a workspace) so the
 * auto-recovery loop can call it on every pass.
 *
 * NOTE on the per-scope port set: matches scope-frontend.md (nginx listens
 * on 8080, proxies /api → backend:3000), scope-backend.md (Express on
 * 3000), and scope-database.md (Postgres on 5432).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// FROM image whitelists per language. dd-kitchen-sink:local is the
// canonical pre-built base (Debian with node + pip caches pre-warmed for
// fast compose-build); accept it for either runtime alongside the
// vanilla node/python images so agents that legitimately re-stage with a
// different base for their own reasons (alpine variant, version pin)
// still pass.
const NODE_FROM_WHITELIST = /^FROM\s+(node[:\s]|dd-kitchen-sink)/im;
const PYTHON_FROM_WHITELIST = /^FROM\s+(python[:\s]|dd-kitchen-sink)/im;
const POSTGRES_FROM_WHITELIST = /^FROM\s+(postgres[:\s]|pgvector\/pgvector|dd-kitchen-sink)/im;

// Canonical entry CMD signatures per language. The Dockerfile templates
// post-W1.PATHS.CANONICAL + W1.TYPES.SNIPPETS use:
//   Node:   CMD ["node", "dist/index.js"]  (multi-stage tsc → dist/)
//   Python: CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]
// We check for the canonical entry references but allow either the
// pre-tsc src/index.js path or the multi-stage dist/index.js — agents
// editing legitimately may keep src/ during local-dev variants.
const NODE_CMD_PATTERN = /CMD\s+\[[^\]]*"(?:dist\/index\.js|src\/index\.ts|src\/index\.js)"[^\]]*\]/i;
const PYTHON_CMD_PATTERN = /CMD\s+\[[^\]]*"uvicorn"[^\]]*"main:app"[^\]]*\]/i;

const SCOPE_EXPOSE_PORT = {
  backend: 3000,
  frontend: 8080,
  database: 5432,
  vectordb: 5432, // pgvector runs alongside postgres on 5432
};

function detectBackendLanguage(workspaceDir) {
  // Same heuristic as smoke-asserts.readBackendEntry. Canonical Node is
  // backend/src/index.ts post-W1.PATHS.CANONICAL.
  if (existsSync(path.join(workspaceDir, 'backend/src/index.ts'))) return 'node';
  if (existsSync(path.join(workspaceDir, 'backend/src/index.js'))) return 'node';
  if (existsSync(path.join(workspaceDir, 'backend/main.py'))) return 'python';
  return null;
}

/**
 * Validate backend/Dockerfile invariants.
 * Returns { ok, violations[] }.
 */
export function checkBackendDockerfile(workspaceDir) {
  const dfPath = path.join(workspaceDir, 'backend/Dockerfile');
  const violations = [];
  if (!existsSync(dfPath)) {
    return { ok: false, violations: [{ file: 'backend/Dockerfile', rule: 'exists', found: 'missing', expected: 'present (harness pre-stages this)' }] };
  }
  const content = readFileSync(dfPath, 'utf-8');
  const lang = detectBackendLanguage(workspaceDir);
  // FROM check is per-language; if we can't detect the language, fall
  // open (the agent may have written a non-canonical entry path that the
  // file-structure-check will catch separately).
  if (lang === 'node' && !NODE_FROM_WHITELIST.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'FROM-whitelist', found: firstLine(content, /^FROM\s/m) || 'no FROM', expected: 'FROM node:... or FROM dd-kitchen-sink' });
  } else if (lang === 'python' && !PYTHON_FROM_WHITELIST.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'FROM-whitelist', found: firstLine(content, /^FROM\s/m) || 'no FROM', expected: 'FROM python:... or FROM dd-kitchen-sink' });
  }
  // CMD: must reference canonical entry. Skip when CMD is absent — the
  // canonical Dockerfile templates always include one, so a missing CMD
  // is itself a violation.
  if (!/CMD\s+\[/i.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'CMD-present', found: 'no CMD', expected: 'CMD ["node", "dist/index.js"] or equivalent' });
  } else if (lang === 'node' && !NODE_CMD_PATTERN.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'CMD-canonical-entry', found: firstLine(content, /^CMD\s/m) || 'no CMD', expected: 'CMD ["node", "dist/index.js"] (or src/index.ts/.js variant)' });
  } else if (lang === 'python' && !PYTHON_CMD_PATTERN.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'CMD-canonical-entry', found: firstLine(content, /^CMD\s/m) || 'no CMD', expected: 'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]' });
  }
  // EXPOSE must include 3000 (backend canonical port).
  if (!/EXPOSE\s+(?:\d+\s+)*3000\b/.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'EXPOSE-3000', found: firstLine(content, /^EXPOSE\s/m) || 'no EXPOSE', expected: 'EXPOSE 3000' });
  }
  // WORKDIR must be set (any value — agents pick /app, /usr/src/app, etc.).
  if (!/^WORKDIR\s+\S/m.test(content)) {
    violations.push({ file: 'backend/Dockerfile', rule: 'WORKDIR-present', found: 'no WORKDIR', expected: 'WORKDIR /app (or any path)' });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Validate frontend/Dockerfile invariants. Frontend Dockerfile is multi-
 * stage (vite build → nginx); we only require the runtime stage exposes
 * 8080.
 */
export function checkFrontendDockerfile(workspaceDir) {
  const dfPath = path.join(workspaceDir, 'frontend/Dockerfile');
  const violations = [];
  if (!existsSync(dfPath)) {
    return { ok: false, violations: [{ file: 'frontend/Dockerfile', rule: 'exists', found: 'missing', expected: 'present (harness pre-stages this)' }] };
  }
  const content = readFileSync(dfPath, 'utf-8');
  // FROM must include either node (build stage) or nginx (runtime stage)
  // or dd-kitchen-sink. Multi-stage Dockerfiles will have multiple FROMs;
  // we just need the runtime image to be one of these.
  if (!/^FROM\s+(node|nginx|dd-kitchen-sink)/im.test(content)) {
    violations.push({ file: 'frontend/Dockerfile', rule: 'FROM-whitelist', found: firstLine(content, /^FROM\s/m) || 'no FROM', expected: 'FROM nginx:... or FROM node:... or FROM dd-kitchen-sink' });
  }
  if (!/EXPOSE\s+(?:\d+\s+)*8080\b/.test(content)) {
    violations.push({ file: 'frontend/Dockerfile', rule: 'EXPOSE-8080', found: firstLine(content, /^EXPOSE\s/m) || 'no EXPOSE', expected: 'EXPOSE 8080' });
  }
  if (!/^WORKDIR\s+\S/m.test(content)) {
    violations.push({ file: 'frontend/Dockerfile', rule: 'WORKDIR-present', found: 'no WORKDIR', expected: 'WORKDIR /app (or any path)' });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Validate database/Dockerfile invariants (postgres scope).
 */
export function checkDatabaseDockerfile(workspaceDir) {
  const dfPath = path.join(workspaceDir, 'database/Dockerfile');
  const violations = [];
  if (!existsSync(dfPath)) {
    return { ok: false, violations: [{ file: 'database/Dockerfile', rule: 'exists', found: 'missing', expected: 'present (harness pre-stages this)' }] };
  }
  const content = readFileSync(dfPath, 'utf-8');
  if (!POSTGRES_FROM_WHITELIST.test(content)) {
    violations.push({ file: 'database/Dockerfile', rule: 'FROM-whitelist', found: firstLine(content, /^FROM\s/m) || 'no FROM', expected: 'FROM postgres:... or FROM pgvector/pgvector or FROM dd-kitchen-sink' });
  }
  if (!/EXPOSE\s+(?:\d+\s+)*5432\b/.test(content)) {
    violations.push({ file: 'database/Dockerfile', rule: 'EXPOSE-5432', found: firstLine(content, /^EXPOSE\s/m) || 'no EXPOSE', expected: 'EXPOSE 5432' });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Validate frontend/nginx.conf (LOCAL dev — has proxy_pass). For production,
 * routing is Traefik so the prod nginx.conf has no proxy_pass.
 *
 * We validate the local config because that's what compose-up uses inside
 * docker-compose; the prod one is enforced separately by smoke-asserts.
 */
export function checkFrontendNginxConf(workspaceDir) {
  const local = path.join(workspaceDir, 'frontend/nginx.local.conf');
  const violations = [];
  // Prefer local; fall back to nginx.conf only if local isn't present.
  // Some scenarios produce a single nginx.conf with proxy_pass when the
  // template-pair convention isn't followed; we still check it.
  const file = existsSync(local) ? local : path.join(workspaceDir, 'frontend/nginx.conf');
  const rel = path.relative(workspaceDir, file);
  if (!existsSync(file)) {
    return { ok: false, violations: [{ file: 'frontend/nginx.local.conf', rule: 'exists', found: 'missing', expected: 'present (template pre-stage)' }] };
  }
  const content = readFileSync(file, 'utf-8');
  if (!/listen\s+8080\s*;/i.test(content)) {
    violations.push({ file: rel, rule: 'listen-8080', found: firstLine(content, /listen\s+\d+/i) || 'no listen', expected: 'listen 8080;' });
  }
  // Only enforce proxy_pass on the LOCAL config (prod is Traefik). If we
  // fell back to the prod nginx.conf, skip this rule.
  if (file === local) {
    // Both trailing slashes locked: location /api/ + proxy_pass http://backend:3000/
    if (!/location\s+\/api\/\s*\{[\s\S]*?proxy_pass\s+http:\/\/backend:3000\/\s*;/i.test(content)) {
      const found = (content.match(/location\s+\/api[^\s{]*[\s\S]{0,200}/i) || [''])[0].slice(0, 200);
      violations.push({ file: rel, rule: 'api-proxy-pass', found: found || 'no /api/ location with proxy_pass', expected: 'location /api/ { proxy_pass http://backend:3000/; }' });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Crash-guard signatures for the Node backend. Express 4 does not route
// async rejections to error middleware, so BOTH pieces are required: the
// 4-arg handler (structured 500s) and the process-level rejection guard
// (the actual crash stopper). Shared with the stop-hook validator.
export const ERROR_MIDDLEWARE_RE = /app\.use\(\s*(?:async\s*)?\(?\s*(?:err|error)\b[^)]*,[^)]*,[^)]*,[^)]*\)?\s*(?::|=>|\{)/;
export const REJECTION_GUARD_RE = /process\.on\(\s*['"]unhandledRejection['"]/;

/**
 * Node backend only: built code must carry the crash guards from the
 * express-server-template skeleton. FastAPI is skipped — the framework
 * survives handler exceptions natively.
 */
export function checkBackendErrorHandler(workspaceDir) {
  const violations = [];
  const srcDir = path.join(workspaceDir, 'backend', 'src');
  const files = collectSourceFiles(srcDir, ['.ts', '.js', '.mjs']);
  if (files.length === 0) return { ok: true, violations }; // python / not built yet

  let hasMiddleware = false;
  let hasGuard = false;
  for (const abs of files) {
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    if (ERROR_MIDDLEWARE_RE.test(content)) hasMiddleware = true;
    if (REJECTION_GUARD_RE.test(content)) hasGuard = true;
    if (hasMiddleware && hasGuard) break;
  }
  if (!hasMiddleware) {
    violations.push({
      file: 'backend/src',
      rule: 'error-middleware-present',
      found: 'no 4-arg Express error middleware in backend source',
      expected: 'app.use((err, _req, res, _next) => res.status(500).json({...})) as the LAST app.use (see express-server-template)',
    });
  }
  if (!hasGuard) {
    violations.push({
      file: 'backend/src',
      rule: 'unhandled-rejection-guard',
      found: "no process.on('unhandledRejection') guard in backend source",
      expected: "process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason)) — log, never exit",
    });
  }
  return { ok: violations.length === 0, violations };
}

function collectSourceFiles(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    const abs = path.join(dir, entry);
    const st = statSafe(abs);
    if (!st) continue;
    if (st.isDirectory()) collectSourceFiles(abs, exts, out);
    else if (exts.includes(path.extname(entry))) out.push(abs);
  }
  return out;
}

/**
 * Aggregator. Runs all checks relevant to `scopes` and returns the
 * combined report. Scopes argument is conventional: only scopes named in
 * the array get their checks fired.
 *
 * @param {string} workspaceDir
 * @param {string[]} scopes
 * @returns {{ ok: boolean, violations: Array<{ file, rule, found, expected, scope }> }}
 */
export function runStructuralChecks(workspaceDir, scopes = []) {
  const all = [];
  const dispatch = {
    backend: () => {
      const a = checkBackendDockerfile(workspaceDir);
      const b = checkBackendErrorHandler(workspaceDir);
      return { ok: a.ok && b.ok, violations: [...a.violations, ...b.violations] };
    },
    frontend: () => {
      const a = checkFrontendDockerfile(workspaceDir);
      const b = checkFrontendNginxConf(workspaceDir);
      return { ok: a.ok && b.ok, violations: [...a.violations, ...b.violations] };
    },
    database: () => checkDatabaseDockerfile(workspaceDir),
  };
  for (const scope of scopes) {
    const fn = dispatch[scope];
    if (!fn) continue;
    const result = fn();
    for (const v of result.violations) all.push({ scope, ...v });
  }
  return { ok: all.length === 0, violations: all };
}

// ── helpers ────────────────────────────────────────────────────────────

function firstLine(content, re) {
  const m = content.match(re);
  if (!m) return null;
  // Surface only the matched line (trimmed) — found-vs-expected reporting
  // gets cluttered if we dump full multiline matches.
  return m[0].split('\n')[0].trim().slice(0, 160);
}

// Exposed for symmetry with file-structure-check (which also reads files
// and may want size info). Not used internally — kept here so future
// per-file checks can compose without re-importing fs.
export function statSafe(filePath) {
  try { return statSync(filePath); } catch { return null; }
}
