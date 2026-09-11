/**
 * Single canonical path resolution for file-touching tools (W1.PATH — Section
 * L of HARNESS_EVOLUTION.md).
 *
 * `resolveWorkspacePath(input, ctx) → absolutePath` is the ONE rule every
 * file-touching tool calls at entry. The resolution rule is:
 *
 *   - Always resolve against `ctx.workspaceDir` (NEVER `process.cwd()`,
 *     NEVER an implicit per-scope cwd, NEVER a tool-local `WORKSPACE_DIR`
 *     constant — pull it through ctx so subagents and orchestrator share
 *     the same root).
 *   - Strip leading `./`, normalize `../` via `path.resolve`, collapse
 *     repeated separators.
 *   - Reject parent-directory escapes (the resolved absolute path falling
 *     outside `workspaceDir`) by throwing `PathEscapeError`.
 *
 * The thrown PathEscapeError is the defensive fast-fail for any tool that
 * doesn't (yet) plug into checkPermissions; once W1.PATH lands, the user-
 * facing surface for escapes is the `checkPermissions` deny-rule cascade in
 * `check-permissions.js`. Both layers exist so an out-of-bounds path
 * is rejected even if a caller forgot to wire up checkPermissions.
 *
 * Why no leading-`./` normalization rules in checkPermissions itself: the
 * resolver collapses them via `path.resolve`. The reconciler's advisory
 * `flagAmbiguousPaths` (see chat/server/reconciler/ambiguous-paths.js) is
 * the post-hoc surface that calls out ambiguous SHAPES (leading `./`, no
 * scope prefix) for prompt-tightening signal — not a runtime gate.
 */

import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Realpath the deepest EXISTING ancestor of `p` and rejoin the not-yet-created
 * tail. This resolves any symlink in the existing prefix (write targets don't
 * exist yet, so their final segment can't itself be a symlink). Falls back to
 * the input when nothing resolves (e.g. permission error at the root).
 */
function realpathOfExistingPrefix(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // reached filesystem root without resolving
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export class PathEscapeError extends Error {
  constructor(input, resolved, workspaceDir) {
    super(
      `Path escapes workspace: input="${input}" resolved="${resolved}" workspace="${workspaceDir}"`,
    );
    this.name = 'PathEscapeError';
    this.input = input;
    this.resolved = resolved;
    this.workspaceDir = workspaceDir;
  }
}

/**
 * Resolve a workspace-root-relative (or absolute) path string into an
 * absolute path inside `ctx.workspaceDir`. Throws PathEscapeError on
 * traversal that climbs above the workspace.
 *
 * @param {string} input - The path input from a tool's params. May be
 *   relative ("backend/src/index.ts"), have a `./` prefix, or be absolute.
 * @param {{ workspaceDir: string, scope?: string }} ctx
 * @returns {string} absolute path
 */
export function resolveWorkspacePath(input, ctx) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('resolveWorkspacePath: input must be a non-empty string');
  }
  if (!ctx || typeof ctx.workspaceDir !== 'string' || !ctx.workspaceDir) {
    throw new Error('resolveWorkspacePath: ctx.workspaceDir is required');
  }

  // Normalize backslashes to forward slashes (Windows-style input) before
  // resolving. `path.resolve` handles `./` and `../` segments and absolute
  // inputs naturally.
  const normalizedInput = input.replace(/\\/g, '/');
  const abs = path.resolve(ctx.workspaceDir, normalizedInput);

  // Defense-in-depth: confirm `abs` is still inside `workspaceDir`. A bare
  // `path.relative(workspaceDir, abs).startsWith('..')` check is the
  // canonical way to detect escape: if the relative path needs to climb,
  // it's outside.
  const rel = path.relative(ctx.workspaceDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathEscapeError(input, abs, ctx.workspaceDir);
  }

  // Symlink-aware re-check: the textual check above passes for a symlink that
  // lives INSIDE the workspace but points OUT of it. Resolve real paths and
  // confirm containment before returning.
  const realRoot = realpathOfExistingPrefix(ctx.workspaceDir);
  const realAbs = realpathOfExistingPrefix(abs);
  const realRel = path.relative(realRoot, realAbs);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new PathEscapeError(input, realAbs, ctx.workspaceDir);
  }

  return abs;
}
