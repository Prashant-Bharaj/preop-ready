/**
 * File-system tool handlers for the custom agent.
 *
 * All paths flow through `resolveWorkspacePath` (W1.PATH — single canonical
 * base, resolved against `ctx.workspaceDir`). The `sandboxPath` helper in
 * core.js stays as a back-compat alias that delegates to the same resolver.
 *
 * Each write-class tool exposes a `checkPermissions(input, ctx)` method
 * (Section E of HARNESS_EVOLUTION.md) — called by the dispatcher BEFORE
 * `call`. The default cascade (workspace escape / protected files /
 * forbidden_paths / generated_dirs / scope folder lockdown) lives in
 * `util/check-permissions.js`. Handlers emit `say/tool` events shaped for
 * [MessageBubble.jsx].
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { isSensitiveWorkspacePath } from '../../core/sensitive-paths.js';
import { relFromWorkspace, makeToolEventPayload } from './core.js';
import { resolveWorkspacePath, PathEscapeError } from './util/resolve-path.js';
import { checkWritePermission } from './util/check-permissions.js';

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB safety cap for read_file

/**
 * Resolve a path against the workspace, preferring `ctx.workspaceDir` and
 * falling back to the module-level `WORKSPACE_DIR` when callers (legacy
 * tests, internal helpers) don't thread the context. The fallback keeps
 * existing call sites working while the dispatcher migrates to always
 * pass `workspaceDir` through ctx.
 */
function resolvePath(input, ctx) {
  const workspaceDir = (ctx && ctx.workspaceDir) || WORKSPACE_DIR;
  return resolveWorkspacePath(input, { workspaceDir, scope: ctx?.scope });
}

// ── read_file ──

/**
 * Build a "file not found" error that ALSO includes a short listing of the
 * parent directory (or the nearest existing ancestor) so the model sees
 * what's actually there instead of hallucinating retry paths.
 */
function fileNotFoundWithContext(rel, abs, writtenPaths = null) {
  let parent = path.dirname(abs);
  let hops = 0;
  while (!existsSync(parent) && hops < 5) {
    parent = path.dirname(parent);
    hops++;
  }
  let context = '';
  try {
    if (existsSync(parent) && statSync(parent).isDirectory()) {
      const entries = readdirSync(parent)
        .filter(n => n !== 'node_modules' && n !== '.git')
        .sort()
        .slice(0, 40);
      const parentRel = relFromWorkspace(parent);
      if (entries.length > 0) {
        context = `\n\nParent directory (${parentRel}/) contains:\n${entries.map(e => `  ${e}`).join('\n')}`;
      } else {
        context = `\n\nParent directory (${parentRel}/) is empty.`;
      }
    }
  } catch { /* silent — best-effort context only */ }

  // If the agent loop has tracked any successful writes this run, echo them
  // here too. The model's own memory of which file it wrote is unreliable
  // (snippet-filename bias, etc.) — surfacing the real paths at the exact
  // point of failure is much more effective than hoping it reads the
  // parent-dir listing.
  if (writtenPaths instanceof Set && writtenPaths.size > 0) {
    const list = [...writtenPaths].map(p => `  ${p}`).join('\n');
    context += `\n\nFiles you wrote or edited this run (use one of these exact paths):\n${list}`;
  }

  return new Error(`File not found: ${rel}${context}`);
}

export async function toolReadFile(params, ctx) {
  const { emit, writtenPaths } = ctx || {};
  const rel = params.path;
  if (!rel) throw new Error('read_file: missing path');

  // Credentials live inside the workspace (.chat/secrets.json holds the live
  // MGA key; a workspace .env may hold MGA_API_KEY). Containment alone would
  // let a prompt-injected agent read them — deny by name/segment.
  if (isSensitiveWorkspacePath(rel)) {
    throw new Error(`read_file: access to '${rel}' is not allowed (credential/secret path)`);
  }

  const abs = resolvePath(rel, ctx);
  if (!existsSync(abs)) throw fileNotFoundWithContext(rel, abs, writtenPaths);

  // Symlink-aware re-check: the raw-path guard above misses an in-workspace
  // symlink whose name is innocuous but whose target is a secret. Re-test the
  // resolved real path (the file exists, so realpathSync succeeds).
  const wsDir = (ctx && ctx.workspaceDir) || WORKSPACE_DIR;
  if (isSensitiveWorkspacePath(path.relative(wsDir, realpathSync(abs)))) {
    throw new Error(`read_file: access to '${rel}' is not allowed (credential/secret path)`);
  }

  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`Path is a directory, use list_files: ${rel}`);
  if (st.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${st.size} bytes, max ${MAX_READ_BYTES})`);
  }

  const content = readFileSync(abs, 'utf-8');
  const lines = content.split('\n');
  const startLine = params.start_line ? Math.max(1, parseInt(params.start_line, 10)) : 1;
  const endLine = params.end_line
    ? Math.min(lines.length, parseInt(params.end_line, 10))
    : Math.min(lines.length, startLine + 1000 - 1);

  const slice = lines.slice(startLine - 1, endLine);
  const labelled = slice.map((line, i) => `${startLine + i} | ${line}`).join('\n');

  if (emit) emit(makeToolEventPayload('readFile', { path: rel }));

  return labelled;
}

// ── write_to_file ──

export async function toolWriteToFile(params, ctx) {
  const { emit } = ctx || {};
  const rel = params.path;
  const content = params.content;
  if (!rel) throw new Error('write_to_file: missing path');
  if (content === undefined) throw new Error('write_to_file: missing content');

  const abs = resolvePath(rel, ctx);

  // Idempotency short-circuit — if the file already has EXACTLY this content,
  // don't re-write. Models sometimes "refresh" their own earlier writes when
  // flipping between task and rule guidance; rewriting the same bytes burns
  // a turn with no disk change. Return a clear signal instead.
  if (existsSync(abs)) {
    try {
      const existing = readFileSync(abs, 'utf-8');
      if (existing === content) {
        if (emit) emit(makeToolEventPayload('editedExistingFile', { path: rel, content }));
        return (
          `File already at this state — no write needed. ${rel} (${content.length} chars) is unchanged.\n\n` +
          `--- Current content of ${rel} (byte-exact; use as your SEARCH reference for replace_in_file) ---\n${content}\n` +
          `--- End of ${rel} ---`
        );
      }
    } catch { /* fall through to write */ }
  }

  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');

  if (emit) emit(makeToolEventPayload('editedExistingFile', { path: rel, content }));

  return (
    `File written: ${rel} (${content.length} chars).\n\n` +
    `--- New content of ${rel} (byte-exact; use as your SEARCH reference for replace_in_file) ---\n${content}\n` +
    `--- End of ${rel} ---`
  );
}

/**
 * Per-tool permission check (W1.PATH — Section E). Returns the default
 * write cascade verdict against the resolved absolute path. The dispatcher
 * (chat/server/agent/agent.js) calls this BEFORE invoking `call`.
 */
toolWriteToFile.checkPermissions = function (params, ctx) {
  if (!params || typeof params.path !== 'string') {
    return { verdict: 'deny', reason: 'write_to_file: missing or non-string path' };
  }
  try {
    const abs = resolvePath(params.path, ctx);
    return checkWritePermission(abs, {
      workspaceDir: (ctx && ctx.workspaceDir) || WORKSPACE_DIR,
      scope: ctx?.scope,
    });
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return { verdict: 'deny', reason: err.message };
    }
    return { verdict: 'deny', reason: `write_to_file: ${err.message}` };
  }
};

// ── copy_template ──

/**
 * Deterministically copy a canonical template file into the workspace.
 *
 * Agents call this for Dockerfile + nginx.conf creation. The tool's signature
 * has no `content` parameter, so paraphrasing the canonical is structurally
 * impossible — the only way to author a Dockerfile from scratch is via
 * write_to_file, which is then an explicit choice rather than a sloppy
 * approximation of the template the platform actually expects.
 *
 * Resolution order, scope inferred from dest's first path segment:
 *   1. <workspaceDir>/<scope>/<template>           (Dockerfile.python, Dockerfile.postgres, ...)
 *   2. <workspaceDir>/snippets/<scope>/<template>  (nginx-production.conf, ...)
 *
 * If neither resolves, error out — don't fall back to invented content. That's
 * the failure mode this tool exists to prevent.
 */
export async function toolCopyTemplate(params, ctx) {
  const { emit } = ctx || {};
  const template = params.template;
  const dest = params.dest;
  if (!template) throw new Error('copy_template: missing template');
  if (!dest) throw new Error('copy_template: missing dest');

  // Resolve dest first so a path-traversal dest is rejected before we even
  // think about resolving a source. resolveWorkspacePath throws on traversal.
  const destAbs = resolvePath(dest, ctx);
  const workspaceDir = (ctx && ctx.workspaceDir) || WORKSPACE_DIR;

  const destNorm = dest.replace(/^\/+/, '');
  const scope = destNorm.split(/[\/\\]/)[0];
  if (!scope) throw new Error(`copy_template: cannot infer scope from dest "${dest}"`);

  const candidates = [
    path.join(workspaceDir, scope, template),
    path.join(workspaceDir, 'snippets', scope, template),
  ];

  let sourceAbs = null;
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isFile()) {
      sourceAbs = cand;
      break;
    }
  }

  if (!sourceAbs) {
    const tried = candidates.map(c => path.relative(workspaceDir, c)).join(', ');
    throw new Error(
      `Template '${template}' not found for scope '${scope}'. Tried: ${tried}. ` +
      `Use write_to_file with explicit content if no canonical exists.`,
    );
  }

  const content = readFileSync(sourceAbs, 'utf-8');
  const sourceRel = path.relative(workspaceDir, sourceAbs);

  if (existsSync(destAbs)) {
    try {
      const existing = readFileSync(destAbs, 'utf-8');
      if (existing === content) {
        if (emit) emit(makeToolEventPayload('copyTemplate', { template, dest, source: sourceRel, unchanged: true }));
        return `Template already at this state - no copy needed. ${dest} (${content.length} chars) is unchanged.`;
      }
    } catch { /* fall through to write */ }
  }

  mkdirSync(path.dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, content, 'utf-8');

  if (emit) emit(makeToolEventPayload('copyTemplate', { template, dest, source: sourceRel }));

  return `Template copied: ${sourceRel} -> ${dest} (${content.length} chars). ` +
    `Customize via write_to_file or replace_in_file if your app needs differ from canonical.`;
}

toolCopyTemplate.checkPermissions = function (params, ctx) {
  if (!params || typeof params.dest !== 'string') {
    return { verdict: 'deny', reason: 'copy_template: missing or non-string dest' };
  }
  try {
    const abs = resolvePath(params.dest, ctx);
    return checkWritePermission(abs, {
      workspaceDir: (ctx && ctx.workspaceDir) || WORKSPACE_DIR,
      scope: ctx?.scope,
    });
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return { verdict: 'deny', reason: err.message };
    }
    return { verdict: 'deny', reason: `copy_template: ${err.message}` };
  }
};

// ── replace_in_file ──

/**
 * Apply one or more SEARCH/REPLACE blocks. Format matches Cline:
 *
 *   <<<<<<< SEARCH
 *   (exact text to find)
 *   =======
 *   (replacement)
 *   >>>>>>> REPLACE
 */
function parseDiffBlocks(diff) {
  const blocks = [];
  const re = /<{7} SEARCH\n([\s\S]*?)\n={7}\n([\s\S]*?)\n>{7} REPLACE/g;
  let m;
  while ((m = re.exec(diff)) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
}

export async function toolReplaceInFile(params, ctx) {
  const { emit, writtenPaths } = ctx || {};
  const rel = params.path;
  const diff = params.diff;
  if (!rel) throw new Error('replace_in_file: missing path');
  if (!diff) throw new Error('replace_in_file: missing diff');

  const abs = resolvePath(rel, ctx);
  if (!existsSync(abs)) throw fileNotFoundWithContext(rel, abs, writtenPaths);

  const blocks = parseDiffBlocks(diff);
  if (blocks.length === 0) throw new Error('replace_in_file: no SEARCH/REPLACE blocks found');

  const original = readFileSync(abs, 'utf-8');
  let content = original;
  let appliedCount = 0;
  let alreadyAppliedCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    const idx = content.indexOf(search);
    if (idx === -1) {
      // Idempotency check: if SEARCH isn't found but REPLACE already is,
      // the block has already been applied. Skip without erroring.
      if (replace && content.includes(replace)) {
        alreadyAppliedCount += 1;
        continue;
      }
      // Strict-match miss: the model's SEARCH block didn't exist verbatim
      // in the file. Emit a short anchor (first 30 lines — usually covers
      // imports + signature surface) and tell the model how to recover.
      // For full content the model can call read_file (no longer stubbed
      // by MicrocompactCache for read_file). If multiple paths fail in the
      // same batch, agent.js's stale-diff recovery synthesises a fresh
      // read_file result with the complete on-disk content.
      const ANCHOR_LINES = 30;
      const fileLines = content.split('\n');
      const lineCount = fileLines.length;
      const anchor = fileLines.slice(0, ANCHOR_LINES)
        .map((l, idx) => `${String(idx + 1).padStart(4)} | ${l}`).join('\n');
      const truncNote = lineCount > ANCHOR_LINES
        ? `\n... (${lineCount - ANCHOR_LINES} more line(s) — call read_file ${rel} to see the rest)`
        : '';
      const searchPreview = search.split('\n').slice(0, 5).join('\n');
      throw new Error(
        `replace_in_file: SEARCH block ${i + 1} did not match in ${rel} ` +
        `(file has ${lineCount} line${lineCount === 1 ? '' : 's'}). ` +
        `Either retry replace_in_file with text that exists verbatim on disk, ` +
        `or use write_to_file to rewrite ${rel}.\n\n` +
        `--- Your SEARCH (first 5 lines) ---\n${searchPreview}\n\n` +
        `--- File anchor (first ${ANCHOR_LINES} lines) ---\n${anchor}${truncNote}`
      );
    }
    content = content.slice(0, idx) + replace + content.slice(idx + search.length);
    appliedCount += 1;
  }

  // If nothing changed, don't bother writing — just tell the model.
  if (content === original) {
    if (emit) emit(makeToolEventPayload('editedExistingFile', { path: rel, content }));
    return (
      `No changes — ${rel} already matches the target state (${alreadyAppliedCount} block(s) already applied).\n\n` +
      `--- Current content of ${rel} (byte-exact; use as your SEARCH reference for replace_in_file) ---\n${content}\n` +
      `--- End of ${rel} ---`
    );
  }

  writeFileSync(abs, content, 'utf-8');
  if (emit) emit(makeToolEventPayload('editedExistingFile', { path: rel, content }));

  const idemNote = alreadyAppliedCount > 0
    ? ` (${alreadyAppliedCount} block(s) were already applied; ${appliedCount} new change(s) applied)`
    : '';
  return (
    `Applied ${appliedCount} SEARCH/REPLACE block(s) to ${rel}${idemNote}.\n\n` +
    `--- New content of ${rel} (byte-exact; use as your SEARCH reference for any future replace_in_file on this file) ---\n${content}\n` +
    `--- End of ${rel} ---`
  );
}

toolReplaceInFile.checkPermissions = function (params, ctx) {
  if (!params || typeof params.path !== 'string') {
    return { verdict: 'deny', reason: 'replace_in_file: missing or non-string path' };
  }
  try {
    const abs = resolvePath(params.path, ctx);
    return checkWritePermission(abs, {
      workspaceDir: (ctx && ctx.workspaceDir) || WORKSPACE_DIR,
      scope: ctx?.scope,
    });
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return { verdict: 'deny', reason: err.message };
    }
    return { verdict: 'deny', reason: `replace_in_file: ${err.message}` };
  }
};

// ── list_files ──

export async function toolListFiles(params, ctx) {
  const { emit, writtenPaths } = ctx || {};
  const rel = params.path || '.';
  const recursive = String(params.recursive || '').toLowerCase() === 'true';
  const abs = resolvePath(rel, ctx);

  if (!existsSync(abs)) throw fileNotFoundWithContext(rel, abs, writtenPaths);
  if (!statSync(abs).isDirectory()) throw new Error(`Not a directory: ${rel}`);

  // Prefix entries with the listed dir so paths are workspace-relative and can
  // be copy-pasted into read_file / write_to_file without stripping or adding
  // a prefix. For list_files(".") we keep bare names (the workspace root is
  // already the base). For list_files("backend") we return "backend/foo" etc.
  const basePrefix = (rel === '.' || rel === '') ? '' : rel.replace(/\/+$/, '');

  const entries = [];
  function walk(dir, prefix) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const entryRel = prefix ? `${prefix}/${e.name}` : e.name;
      entries.push(e.isDirectory() ? `${entryRel}/` : entryRel);
      if (recursive && e.isDirectory()) {
        walk(path.join(dir, e.name), entryRel);
      }
    }
  }
  walk(abs, basePrefix);
  entries.sort();

  if (emit) emit(makeToolEventPayload('listFilesTopLevel', { path: rel, content: entries.slice(0, 200).join('\n') }));

  if (entries.length === 0) return `(empty: ${rel})`;
  if (entries.length > 500) return entries.slice(0, 500).join('\n') + `\n\n(truncated — showing first 500 of ${entries.length})`;
  return entries.join('\n');
}
