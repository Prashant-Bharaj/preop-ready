/**
 * Reconciler advisory sanity check (W1.PATH — Section L item 5).
 *
 * Scans the set of paths written during a build and flags entries with
 * shapes that "look ambiguous" — leading `./`, parent-dir traversal, or
 * no scope prefix. NOT load-bearing: by the time a write made it through
 * `resolveWorkspacePath` + `checkWritePermission`, the file landed in the
 * right place. This sanity check exists purely as a prompt-tightening
 * signal: if subagents are routinely emitting ambiguous-shape paths, the
 * prompt-level "workspace-root-relative" rule isn't sinking in.
 *
 * Wired into the reconciler in chat/server/session/docker-orchestration.js;
 * emits one `[path-sanity]` tlog line per entry. Output is informational —
 * the build never blocks on this check.
 */

const KNOWN_SCOPES = new Set([
  'backend',
  'frontend',
  'database',
  'vectordb',
  'integration',
  // Common workspace-root files (no scope, but unambiguous).
  // Listed here so `docker-compose.yml`, `README.md`, etc. don't
  // generate a noisy "no scope prefix" flag.
]);

const KNOWN_ROOT_FILES = new Set([
  'docker-compose.yml',
  'docker-compose.yaml',
  'README.md',
]);

const KNOWN_ROOT_DIRS = new Set([
  'snippets',
  '.harness',
  '.platform-rules',
  '.clinerules',
]);

/**
 * @param {Array<string> | Set<string>} writtenPaths - Workspace-relative
 *   paths that were written during the run (as recorded in `writtenPaths`).
 * @returns {{ ambiguous: Array<{ path: string, reason: string }> }}
 */
export function flagAmbiguousPaths(writtenPaths) {
  const list = Array.isArray(writtenPaths)
    ? writtenPaths
    : (writtenPaths instanceof Set ? [...writtenPaths] : []);

  const ambiguous = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const reasons = [];

    if (raw.startsWith('./')) {
      reasons.push('leading "./" — drop it; paths are workspace-root-relative');
    }
    if (raw.split(/[\/\\]/).includes('..')) {
      reasons.push('parent-directory traversal segment ("..") — disallowed');
    }

    // No scope prefix? Tolerate known root files / dirs (docker-compose.yml,
    // .env.example, snippets/...). Otherwise flag.
    const firstSeg = raw.replace(/^\.\//, '').split(/[\/\\]/)[0];
    const isKnownScope = KNOWN_SCOPES.has(firstSeg);
    const isKnownRootFile = KNOWN_ROOT_FILES.has(raw);
    const isKnownRootDir = KNOWN_ROOT_DIRS.has(firstSeg);
    if (!isKnownScope && !isKnownRootFile && !isKnownRootDir) {
      reasons.push(`no scope prefix (first segment "${firstSeg}" is not a known scope or root file)`);
    }

    if (reasons.length > 0) {
      ambiguous.push({ path: raw, reason: reasons.join('; ') });
    }
  }

  return { ambiguous };
}
