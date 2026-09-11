/**
 * MCP tool handlers as plain functions. The MCP stdio server wraps these
 * in the `{ content: [{type, text}] }` envelope; our in-process custom
 * agent calls them directly and gets back raw text.
 *
 * Each handler returns a string (or JSON string for structured tools).
 * Throws on unknown tool names — callers decide how to surface errors.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveContext } from './resolve-context.js';
import { WORKSPACE_DIR as DEFAULT_WORKSPACE_DIR } from '../core/paths.js';
import {
  parseProjectStatus,
  getRecentCommits,
  hasUncommittedChanges,
} from '../agent/context/env-context.js';
import { appendSnippetFetch } from '../util/telemetry-snippets.js';

// ── Configuration ──

/**
 * Resolve workspace dir. Env var wins (Docker + MCP server child process).
 * Next: caller-provided override. Final fallback: paths.js default so in-process
 * callers (our custom agent) can omit the option entirely.
 */
function resolveWorkspaceDir(override) {
  return process.env.WORKSPACE_DIR || override || DEFAULT_WORKSPACE_DIR;
}

// ── Name → file mapping for rules (same list as mcp-server.js) ──

// Maps friendly rule ids → files in the CANONICAL `.platform-rules/` tree
// (master's scheme: 00-global / 01-common / 02-security / scope-* / reference/*).
// This is the harness's single-source link to the same tree the tool adapters
// are generated from. Ids the harness once had but master folded away
// (migration → journey; error-recovery → troubleshooting; ai-file-input →
// file-handling; api-keys → secrets-and-keys) resolve to their master home.
export const RULE_FILE_MAP = {
  backend:     'scope-backend.md',
  frontend:    'scope-frontend.md',
  database:    'scope-database.md',
  vectordb:    'scope-vectordb.md',
  integration: 'scope-integration.md',

  common:            '01-common.md',
  'common-patterns': '01-common.md',
  global:            '00-global.md',
  security:          '02-security.md',

  verify: 'verify-checklist.md',

  troubleshooting:      'reference/troubleshooting.md',
  'error-recovery':     'reference/troubleshooting.md',
  'file-handling':      'reference/file-handling.md',
  'ai-file-input':      'reference/file-handling.md',
  secrets:              'reference/secrets-and-keys.md',
  'api-keys':           'reference/secrets-and-keys.md',
  'status-tracking':    'reference/status-tracking.md',
  'user-identity':      'reference/user-identity.md',
  'sensitive-files':    'reference/sensitive-files.md',
  deployment:           'reference/deployment.md',
  'testing-local':      'reference/testing-local.md',
  'background-commands':'reference/testing-local.md',
  urls:                 'reference/testing-local.md',
  'ai-features':        'reference/ai-features.md',
  journey:              'reference/journey.md',
  migration:            'reference/journey.md',
  'microsoft-365':      'reference/microsoft-365.md',
};

export const AVAILABLE_RULES = Object.keys(RULE_FILE_MAP).sort().join(', ');

export const KNOWN_SCOPES = ['backend', 'frontend', 'database', 'vectordb', 'integration'];

// ── Handlers ──

export function getRules(name, { workspaceDir } = {}) {
  const ws = resolveWorkspaceDir(workspaceDir);
  // Accept either a short name ("backend") or the filename the prompt-builder
  // happens to suggest ("scope-backend.md", "reference/urls.md", etc.) since
  // the MCP hint section sometimes shows filenames. We try, in order:
  //   (a) exact match on short name
  //   (b) filename without .md extension as short name
  //   (c) reverse lookup: is `name` itself a value in RULE_FILE_MAP?
  let filename = RULE_FILE_MAP[name];
  if (!filename) {
    const stripped = name.replace(/\.md$/, '');
    filename = RULE_FILE_MAP[stripped];
  }
  if (!filename) {
    const byValue = Object.entries(RULE_FILE_MAP).find(([, v]) => v === name);
    if (byValue) filename = byValue[1];
  }
  if (!filename) return `Unknown rule: "${name}". Available: ${AVAILABLE_RULES}`;

  const filePath = path.join(ws, '.platform-rules', filename);
  if (!existsSync(filePath)) return `Rule file not found: ${filename}`;
  return readFileSync(filePath, 'utf-8');
}

export function listSnippets({ workspaceDir } = {}) {
  const ws = resolveWorkspaceDir(workspaceDir);
  const indexPath = path.join(ws, 'snippets', 'INDEX.md');
  if (existsSync(indexPath)) return readFileSync(indexPath, 'utf-8');
  return listSnippetFiles(ws);
}

export function getSnippet(snippetPath, opts = {}) {
  const { workspaceDir, sessionId = null, scope = null, phase = null } = opts;
  const ws = resolveWorkspaceDir(workspaceDir);
  const normalized = path.normalize(snippetPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return `Invalid path: "${snippetPath}"`;
  }

  let filePath = path.join(ws, 'snippets', normalized);
  // TS-convergence tolerance: the template is TypeScript, so a request for a
  // pruned .js/.jsx snippet resolves to its .ts/.tsx twin when that exists.
  if (!existsSync(filePath) && /\.(js|jsx)$/.test(normalized)) {
    const tsTwin = path.join(ws, 'snippets', normalized.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts'));
    if (existsSync(tsTwin)) filePath = tsTwin;
  }
  if (!existsSync(filePath)) {
    // Path-overlap correction: if the requested path doesn't resolve under
    // snippets/ but DOES exist as a workspace file, the agent likely meant
    // to use read_file (the workspace-tool) but reached for get_snippet (the
    // platform-tool). Both have `frontend/`, `backend/`, `database/` subtrees
    // with similar filenames; without something in the path itself signaling
    // which root applies, agents drift between tools.
    //
    // Return a directive synthetic error pointing at read_file so the agent
    // self-corrects within the same run. Same shape as other in-code safety
    // nets (directive-validator, init-sql-validator, etc.).
    //
    // Only fires when the workspace file genuinely exists — we don't want to
    // mislead the agent if both lookups would fail.
    const workspaceFile = path.join(ws, normalized);
    if (existsSync(workspaceFile)) {
      return (
        `ERROR: "${snippetPath}" is not a platform snippet (no file at ` +
        `snippets/${snippetPath}), but this path DOES exist in your workspace. ` +
        `Use <read_file><path>${snippetPath}</path></read_file> to read ` +
        `workspace files. get_snippet is ONLY for fetching from the platform's ` +
        `snippets/ directory; read_file is for the workspace.`
      );
    }
    return `Snippet not found: "${snippetPath}".\n\n${listSnippetFiles(ws)}`;
  }
  const content = readFileSync(filePath, 'utf-8');
  // W3.TEL Section M item 3 — structured per-fetch line at
  // <workspaceDir>/.harness/snippet-fetches.jsonl. Context (sessionId,
  // scope, phase) is threaded by the agent loop's tool dispatcher
  // (toolUseMcpTool in agent/tools/exec-tools.js) which already has those
  // on its ctx. See chat/server/util/telemetry-snippets.js for the Path-A
  // tradeoff discussion.
  //
  // `source` is 'disk' today: the handler has no caching layer (every call
  // existsSync + readFileSync). Reserved for a future memoize layer.
  let sizeBytes = null;
  try { sizeBytes = statSync(filePath).size; } catch { /* size is best-effort */ }
  appendSnippetFetch(ws, {
    sessionId,
    scope,
    phase,
    snippetPath: normalized,
    sizeBytes,
    source: 'disk',
  });
  return content;
}

export function searchSnippets(query, { workspaceDir } = {}) {
  const ws = resolveWorkspaceDir(workspaceDir);
  const indexPath = path.join(ws, 'snippets', 'INDEX.md');
  const searchBase = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf-8')
    : listSnippetFiles(ws);

  const lowerQuery = query.toLowerCase();
  const matches = searchBase.split('\n').filter(line => line.toLowerCase().includes(lowerQuery));

  if (matches.length === 0) {
    return `No snippets matched "${query}". Try: list_snippets to see all available snippets.`;
  }
  return `Snippets matching "${query}":\n\n${matches.join('\n')}`;
}

export function resolveContextHandler({ flags, scope }, { workspaceDir } = {}) {
  const ws = resolveWorkspaceDir(workspaceDir);
  const result = resolveContext({ flags, scope, workspaceDir: ws });
  return JSON.stringify(result, null, 2);
}

export function readProjectStatus() {
  const info = {
    projectStatus: parseProjectStatus(),
    recentCommits: getRecentCommits(),
    hasUncommittedChanges: hasUncommittedChanges(),
  };
  return JSON.stringify(info, null, 2);
}

export function getEnvironment({ workspaceDir } = {}) {
  const ws = resolveWorkspaceDir(workspaceDir);
  const info = {
    workspaceDir: ws,
    environment: process.env.CODESPACES === 'true' ? 'codespaces' : 'local',
    components: {},
  };

  for (const comp of ['frontend', 'backend', 'database', 'vectordb']) {
    const dir = path.join(ws, comp);
    info.components[comp] = existsSync(dir) && hasContentBeyondTemplates(dir);
  }

  const statusPath = path.join(ws, 'docs', 'PROJECT_STATUS.md');
  if (existsSync(statusPath)) {
    try {
      const content = readFileSync(statusPath, 'utf-8');
      const ideaMatch = content.match(/##\s*Idea\s*\n+(.*?)(?=\n#|\n$)/s);
      const stackMatch = content.match(/##\s*Stack\s*\n+(.*?)(?=\n#|\n$)/s);
      if (ideaMatch) info.idea = ideaMatch[1].trim();
      if (stackMatch) info.stack = stackMatch[1].trim();
    } catch { /* skip */ }
  }

  return JSON.stringify(info, null, 2);
}

// ── Helpers ──

function listSnippetFiles(workspaceDir) {
  const snippetsDir = path.join(workspaceDir, 'snippets');
  if (!existsSync(snippetsDir)) return 'No snippets directory found.';

  const files = [];
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'INDEX.md' || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files.push(rel);
    }
  }
  walk(snippetsDir);
  return files.length > 0
    ? 'Available snippets:\n' + files.map(f => `- ${f}`).join('\n')
    : 'No snippets found.';
}

function hasContentBeyondTemplates(dir) {
  try {
    const entries = readdirSync(dir);
    const nonTemplate = entries.filter(e =>
      !e.startsWith('Dockerfile.') && e !== 'init' && e !== '.gitkeep'
    );
    return nonTemplate.length > 0;
  } catch { return false; }
}

/**
 * Dispatch an MCP tool call by name. Used by the in-process agent.
 * Returns the raw string result; throws for unknown tools.
 */
export function callMcpTool(toolName, args = {}, opts = {}) {
  switch (toolName) {
    case 'get_rules':           return getRules(args.name, opts);
    case 'list_snippets':       return listSnippets(opts);
    case 'get_snippet':         return getSnippet(args.path, opts);
    case 'search_snippets':     return searchSnippets(args.query, opts);
    case 'resolve_context':     return resolveContextHandler(args, opts);
    case 'read_project_status': return readProjectStatus();
    case 'get_environment':     return getEnvironment(opts);
    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}
