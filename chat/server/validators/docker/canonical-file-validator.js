// Pre-`compose up` static scan + fix for the bug class:
// a producing-agent's Dockerfile contains `COPY <name> ...` referencing a
// canonical platform file (e.g., `nginx.conf`), but no agent ever wrote
// that file to disk. `compose build` then fails with
// `failed to compute cache key: ... "/nginx.conf": not found`.
//
// We catch this BEFORE `compose build` via deterministic static scan
// rather than relying on prompt-side guidance, which has been observed
// to miss this bug class (a simple Dockerfile-exists check doesn't verify
// that its COPY paths resolve). Canonical-from-snippets fix is robust in
// a way that prompt edits aren't.
//
// **Anti-overrestriction guardrail:** this validator fires ONLY when the
// referenced filename is in CANONICAL_FILE_MAP — i.e., the agent's intent
// matches a platform-canonical pattern. If the Dockerfile copies a
// non-canonical name like `my-custom-config.conf`, no auto-fix; agent's
// own custom file, agent's responsibility (it'll fail honestly via the
// graceful-skip path from Step 2).
//
// Same shape as directive-validator / init-sql-validator / pgdata-validator:
// scan*(workspaceDir) → issues[]; apply*Fixes(workspaceDir, issues) → fixes[].

import fs from 'node:fs';
import path from 'node:path';

// Resolve the spike repo's root by walking up from this file's location.
// Snippets live at <repo>/snippets/. We import via relative path because
// import.meta.url lookups bring in node:url and we want to keep this file
// dependency-light (matches the existing validators' style).
const SPIKE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SNIPPETS_DIR = path.join(SPIKE_ROOT, 'snippets');

// Known canonical filenames the producing-agents may reference in COPY
// directives, mapped to their source under snippets/. The keys are the
// `COPY <name>` source path *as it appears in the Dockerfile* (typically
// relative to the build context); the value is the snippets/ path to copy
// from.
//
// Add an entry here when a new canonical-name failure pattern surfaces.
// Do NOT add non-canonical or scope-specific filenames — those should fail
// honestly via the graceful-skip path so the producing-agent's own bug is
// visible.
const CANONICAL_FILE_MAP = {
  // The Dockerfile.react template (snippets/frontend/Dockerfile.react)
  // copies `nginx.conf` into the nginx config dir. The frontend agent is
  // supposed to write `nginx.conf` (and optionally `nginx.local.conf` for
  // local dev). When integration writes the Dockerfile but no agent wrote
  // nginx.conf, fall back to the canonical production config.
  // Observed on t30 ORCH (2026-05-04 Step 5c verification gate).
  // Master keeps the canonical nginx configs at the component root
  // (frontend/nginx.conf, frontend/nginx.local.conf), whitelisted in
  // .template-manifest.yml — resolved against the repo root, not snippets/.
  'nginx.conf': { source: 'frontend/nginx.conf', scope: 'frontend' },
  // Local-dev variant. Less common (compose mounts it as a volume, doesn't
  // typically COPY it into the image), but include for symmetry.
  'nginx.local.conf': { source: 'frontend/nginx.local.conf', scope: 'frontend' },
};

// Match `COPY [--chown=...] [--from=...] <src> <dst>` and `ADD <src> <dst>`.
// Captures only the `<src>`. Skips lines where <src> is `.`, `./`, or
// contains a wildcard — those rely on .dockerignore semantics, not single-
// file presence.
const COPY_DIRECTIVE_RE = /^\s*(?:COPY|ADD)\s+(?:--[a-z]+=\S+\s+)*(\S+)\s+\S+/gim;

function parseCopySources(dockerfileContent) {
  const sources = [];
  for (const m of dockerfileContent.matchAll(COPY_DIRECTIVE_RE)) {
    const src = m[1];
    if (!src) continue;
    // Skip multi-stage `--from=` references (those are virtual paths in
    // a prior build stage, not files in the build context).
    if (m[0].includes('--from=')) continue;
    // Skip wildcards / dot-paths.
    if (src === '.' || src === './' || src.includes('*') || src.includes('?')) continue;
    sources.push(src);
  }
  return sources;
}

// Find every Dockerfile in the workspace under a scope folder. We don't
// scan root-level files — root-level Dockerfiles aren't part of the
// platform's expected layout.
function findScopeDockerfiles(workspaceDir) {
  if (!fs.existsSync(workspaceDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const scopeDir = path.join(workspaceDir, entry.name);
    // The active Dockerfile (used by compose `build:`) is just `Dockerfile`.
    // Templates like `Dockerfile.react` are inert — they don't run unless
    // copied to `Dockerfile`. We only need to validate the active one.
    const dfPath = path.join(scopeDir, 'Dockerfile');
    if (fs.existsSync(dfPath)) {
      out.push({ scope: entry.name, scopeDir, dockerfilePath: dfPath });
    }
  }
  return out;
}

/**
 * Scan workspace for Dockerfile COPY directives that reference a canonical
 * filename (per CANONICAL_FILE_MAP) where the file is missing on disk.
 *
 * @returns {Array<{scope, scopeDir, dockerfilePath, missingPath, snippetPath, copyName}>}
 */
export function scanForMissingCanonicalFiles(workspaceDir) {
  const issues = [];
  const dockerfiles = findScopeDockerfiles(workspaceDir);
  for (const { scope, scopeDir, dockerfilePath } of dockerfiles) {
    let content;
    try {
      content = fs.readFileSync(dockerfilePath, 'utf8');
    } catch {
      continue;
    }
    const sources = parseCopySources(content);
    for (const src of sources) {
      // Strip leading `./` to normalize lookup.
      const normalized = src.replace(/^\.\//, '');
      const canonical = CANONICAL_FILE_MAP[normalized];
      if (!canonical) continue;
      // Optional safety: if the canonical mapping is scope-specific and
      // the Dockerfile is in a different scope, skip (don't auto-create
      // nginx.conf inside backend/, e.g.).
      if (canonical.scope && canonical.scope !== scope) continue;
      const expectedDiskPath = path.join(scopeDir, normalized);
      if (fs.existsSync(expectedDiskPath)) continue; // agent wrote it; nothing to fix
      const snippetPath = path.join(SPIKE_ROOT, canonical.source);
      if (!fs.existsSync(snippetPath)) continue; // canonical missing in repo; can't fix
      issues.push({
        scope,
        scopeDir,
        dockerfilePath,
        missingPath: expectedDiskPath,
        snippetPath,
        copyName: normalized,
      });
    }
  }
  return issues;
}

/**
 * Apply the canonical-from-snippets fix for each issue: copy the snippet
 * file to the expected workspace path. Never overwrites an existing file
 * (the scan only emits issues where the path is missing, so this is
 * defense-in-depth).
 *
 * @returns {Array<{scope, copyName, snippet, missingPath}>}
 */
export function applyCanonicalFixes(workspaceDir, issues) {
  const applied = [];
  for (const issue of issues) {
    try {
      const content = fs.readFileSync(issue.snippetPath, 'utf8');
      fs.writeFileSync(issue.missingPath, content, { flag: 'wx' }); // never clobber a file that appeared meanwhile
      applied.push({
        scope: issue.scope,
        copyName: issue.copyName,
        snippet: path.relative(SPIKE_ROOT, issue.snippetPath),
        missingPath: path.relative(workspaceDir, issue.missingPath),
      });
    } catch {
      // ignore failures (e.g., disk full); the build will surface them.
    }
  }
  return applied;
}
