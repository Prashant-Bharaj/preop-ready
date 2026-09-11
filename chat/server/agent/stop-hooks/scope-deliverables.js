/**
 * Scope deliverables — pure-function helpers used by stop-hook validators.
 *
 * Extracted from agent.js so the stop-hook validators can import them
 * without creating a circular dep on agent.js. Logic is unchanged from the
 * original inline declarations; this is a pure relocation for B3.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Parse the model's "**Files:**" section of a completion report and check
 * each claimed path exists on disk under workspaceDir. Returns the list of
 * claimed paths that DON'T exist (the "ghost files"). Empty array means the
 * report's path claims line up with the disk.
 *
 * Each bullet's path gets existence-checked against workspaceDir. Paths
 * with trailing annotations like "(created)", "(modified)", etc. are stripped.
 * Only paths that look like relative files (contain `/`, no absolute prefix)
 * are checked — we don't want to false-positive on "Files: N" summaries or
 * on arbitrary prose.
 */
export function validateReportFilePaths(reportText, workspaceDir) {
  if (!reportText || typeof reportText !== 'string') return [];
  const lies = [];
  // Look for "**Files:**" section, then bullet lines that follow until the
  // next bold section header.
  const filesMatch = reportText.match(/\*\*Files:\*\*([\s\S]*?)(?:\n\s*\*\*[A-Za-z][^*]*\*\*|\n\s*---|$)/);
  if (!filesMatch) return [];
  const section = filesMatch[1];

  for (const rawLine of section.split('\n')) {
    const m = rawLine.match(/^\s*[-*]\s+([^\s(]+)/);
    if (!m) continue;
    let p = m[1].trim();
    // Drop surrounding backticks: `- \`foo/bar.js\``
    p = p.replace(/^`+|`+$/g, '');
    // Skip non-paths (no slash, or obviously not a file path)
    if (!p.includes('/')) continue;
    if (p.startsWith('/') || p.includes('://')) continue;
    // Skip path fragments used as examples in descriptions
    if (p.length > 200) continue;
    const abs = path.join(workspaceDir, p);
    if (!existsSync(abs)) lies.push(p);
  }
  return lies;
}

/**
 * Detect which language the backend scope is committing to, by examining
 * what's already on disk (entry file, deps file, Dockerfile FROM line).
 * Returns 'python' / 'node' / 'rust' / null.
 */
export function detectBackendLanguage(workspaceDir) {
  const has = (p) => existsSync(path.join(workspaceDir, p));
  if (has('backend/requirements.txt') || has('backend/pyproject.toml')) return 'python';
  if (has('backend/package.json')) return 'node';
  if (has('backend/Cargo.toml')) return 'rust';
  if (has('backend/main.py') || has('backend/src/index.ts') || has('backend/src/index.js') || has('backend/src/main.rs')) {
    if (has('backend/main.py')) return 'python';
    if (has('backend/src/index.ts')) return 'node';
    if (has('backend/src/index.js')) return 'node';
    if (has('backend/src/main.rs')) return 'rust';
  }
  const dockerfilePath = path.join(workspaceDir, 'backend/Dockerfile');
  if (existsSync(dockerfilePath)) {
    try {
      const content = readFileSync(dockerfilePath, 'utf-8');
      if (/^\s*FROM\s+python/im.test(content)) return 'python';
      if (/^\s*FROM\s+node/im.test(content)) return 'node';
      if (/^\s*FROM\s+rust/im.test(content)) return 'rust';
    } catch {
      // unreadable → fall through
    }
  }
  function scan(dir, depth) {
    if (depth > 3) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === 'target') continue;
      if (e.isDirectory()) {
        const found = scan(path.join(dir, e.name), depth + 1);
        if (found) return found;
        continue;
      }
      if (/\.py$/.test(e.name)) return 'python';
      if (/\.rs$/.test(e.name)) return 'rust';
      if (/\.(js|mjs|cjs|ts)$/.test(e.name)) return 'node';
    }
    return null;
  }
  const backendDir = path.join(workspaceDir, 'backend');
  if (existsSync(backendDir)) {
    const lang = scan(backendDir, 0);
    if (lang) return lang;
  }
  return null;
}

/**
 * Files the backend scope must produce per language for `docker-compose
 * build` to succeed. Each Dockerfile.* template has a `COPY <deps-file>`
 * + install step + a `CMD` runtime entry — both must resolve to real
 * files in the build context. Dockerfile itself is auto-filled
 * post-completion (see ensureScopeDockerfile in agent.js), so it's
 * deliberately NOT in this list.
 */
// Entries are strings (single required path) OR arrays (any-one-of). The
// node entry-file is .ts canonically post-W1.PATHS.CANONICAL; .js kept as a
// tolerant fallback for old workspaces and pre-migration fixtures.
export const BACKEND_LANGUAGE_REQUIREMENTS = {
  python: ['backend/main.py', 'backend/requirements.txt'],
  node:   [['backend/src/index.ts', 'backend/src/index.js'], 'backend/package.json'],
  rust:   ['backend/Cargo.toml', 'backend/src/main.rs'],
};

/**
 * Content-validators for required files. A path is "missing" if it doesn't
 * exist OR its content fails the validator. Without this, the model can
 * game the existence-only check by writing a re-export shim
 * (`backend/main.py` containing `from src.main import app`) that satisfies
 * existsSync but doesn't actually contain the FastAPI app the Dockerfile
 * CMD `uvicorn main:app` expects. Validator returns true when content is
 * acceptable, false when the file fails the check.
 */
export const FILE_CONTENT_VALIDATORS = {
  'backend/main.py': (content) => /\b(from\s+fastapi|import\s+fastapi)\b/.test(content),
  'backend/requirements.txt': (content) => /\bfastapi\b/i.test(content),
};

/**
 * For a given scope, return the list of paths that the language commits
 * to but the model didn't write — or wrote with content that fails the
 * scope's structural requirement. Empty array means "no missing
 * requirements".
 */
export function findMissingScopeRequirements(scope, workspaceDir) {
  if (scope === 'backend') {
    const lang = detectBackendLanguage(workspaceDir);
    if (!lang) return [];
    const required = BACKEND_LANGUAGE_REQUIREMENTS[lang] || [];
    const missing = [];
    for (const entry of required) {
      // Array entry = any-one-of (e.g., .ts or .js entry file is acceptable).
      // The first alternative is the canonical path; report only the canonical
      // when none of the alternatives exist, to keep error messages clean.
      if (Array.isArray(entry)) {
        const anyExists = entry.some((p) => existsSync(path.join(workspaceDir, p)));
        if (!anyExists) {
          missing.push(entry[0]);
          continue;
        }
        // At least one exists. Run content validator on whichever does exist
        // (validators are keyed by canonical path; alternatives skip validation).
        const present = entry.find((p) => existsSync(path.join(workspaceDir, p)));
        const validator = FILE_CONTENT_VALIDATORS[present];
        if (!validator) continue;
        try {
          if (!validator(readFileSync(path.join(workspaceDir, present), 'utf-8'))) missing.push(present);
        } catch {
          missing.push(present);
        }
        continue;
      }
      // Single string path = strict required.
      const abs = path.join(workspaceDir, entry);
      if (!existsSync(abs)) { missing.push(entry); continue; }
      const validator = FILE_CONTENT_VALIDATORS[entry];
      if (!validator) continue;
      try {
        if (!validator(readFileSync(abs, 'utf-8'))) missing.push(entry);
      } catch {
        missing.push(entry);
      }
    }
    return missing;
  }
  if (scope === 'integration') {
    const composePath = path.join(workspaceDir, 'docker-compose.yml');
    return existsSync(composePath) ? [] : ['docker-compose.yml'];
  }
  return [];
}
