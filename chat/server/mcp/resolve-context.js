/**
 * Shared resolve_context implementation.
 *
 * Used by the backend flag resolver in chat/server/agent/flag-resolver.js.
 *
 * Walks .platform-rules/ and snippets/, reads each file's frontmatter
 * (scopes, flags), and returns the set that matches the caller's
 * { flags, scope } intent:
 *
 *   - A file's `scopes` must be empty OR include the requested scope.
 *   - A file's `flags` must be empty (baseline, always eligible) OR
 *     intersect the requested flags.
 *
 * Files without frontmatter (`_present: false`) are NOT returned —
 * they opt out of flag-driven resolution. Use list_snippets / get_snippet
 * to reach them directly.
 */

import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, matches } from './frontmatter.js';

// Files the walkers should ignore.
const SKIP_FILES = new Set(['INDEX.md', 'README.md', '.gitkeep']);

// File extensions the frontmatter parser can handle. Everything else is
// skipped (unsupported fence style = untaggable = not participating).
const SUPPORTED_RULE_EXTS = new Set(['.md']);
const SUPPORTED_SNIPPET_EXTS = new Set([
  '.md', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rs',
  '.css', '.yml', '.yaml', '.conf', '.sh', '.sql',
]);

const DOCKERFILE_NAME = /^dockerfile(?:[-.].+)?$/i;

function isSupported(name, allowedExts) {
  const ext = path.extname(name).toLowerCase();
  if (allowedExts.has(ext)) return true;
  if (DOCKERFILE_NAME.test(name)) return true; // hash-comment fence
  return false;
}

function walkTagged(root, allowedExts) {
  if (!existsSync(root)) return [];
  const out = [];
  (function inner(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_FILES.has(entry.name) || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        inner(abs, rel);
      } else if (isSupported(entry.name, allowedExts)) {
        out.push({ rel, abs });
      }
    }
  })(root);
  return out;
}

/**
 * Resolve context for a single (flags, scope) pair.
 *
 * @param {object} args
 * @param {string[]} args.flags — active feature flags for this task.
 * @param {string}   args.scope — one of backend/frontend/database/vectordb/integration.
 * @param {string}   args.workspaceDir — repo root; .platform-rules/ and
 *                                       snippets/ live under this.
 * @returns {{ rules: string[], snippets: string[] }}
 */
export function resolveContext({ flags, scope, workspaceDir }) {
  const flagList = Array.isArray(flags) ? flags : [];

  const platformRulesDir = path.join(workspaceDir, '.platform-rules');
  const snippetsDir = path.join(workspaceDir, 'snippets');

  const rules = [];
  for (const { rel, abs } of walkTagged(platformRulesDir, SUPPORTED_RULE_EXTS)) {
    const fm = parseFrontmatter(abs);
    if (fm._present && matches(fm, { scope, flags: flagList })) {
      rules.push(rel);
    }
  }

  const snippets = [];
  for (const { rel, abs } of walkTagged(snippetsDir, SUPPORTED_SNIPPET_EXTS)) {
    const fm = parseFrontmatter(abs);
    if (fm._present && matches(fm, { scope, flags: flagList })) {
      snippets.push(rel);
    }
  }

  rules.sort();
  snippets.sort();

  return { rules, snippets };
}
