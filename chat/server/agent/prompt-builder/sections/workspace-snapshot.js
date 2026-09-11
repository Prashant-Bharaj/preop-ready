import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../../../core/paths.js';

/**
 * Walk the scope folders and produce a concise recursive listing. Used to
 * inject a `=== WORKSPACE SNAPSHOT ===` section into the task prompt so the
 * model can't invent file names that aren't on disk. Skipped directories:
 * node_modules, .git, common build caches.
 */
export function buildWorkspaceSnapshot(scopes) {
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv', '.DS_Store']);
  const MAX_ENTRIES = 200; // per scope, truncate if huge
  const lines = ['=== WORKSPACE SNAPSHOT ===',
    'Live filesystem state at task start. Source of truth — trust this over your memory when they conflict.',
    ''];

  for (const scope of scopes) {
    const abs = path.join(WORKSPACE_DIR, scope);
    lines.push(`--- ${scope}/ ---`);
    if (!existsSync(abs)) {
      lines.push('(does not exist yet)');
      lines.push('');
      continue;
    }
    const entries = [];
    (function walk(dir, rel = '') {
      let children;
      try { children = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of children) {
        if (SKIP.has(e.name)) continue;
        const entryRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          entries.push(`${entryRel}/`);
          walk(path.join(dir, e.name), entryRel);
        } else {
          entries.push(entryRel);
        }
        if (entries.length >= MAX_ENTRIES) return;
      }
    })(abs);
    entries.sort();
    if (entries.length === 0) {
      lines.push('(empty)');
    } else {
      for (const e of entries.slice(0, MAX_ENTRIES)) lines.push(`  ${e}`);
      if (entries.length > MAX_ENTRIES) lines.push(`  … (${entries.length - MAX_ENTRIES} more entries truncated)`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
