/**
 * Minimal frontmatter parser for platform-rules and snippets.
 *
 * Supports three fence styles at the TOP of a file:
 *
 *   Markdown (.md):
 *     ---
 *     scopes: [backend]
 *     flags:  [has-users, has-admin]
 *     description: Short text
 *     ---
 *
 *   JSDoc-style (.js, .jsx, .ts, .tsx):
 *     / **
 *      * scopes: [backend]
 *      * flags:  [has-users]
 *      * description: Short text
 *      * /
 *
 *   Python docstring (.py):
 *     """
 *     scopes: [backend]
 *     flags:  [has-users]
 *     description: Short text
 *     """
 *
 * Parsed keys:
 *   - scopes       → string[]   (empty OR missing = applies to any scope)
 *   - flags        → string[]   (empty OR missing = baseline, always eligible)
 *   - description  → string     (optional human summary)
 *
 * Values in `[a, b, c]` form are parsed as arrays (trimmed). Plain strings are
 * treated as scalars. Unknown keys are ignored by the parser but surfaced by
 * lint-frontmatter as warnings.
 *
 * No dependencies — only core Node modules.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// ── Fence detection ──

const FENCES = [
  {
    // Markdown YAML-ish fence
    extensions: ['.md'],
    open:  /^---\s*\r?\n/,
    close: /\r?\n---\s*(?:\r?\n|$)/,
    stripLine: (line) => line,
  },
  {
    // JSDoc-style block at top of file
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.rs', '.css'],
    open:  /^\/\*\*?\s*\r?\n/,
    close: /\r?\n\s*\*\/\s*(?:\r?\n|$)/,
    // Strip leading " * " from each line
    stripLine: (line) => line.replace(/^\s*\*\s?/, ''),
  },
  {
    // Python module docstring (triple-double-quote or triple-single).
    extensions: ['.py'],
    open:  /^(?:"""|''')\s*\r?\n/,
    close: /\r?\n\s*(?:"""|''')\s*(?:\r?\n|$)/,
    stripLine: (line) => line,
  },
  {
    // Hash-comment header for YAML, conf, Dockerfile, shell scripts.
    // The "fence" is a contiguous block of `#`-prefixed lines at the top,
    // ending at the first non-`#`-prefixed line (blank or otherwise).
    extensions: ['.yml', '.yaml', '.conf', '.sh'],
    // Match by name too — Dockerfile and dockerfile-* have no extension we can key off.
    matchByName: (name) => /^dockerfile(?:[-.].+)?$/i.test(name),
    hashComment: true,
  },
  {
    // Dash-comment header for SQL.
    extensions: ['.sql'],
    dashComment: true,
  },
];

function fenceFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  return FENCES.find(f => {
    if (f.extensions.includes(ext)) return true;
    if (f.matchByName && f.matchByName(name)) return true;
    return false;
  }) || null;
}

/**
 * Extract a contiguous-line-prefix fence (hash-comment or dash-comment).
 * Returns { raw, start, end } or null.
 *
 * prefixPattern: RegExp for the comment-line prefix (e.g. /^#\s?/ or /^--\s?/).
 */
function extractPrefixBlock(content, prefixPattern) {
  const lines = content.split(/\r?\n/);
  const collected = [];
  let consumedBytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip shebang as first line.
    if (i === 0 && line.startsWith('#!')) {
      consumedBytes += line.length + 1;
      continue;
    }
    if (prefixPattern.test(line)) {
      collected.push(line.replace(prefixPattern, ''));
      consumedBytes += line.length + 1;
      continue;
    }
    // First non-prefix line stops the fence.
    break;
  }
  if (collected.length === 0) return null;
  return {
    raw: collected.join('\n'),
    start: 0,
    end: consumedBytes,
  };
}

// ── Value parsing ──

function parseScalar(raw) {
  const s = String(raw).trim();
  // Strip surrounding quotes if present.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(x => parseScalar(x));
  }
  return parseScalar(s);
}

// ── Public API ──

/**
 * Extract the frontmatter block from a file's raw content.
 * Returns { raw, start, end } on success, or null if no fence found.
 *   raw   — the block contents (between fences), fence markers stripped.
 *   start — byte offset of the opening fence.
 *   end   — byte offset right after the closing fence.
 */
export function extractBlock(filePath, content) {
  const fence = fenceFor(filePath);
  if (!fence) return null;

  if (fence.hashComment) return extractPrefixBlock(content, /^#\s?/);
  if (fence.dashComment) return extractPrefixBlock(content, /^--\s?/);

  const open = content.match(fence.open);
  if (!open || open.index !== 0) return null;

  const afterOpen = content.slice(open[0].length);
  const close = afterOpen.match(fence.close);
  if (!close) return null;

  const rawLines = afterOpen.slice(0, close.index).split(/\r?\n/).map(fence.stripLine);
  return {
    raw: rawLines.join('\n'),
    start: 0,
    end: open[0].length + close.index + close[0].length,
  };
}

/**
 * Parse frontmatter from a file.
 *
 * @param {string} filePath — used only to pick the fence style by extension.
 * @param {string} [content] — file contents. If omitted, reads from disk.
 * @returns {{ scopes: string[], flags: string[], description: string|null,
 *             _unknown: object, _present: boolean }}
 *
 * `_present` means the file has *opted in* to flag-driven resolution by
 * declaring `scopes:` and/or `flags:` in its frontmatter. A file with only
 * legacy JSDoc keys (SNIPPET:, CATEGORY:, etc.) is NOT considered present —
 * otherwise every pre-existing snippet would match every query.
 *
 * Rule: opt-in requires either `scopes:` or `flags:`. Description alone is
 * not enough.
 */
export function parseFrontmatter(filePath, content) {
  const src = content != null ? content : readFileSync(filePath, 'utf-8');
  const block = extractBlock(filePath, src);

  const result = {
    scopes: [],
    flags: [],
    description: null,
    _unknown: {},
    _present: false,
  };

  if (!block) return result;

  let hasScopesOrFlags = false;

  // Frontmatter is only the first contiguous run of `key: value` lines at the
  // start of the block. A blank line or any non-key:value line terminates
  // parsing — so `scopes:` buried in a usage example later in the same JSDoc
  // block will NOT be treated as frontmatter.
  for (const line of block.raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) break;  // blank line ends frontmatter
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) break;        // non-key:value line ends frontmatter
    const [, key, raw] = m;
    const value = parseValue(raw);

    if (key === 'scopes' || key === 'flags') {
      result[key] = Array.isArray(value) ? value : (value ? [value] : []);
      hasScopesOrFlags = true;
    } else if (key === 'description') {
      result.description = typeof value === 'string' ? value : String(value);
    } else {
      result._unknown[key] = value;
    }
  }

  result._present = hasScopesOrFlags;
  return result;
}

/** True when the file would apply for the given scope + flag set. */
export function matches({ scopes, flags }, { scope, flags: wantedFlags }) {
  // Scope filter: empty scopes = applies anywhere; otherwise must include.
  if (scopes.length > 0 && !scopes.includes(scope)) return false;

  // Flag filter: empty flags on the file = baseline, always eligible.
  // Otherwise file must intersect the caller's wantedFlags.
  if (flags.length === 0) return true;
  return flags.some(f => wantedFlags.includes(f));
}
