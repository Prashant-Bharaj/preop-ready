#!/usr/bin/env node
/**
 * Frontmatter lint for platform-rules and snippets.
 *
 * Fails (exit 1) when:
 *   - A supported file (extension in SUPPORTED_EXTS) has no frontmatter
 *     scopes: or flags: declaration.
 *   - A `flags:` value is not listed in KNOWN_FLAGS.
 *   - A `scopes:` value is not listed in KNOWN_SCOPES.
 *
 * Warns (no exit) when:
 *   - Unknown frontmatter keys appear.
 *
 * Skips (not flagged):
 *   - Files with extensions the parser does not support: .yml, .yaml, .conf,
 *     .sql, .css, extensionless (Dockerfiles). These are still useful to
 *     Cline via get_snippet but cannot participate in flag-driven resolution.
 *   - INDEX.md, README.md, .gitkeep.
 *
 * Usage:
 *   node chat/scripts/lint-frontmatter.js
 *   node chat/scripts/lint-frontmatter.js --verbose
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../server/mcp/frontmatter.js';
import { knownFlagNames } from '../server/mcp/known-flags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SUPPORTED_EXTS = new Set([
  '.md', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs',
  '.css', '.yml', '.yaml', '.conf', '.sh', '.sql',
]);
// File names (no extension) that our parser can tag via hash-comment fence.
const SUPPORTED_NAMES = (name) => /^dockerfile(?:[-.].+)?$/i.test(name);
const SKIP_FILES = new Set(['INDEX.md', 'README.md', '.gitkeep']);
const KNOWN_SCOPES = new Set(['backend', 'frontend', 'database', 'vectordb', 'integration']);
const KNOWN_FLAGS = new Set(knownFlagNames());

const ROOTS = [
  { dir: path.join(REPO_ROOT, '.platform-rules'), label: '.platform-rules' },
  { dir: path.join(REPO_ROOT, 'snippets'),         label: 'snippets' },
];

const verbose = process.argv.includes('--verbose');

function walk(dir, prefix = '', out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_FILES.has(entry.name) || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else {
      out.push({ rel, abs, ext: path.extname(entry.name).toLowerCase() });
    }
  }
  return out;
}

const errors = [];
const warnings = [];
let checked = 0;
let skipped = 0;
let passed = 0;

for (const root of ROOTS) {
  for (const { rel, abs, ext } of walk(root.dir)) {
    const pretty = `${root.label}/${rel}`;
    const baseName = path.basename(rel);
    const supported = SUPPORTED_EXTS.has(ext) || SUPPORTED_NAMES(baseName);
    if (!supported) {
      skipped++;
      if (verbose) console.error(`[lint]  SKIP  ${pretty} (unsupported ext ${ext})`);
      continue;
    }
    checked++;

    const fm = parseFrontmatter(abs);

    if (!fm._present) {
      errors.push({ file: pretty, reason: 'missing frontmatter — add `scopes:` and/or `flags:` header' });
      continue;
    }

    for (const s of fm.scopes) {
      if (!KNOWN_SCOPES.has(s)) {
        errors.push({ file: pretty, reason: `unknown scope "${s}" — known: ${[...KNOWN_SCOPES].sort().join(', ')}` });
      }
    }
    for (const f of fm.flags) {
      if (!KNOWN_FLAGS.has(f)) {
        errors.push({ file: pretty, reason: `unknown flag "${f}" — see chat/server/mcp/known-flags.js` });
      }
    }

    const unknownKeys = Object.keys(fm._unknown);
    if (unknownKeys.length > 0) {
      // Filter the legacy SNIPPET: / CATEGORY: / STATUS: keys — they're informational, not errors.
      const flagged = unknownKeys.filter(k =>
        !['SNIPPET', 'CATEGORY', 'LANGUAGE', 'STATUS', 'DESCRIPTION', 'DEPENDENCIES', 'RELATED', 'USAGE', 'EXAMPLE'].includes(k)
        && !/^[a-z]/i.test(k) === false // allow camelCase variable names
      );
      if (flagged.length > 0) {
        warnings.push({ file: pretty, reason: `unknown keys: ${flagged.join(', ')}` });
      }
    }

    if (errors.find(e => e.file === pretty)) continue;
    passed++;
    if (verbose) console.error(`[lint]  OK    ${pretty} scopes=[${fm.scopes.join(',')}] flags=[${fm.flags.join(',')}]`);
  }
}

if (warnings.length > 0) {
  console.error('\nWarnings:');
  for (const w of warnings) console.error(`  ${w.file}: ${w.reason}`);
}

if (errors.length > 0) {
  console.error('\nErrors:');
  for (const e of errors) console.error(`  ${e.file}: ${e.reason}`);
  console.error(`\n[lint] FAILED — checked=${checked} passed=${passed} errors=${errors.length} warnings=${warnings.length} skipped=${skipped}`);
  process.exit(1);
}

console.error(`[lint] OK — checked=${checked} passed=${passed} warnings=${warnings.length} skipped=${skipped}`);
process.exit(0);
