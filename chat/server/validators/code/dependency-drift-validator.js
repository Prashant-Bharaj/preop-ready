// Pre-`compose build` static scan + auto-fix for the bug class:
// a Node source file `require()`s or `import`s a package that isn't
// listed in package.json. `npm ci` fails with "Cannot find module
// 'foo'" on the build's RUN step. The model often gets this wrong when
// it copy-pastes a snippet from rule files / examples without
// remembering to add the dep — empirically the most common
// build-fail cause after Dockerfile FROM mismatches.
//
// Strategy: scan backend/src/**/*.js and frontend/src/**/*.js for
// import / require statements that resolve to a package name (not a
// relative path), compare against the matching package.json's
// `dependencies` (and `devDependencies`), and add any missing names
// with version "*" — npm resolves "*" to the latest published version
// at install time, which is right for the spike's regenerate-from-
// scratch lifecycle. We do NOT remove unused entries: removing a dep
// that the model added defensively (e.g. a polyfill imported in a
// branch the static scan missed) is a regression risk for almost no
// reward.
//
// Conservative: only Node JS scopes for now. Python (requirements.txt)
// has a richer namespace problem (PyPI vs internal mirrors, optional
// extras, packaging vs distribution names) that's better handled in
// a dedicated validator. Same for transitive deps — we trust npm to
// pull those.

import fs from 'node:fs';
import path from 'node:path';

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'process',
  'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_RE = /\bimport\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/g;
const IMPORT_BARE_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function isNodeBuiltin(spec) {
  return NODE_BUILTINS.has(spec) || spec.startsWith('node:');
}

function isRelativeOrAbsolute(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~');
}

/**
 * Map an import specifier to the npm package name. Handles scoped
 * packages (@scope/name) and subpath imports (lodash/get → lodash).
 */
function specToPackageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return spec.split('/')[0];
}

function* walkJsFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
        stack.push(abs);
        continue;
      }
      if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(e.name)) yield abs;
    }
  }
}

function extractImports(content) {
  const found = new Set();
  for (const re of [REQUIRE_RE, IMPORT_RE, IMPORT_BARE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      const spec = m[1];
      if (!spec || isRelativeOrAbsolute(spec) || isNodeBuiltin(spec)) continue;
      const pkg = specToPackageName(spec);
      if (pkg) found.add(pkg);
    }
  }
  return found;
}

function readPkgJson(pkgPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Scan a single Node scope for missing dependencies.
 * Returns { scope, packageJsonPath, missing: [packageName, ...] } or null
 * if the scope has no package.json (= not a Node scope).
 */
function scanScope(workspaceDir, scope) {
  const scopeDir = path.join(workspaceDir, scope);
  const pkgPath = path.join(scopeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  const pkg = readPkgJson(pkgPath);
  if (!pkg) return null;

  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ]);

  const found = new Set();
  for (const file of walkJsFiles(path.join(scopeDir, 'src'))) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pkgName of extractImports(content)) found.add(pkgName);
  }
  // Also scan top-level entry files (e.g. backend/index.js, frontend/main.jsx)
  // that may live outside src/.
  if (fs.existsSync(scopeDir)) {
    let entries;
    try {
      entries = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(e.name)) continue;
      let content;
      try {
        content = fs.readFileSync(path.join(scopeDir, e.name), 'utf8');
      } catch {
        continue;
      }
      for (const pkgName of extractImports(content)) found.add(pkgName);
    }
  }

  const missing = [...found].filter((p) => !declared.has(p)).sort();
  return { scope, packageJsonPath: pkgPath, missing };
}

/**
 * Scan backend/ and frontend/ for missing Node deps.
 *
 * Returns an array of issues:
 *   { scope: 'backend' | 'frontend', packageJsonPath, missing: [pkg, ...] }
 * Empty array → nothing to fix.
 */
export function scanForDependencyDrift(workspaceDir) {
  const issues = [];
  for (const scope of ['backend', 'frontend']) {
    const result = scanScope(workspaceDir, scope);
    if (result && result.missing.length) issues.push(result);
  }
  return issues;
}

/**
 * Add each missing dep to the relevant package.json with version "*".
 * npm resolves "*" to the latest published version at `npm install` time;
 * this matches the spike's regenerate-from-scratch lifecycle (each run
 * fresh-installs, no lockfile carry-over). For projects that DO need a
 * pin, `npm shrinkwrap` post-install is the correct tool — out of scope
 * for the validator.
 *
 * Returns an array of applied fixes:
 *   { scope, added: [pkg, ...] }
 */
export function applyDependencyDriftFixes(_workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];

  for (const { scope, packageJsonPath, missing } of issues) {
    const pkg = readPkgJson(packageJsonPath);
    if (!pkg) continue;
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
      pkg.dependencies = {};
    }
    const added = [];
    for (const name of missing) {
      // Defensive double-check — only add if still missing across all
      // four dep buckets (race-safe in case another validator wrote in
      // between scan and apply).
      const declared = new Set([
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
        ...Object.keys(pkg.peerDependencies || {}),
        ...Object.keys(pkg.optionalDependencies || {}),
      ]);
      if (declared.has(name)) continue;
      pkg.dependencies[name] = '*';
      added.push(name);
    }
    if (added.length) {
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      applied.push({ scope, added });
    }
  }
  return applied;
}
