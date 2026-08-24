// esm-footgun-validator.js — catch + auto-fix CommonJS globals that crash at
// ESM runtime but pass `tsc`.
//
// When a backend is `"type": "module"`, `__dirname` / `__filename` don't exist
// at runtime — using them throws `ReferenceError: __dirname is not defined in
// ES module scope` on import, so the container exits(1) and `compose up` fails.
// But they're *valid* TypeScript with `@types/node`, so the type-gate never
// flags them (observed: ex-mediumhard backend crashed on
// `path.join(__dirname, '..', 'uploads')` at routes.js:18). This validator
// finds their use via AST and injects the standard ESM shim so the build boots.
//
// Scope: only the `__dirname`/`__filename` class — the one observed to crash
// builds, and the one with a clean, mechanical fix. `require(...)` /
// `module.exports` are the other ESM footguns but auto-rewriting them to
// import/export is risky, so they're intentionally left for a future pass.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const CJS_GLOBALS = new Set(['__dirname', '__filename']);
const SHIM_MARKER = '__esmFileURLToPath'; // presence ⇒ already shimmed

function isEsmBackend(workspaceDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'backend', 'package.json'), 'utf-8'));
    return pkg.type === 'module';
  } catch {
    return false;
  }
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (e.isFile() && SRC_RE.test(e.name)) yield abs;
  }
}

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.([cm]?ts)$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

// Which CJS globals does this source USE as a free identifier (not `x.__dirname`,
// not its own `const __dirname = …`)? Returns the names that genuinely need a
// shim, or [] when there's nothing to fix.
export function analyzeSource(text, file = 'source.ts') {
  let sf;
  try {
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(file));
  } catch {
    return []; // unparseable → fail-open
  }
  const used = new Set();
  const declared = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) && CJS_GLOBALS.has(node.text)) {
      const p = node.parent;
      const isPropName = p && ts.isPropertyAccessExpression(p) && p.name === node;
      const isDeclName = p && (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === node;
      if (isDeclName) declared.add(node.text);
      else if (!isPropName) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...used].filter((n) => !declared.has(n));
}

// Build a minimal shim declaring only what's needed (avoids redeclaring a name
// the file defines itself).
function buildShim(needs) {
  const lines = [`import { fileURLToPath as ${SHIM_MARKER} } from 'node:url';`];
  if (needs.includes('__dirname')) lines.push(`import { dirname as __esmDirname } from 'node:path';`);
  if (needs.includes('__filename')) lines.push(`const __filename = ${SHIM_MARKER}(import.meta.url);`);
  if (needs.includes('__dirname')) lines.push(`const __dirname = __esmDirname(${SHIM_MARKER}(import.meta.url));`);
  return lines.join('\n') + '\n';
}

/**
 * Scan an ESM backend for `__dirname`/`__filename` use that will crash at
 * runtime. Returns [] for non-ESM backends (CJS is fine) or when there's
 * nothing to fix.
 * @returns {Array<{file:string, needs:string[]}>}
 */
export function scanBackendForEsmFootguns(workspaceDir) {
  if (!isEsmBackend(workspaceDir)) return [];
  const backendSrc = path.join(workspaceDir, 'backend', 'src');
  const root = fs.existsSync(backendSrc) ? backendSrc : path.join(workspaceDir, 'backend');
  if (!fs.existsSync(root)) return [];

  const issues = [];
  for (const file of walk(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    if (!text.includes('__dirname') && !text.includes('__filename')) continue; // fast skip
    if (text.includes(SHIM_MARKER)) continue; // already shimmed
    const needs = analyzeSource(text, file);
    if (needs.length) issues.push({ file, needs });
  }
  return issues;
}

/**
 * Inject the ESM shim into each flagged file (after a shebang if present).
 * @returns {Array<{file:string, needs:string[]}>} the files actually fixed
 */
export function applyEsmFootgunFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];
  for (const issue of issues) {
    let text;
    try { text = fs.readFileSync(issue.file, 'utf-8'); } catch { continue; }
    if (text.includes(SHIM_MARKER)) continue; // already shimmed (defensive)
    const shim = buildShim(issue.needs);
    let out;
    if (text.startsWith('#!')) {
      const nl = text.indexOf('\n');
      out = text.slice(0, nl + 1) + shim + text.slice(nl + 1);
    } else {
      out = shim + text;
    }
    try {
      fs.writeFileSync(issue.file, out);
      applied.push({ file: issue.file, needs: issue.needs });
    } catch { /* skip unwritable */ }
  }
  return applied;
}
