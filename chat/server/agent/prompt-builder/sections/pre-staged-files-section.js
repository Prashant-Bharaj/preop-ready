/**
 * Build the "=== PRE-STAGED FILES ===" section: scaffold-first content
 * the runtime emitted into the workspace BEFORE this subagent spawned.
 *
 * Why this exists: when the subagent uses `replace_in_file`, its SEARCH
 * block must match file content byte-for-byte. Without inlining the
 * current content here, the LLM composes SEARCH from memory (or worse,
 * from a microcompact stub of an earlier `read_file` result). Those drift
 * from disk → SEARCH mismatch → wasted turn. With current content visible
 * in the user message, the LLM has an authoritative reference from turn 1.
 *
 * Scope-filtering: only include files relevant to the current scope. For
 * `backend`, that's everything under `backend/`. For `frontend`, under
 * `frontend/`. For `database`, under `database/`. Generated contracts.ts
 * is INCLUDED for backend + frontend so they see the shared types.
 *
 * Size guardrail: cap total emitted content at ~50KB to prevent runaway
 * token bloat on large contracts. Per-file truncation marker added when
 * the file would push past the cap.
 */

const TOTAL_CAP_CHARS = 50_000;
const PER_FILE_HINT_TRUNC = '\n…(file continues — read backend/src/file.ts for full content)';

/**
 * @param {Array<{relPath: string, content: string}>} files
 * @param {string} scope - the subagent's scope (backend / frontend / database / ...)
 * @returns {string} empty string when no files apply
 */
export function buildPreStagedFilesSection(files, scope) {
  if (!Array.isArray(files) || files.length === 0) return '';
  if (!scope || typeof scope !== 'string') return '';

  const scopePrefix = `${scope}/`;
  // Backend + frontend both consume contracts.ts (shared types). Anything
  // else stays scope-prefixed.
  const isShared = (relPath) =>
    relPath === `${scope}/src/generated/contracts.ts` // backend
    || relPath === `${scope}/generated/contracts.ts`  // python equivalent
    || relPath === `${scope}/src/generated/contracts.ts`; // frontend

  const relevant = files.filter(
    (f) => f && typeof f.relPath === 'string'
      && (f.relPath.startsWith(scopePrefix) || isShared(f.relPath))
  );
  if (relevant.length === 0) return '';

  const lines = [];
  lines.push('=== PRE-STAGED FILES (already on disk; this is the AUTHORITATIVE content) ===');
  lines.push('');
  lines.push(
    'The runtime wrote these files into your workspace before you spawned. ' +
    'They are the scaffold-first foundation: types come from the contract, route ' +
    'registrations are pre-built, helpers exist where needed. **The contents ' +
    'shown here are exactly what `read_file` would return** — when you compose a ' +
    '`replace_in_file` SEARCH block, copy from BELOW, not from memory.'
  );
  lines.push('');

  let used = 0;
  for (const f of relevant) {
    const header = `--- ${f.relPath} ---\n`;
    const body = typeof f.content === 'string' ? f.content : '';
    const remaining = TOTAL_CAP_CHARS - used - header.length;
    if (remaining <= 0) {
      lines.push(`--- ${f.relPath} ---`);
      lines.push('(omitted — total pre-staged content exceeds inline cap; use read_file)');
      lines.push('');
      continue;
    }
    if (body.length <= remaining) {
      lines.push(`--- ${f.relPath} ---`);
      lines.push(body);
      lines.push('');
      used += header.length + body.length;
    } else {
      lines.push(`--- ${f.relPath} ---`);
      lines.push(body.slice(0, Math.max(0, remaining - PER_FILE_HINT_TRUNC.length)) + PER_FILE_HINT_TRUNC);
      lines.push('');
      used = TOTAL_CAP_CHARS; // stop further inlining
    }
  }

  return lines.join('\n');
}
