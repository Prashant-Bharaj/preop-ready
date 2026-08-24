/**
 * Per-tool `checkPermissions` default cascade (W1.PATH — Section E of
 * HARNESS_EVOLUTION.md).
 *
 * `checkWritePermission(absPath, ctx) → { verdict, reason }` is the rule
 * cascade every write-class tool calls before doing IO. Order matters —
 * first deny wins.
 *
 * Cascade (in order):
 *   (a) Workspace escape — defensive redundant check (resolveWorkspacePath
 *       already throws PathEscapeError; this catches callers that bypass it).
 *   (b) Protected files — `.github/workflows/`, `.template-version`,
 *       `.template-manifest.yml`, `.gitignore`, `.env*`.
 *   (c) `forbidden_paths` from `.harness/contracts.json#file_structure[scope]`
 *       — the W1.STATE wrong-language deny (Python backend forbids
 *       `backend/src/index.ts`; Node backend forbids `backend/main.py`).
 *   (d) `generated_dirs` — the harness-managed type-generator output
 *       (`backend/src/generated/`, `backend/generated/`, `frontend/src/generated/`).
 *       Replaces the temporary W1.TYPES.GEN inline deny in agent.js.
 *   (e) Scope folder lockdown — when `ctx.scope` is set (subagent context),
 *       writes must land under `<scope>/`. One agreed carve-out:
 *       `backend/vectordb-connections.ts` is written by the `vectordb`
 *       scope per chat/prompts/subagent-vectordb.md.
 *   (f) Default — allow.
 *
 * Verdict shape (Section E): `{ verdict: 'allow'|'deny'|'ask', reason }`.
 * W1.PATH ships only `allow` and `deny`; the `ask` slot is reserved for the
 * Phase 3 investigator-confirm flow. If `ask` is somehow returned today, the
 * dispatcher treats it as deny defensively.
 *
 * Contracts read cache: forbidden_paths needs the contracts envelope on
 * every write. Per-workspace memoize so a single agent turn doesn't re-stat
 * + re-parse the JSON on every tool call. `invalidateContractsCache` is
 * called from `setOrchestrationContext` when a new plan finalizes and
 * rewrites contracts.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readContracts } from '../../../session/harness-state.js';

const PROTECTED_FILE_PATTERNS = [
  // Workspace-relative path PREFIXES (string-prefix match — directories) or
  // glob-style names (handled below).
  { kind: 'prefix', value: '.github/workflows/' },
  { kind: 'exact',  value: '.template-version' },
  { kind: 'exact',  value: '.template-manifest.yml' },
  { kind: 'exact',  value: '.gitignore' },
  // `.env`, `.env.local`, `.env.example`, etc — glob via prefix on basename.
  // BUT: `.env.example` is template-distributable + agent-edited (snippets/integration
  // ships one). The agent SHOULD be able to write it. Excluded from the deny
  // list by basename match below.
  { kind: 'env-glob', value: '.env' },
];

const GENERATED_DIRS = [
  'backend/src/generated/',
  'backend/generated/',
  'frontend/src/generated/',
];

// Pre-staged platform lib files the LLM must import, never rewrite. The
// MGA transport + AI helpers are emitted deterministically (mga-client-
// generator.js, embed-helper-generator.js, vector-search-helper-generator.js);
// hand-rolled replacements/duplicates were the top AI-app failure mode.
const PLATFORM_LOCKED_FILES = new Set([
  'backend/src/lib/mga-client.ts',
  'backend/src/mga_client.py',
  'backend/src/lib/embed.ts',
  'backend/src/lib/vector-search.ts',
  'backend/src/lib/oidc-identity.ts',
  'backend/src/oidc_identity.py',
]);

// Cross-scope carve-outs — agreed paths that a scope may write outside its
// own folder. Documented in the matching chat/prompts/subagent-*.md.
//   - vectordb writes backend/vectordb-connections.ts (connection helper
//     consumed by backend).
//   - integration writes workspace-root infra files (docker-compose.yml,
//     .env.example) AND frontend/nginx.local.conf (the proxy wiring file
//     that integration co-owns with frontend, per scope-integration.md).
const SCOPE_CROSS_WRITE_CARVEOUTS = new Map([
  ['vectordb', new Set(['backend/vectordb-connections.ts'])],
  ['integration', new Set([
    'docker-compose.yml',
    'docker-compose.yaml',
    '.env.example',
    'frontend/nginx.conf',
    'frontend/nginx.local.conf',
  ])],
]);

const contractsCache = new Map(); // workspaceDir → { ts, contracts }
const CONTRACTS_CACHE_TTL_MS = 60_000; // refresh after 1 min even if not invalidated

/**
 * Invalidate the cached contracts for a workspace. Called when
 * `setOrchestrationContext` writes a new contracts.json.
 */
export function invalidateContractsCache(workspaceDir) {
  if (workspaceDir) contractsCache.delete(workspaceDir);
  else contractsCache.clear();
}

function getCachedContracts(workspaceDir) {
  const now = Date.now();
  const hit = contractsCache.get(workspaceDir);
  if (hit && (now - hit.ts) < CONTRACTS_CACHE_TTL_MS) return hit.contracts;
  let contracts = null;
  try {
    contracts = readContracts(workspaceDir);
  } catch {
    contracts = null;
  }
  contractsCache.set(workspaceDir, { ts: now, contracts });
  return contracts;
}

function workspaceRelative(absPath, workspaceDir) {
  return path.relative(workspaceDir, absPath).replace(/\\/g, '/');
}

function isProtectedFile(relPath) {
  // Normalize: relPath is workspace-relative, no leading `./`.
  const base = path.basename(relPath);
  for (const rule of PROTECTED_FILE_PATTERNS) {
    if (rule.kind === 'prefix') {
      if (relPath === rule.value || relPath.startsWith(rule.value)) {
        return { matched: true, pattern: rule.value };
      }
    } else if (rule.kind === 'exact') {
      if (relPath === rule.value) {
        return { matched: true, pattern: rule.value };
      }
    } else if (rule.kind === 'env-glob') {
      // `.env`, `.env.local`, `.env.production`, ... — but exempt `.env.example`
      // (template-distributable + agent-edited).
      if (base === '.env' || (base.startsWith('.env.') && base !== '.env.example')) {
        // Also allow nested .env files like `backend/.env.local` if they appear,
        // but at workspace root they're protected — both agent and human paths
        // tend to keep the canonical .env at the root. Be conservative: protect
        // any `.env*` write at any depth, except `.env.example`.
        return { matched: true, pattern: '.env*' };
      }
    }
  }
  return { matched: false };
}

function isInGeneratedDir(relPath) {
  for (const dir of GENERATED_DIRS) {
    if (relPath === dir.slice(0, -1) || relPath.startsWith(dir)) {
      return { matched: true, pattern: dir };
    }
  }
  return { matched: false };
}

function isForbiddenByContracts(relPath, scope, workspaceDir) {
  if (!scope) return { matched: false };
  const envelope = getCachedContracts(workspaceDir);
  const fileStructure = envelope?.data?.fileStructure;
  if (!fileStructure || typeof fileStructure !== 'object') return { matched: false };
  const scopeRules = fileStructure[scope];
  if (!scopeRules || !Array.isArray(scopeRules.forbidden_paths)) return { matched: false };
  for (const forbidden of scopeRules.forbidden_paths) {
    if (typeof forbidden !== 'string') continue;
    if (relPath === forbidden) {
      return { matched: true, pattern: forbidden, contractField: `file_structure.${scope}.forbidden_paths` };
    }
  }
  return { matched: false };
}

function isOutsideScopeFolder(relPath, scope) {
  if (!scope) return { matched: false };
  const prefix = `${scope}/`;
  if (relPath === scope || relPath.startsWith(prefix)) {
    return { matched: false };
  }
  // Carve-outs — agreed cross-scope writes.
  const carveouts = SCOPE_CROSS_WRITE_CARVEOUTS.get(scope);
  if (carveouts && carveouts.has(relPath)) {
    return { matched: false };
  }
  return { matched: true };
}

/**
 * The default write-permission cascade. Tool-level `checkPermissions`
 * methods call this with the already-resolved absolute path.
 *
 * @param {string} absPath - Absolute path inside `ctx.workspaceDir`.
 * @param {{ workspaceDir: string, scope?: string }} ctx
 * @returns {{ verdict: 'allow'|'deny'|'ask', reason: string | null }}
 */
export function checkWritePermission(absPath, ctx) {
  if (!ctx || typeof ctx.workspaceDir !== 'string') {
    // Defensive: missing context = deny. Tools should always set workspaceDir.
    return { verdict: 'deny', reason: 'checkPermissions: ctx.workspaceDir is required' };
  }

  const relPath = workspaceRelative(absPath, ctx.workspaceDir);

  // (a) Workspace escape — redundant with resolveWorkspacePath, but cheap.
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return {
      verdict: 'deny',
      reason: `Path escapes workspace: ${absPath}`,
    };
  }

  // (b) Protected files.
  const prot = isProtectedFile(relPath);
  if (prot.matched) {
    return {
      verdict: 'deny',
      reason:
        `Path '${relPath}' is a protected platform file (pattern: ${prot.pattern}). ` +
        `These files are owned by the platform/template-sync workflow; ` +
        `subagents and the orchestrator must not modify them.`,
    };
  }

  // (c) forbidden_paths from contracts (the wrong-language deny).
  const forbidden = isForbiddenByContracts(relPath, ctx.scope, ctx.workspaceDir);
  if (forbidden.matched) {
    return {
      verdict: 'deny',
      reason:
        `Path '${relPath}' is listed under '${forbidden.contractField}' in ` +
        `.harness/contracts.json — this scope's chosen language/framework ` +
        `does not use this file. Write to the entry your scope owns instead ` +
        `(see file_structure.${ctx.scope}.entry / required_files).`,
    };
  }

  // (d) generated_dirs — harness-managed; type generator owns these.
  const gen = isInGeneratedDir(relPath);
  if (gen.matched) {
    return {
      verdict: 'deny',
      reason:
        `Path is in the harness-managed generated/ directory; the type ` +
        `generator owns these files. Edit .harness/contracts.json instead.`,
    };
  }

  // (d2) platform-locked lib files — pre-staged, import-only. Only locked
  // when the pre-stage actually emitted them (file on disk); flows without
  // pre-staging may still create the file themselves.
  if (PLATFORM_LOCKED_FILES.has(relPath) && fs.existsSync(absPath)) {
    return {
      verdict: 'deny',
      reason:
        `${relPath} is a pre-staged platform helper — import it ` +
        `(see its header for usage); do not rewrite, replace, or write a parallel version of it.`,
    };
  }

  // (e) Scope folder lockdown.
  const outsideScope = isOutsideScopeFolder(relPath, ctx.scope);
  if (outsideScope.matched) {
    return {
      verdict: 'deny',
      reason:
        `Scope '${ctx.scope}' may only write under '${ctx.scope}/' ` +
        `(attempted: '${relPath}'). Cross-scope writes are coordinated by ` +
        `the orchestrator — emit attempt_completion describing the cross-scope ` +
        `need so the orchestrator can dispatch the correct scope.`,
    };
  }

  // (f) Default — allow.
  return { verdict: 'allow', reason: null };
}
