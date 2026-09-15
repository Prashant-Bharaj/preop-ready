/**
 * workspace-env.js — the workspace-root `.env` (gitignored) that docker-compose
 * reads for `${VAR}` interpolation and that the backend service loads via
 * `env_file`. Every credential the local stack needs lives here, never in
 * docker-compose.yml: the pre-commit security check blocks a compose file
 * with literal `*_PASSWORD` values, and .platform-rules/scope-integration.md
 * prescribes the same layout for hand-built apps.
 *
 * Writers: pre-stage (DATABASE_* / VECTORDB_* canonical values), the
 * credential validator (heals the file before every compose up) and MGA
 * provisioning (MGA_* lines). All go through `upsertEnvFile` so unrelated
 * lines and comments survive.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_DB_CREDENTIALS, LOCAL_VECTORDB_CREDENTIALS } from '../config/defaults.js';

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export const WORKSPACE_ENV_HEADER = '# Local development credentials — gitignored, never committed.';

export function workspaceEnvPath(workspaceDir) {
  return path.join(workspaceDir, '.env');
}

/** Parse a dotenv-style file into { KEY: value }. Missing/unreadable → {}. */
export function readEnvFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return {}; }
  const out = {};
  for (const line of text.split('\n')) {
    const m = ENV_LINE_RE.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Merge `entries` ({ KEY: value }) into the file. Existing keys are replaced
 * in place, new keys appended, every other line kept. `dropPrefix` removes
 * any existing line whose key starts with that prefix before merging (MGA
 * provisioning replaces the whole MGA_* set). Returns the keys written.
 */
export function upsertEnvFile(filePath, entries, { dropPrefix = null, header = null } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
  } catch { /* no file yet */ }
  if (dropPrefix) {
    lines = lines.filter((l) => {
      const m = ENV_LINE_RE.exec(l);
      return !(m && m[1].startsWith(dropPrefix));
    });
  }
  const pending = new Map(Object.entries(entries).filter(([, v]) => v != null));
  const written = [];
  lines = lines.map((l) => {
    const m = ENV_LINE_RE.exec(l);
    if (!m || !pending.has(m[1])) return l;
    const key = m[1];
    const next = `${key}=${pending.get(key)}`;
    pending.delete(key);
    if (next !== l.trim()) written.push(key);
    return next;
  });
  for (const [key, value] of pending) {
    lines.push(`${key}=${value}`);
    written.push(key);
  }
  if (header && lines.length === written.length) lines.unshift(header);
  if (!written.length && fs.existsSync(filePath)) return written;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n') + '\n', { mode: 0o600 });
  return written;
}

/**
 * The canonical local-dev values a compose file references through
 * `${DATABASE_*}` / `${VECTORDB_*}`. Values, not names: names are the
 * platform's fixed env-var contract (auto-injected in production).
 */
export function canonicalEnvEntries({ database = false, vectordb = false } = {}) {
  const entries = {};
  if (database) {
    entries.DATABASE_NAME = LOCAL_DB_CREDENTIALS.name;
    entries.DATABASE_USER = LOCAL_DB_CREDENTIALS.user;
    entries.DATABASE_PASSWORD = LOCAL_DB_CREDENTIALS.password;
  }
  if (vectordb) {
    entries.VECTORDB_NAME = LOCAL_VECTORDB_CREDENTIALS.name;
    entries.VECTORDB_USER = LOCAL_VECTORDB_CREDENTIALS.user;
    entries.VECTORDB_PASSWORD = LOCAL_VECTORDB_CREDENTIALS.password;
  }
  return entries;
}

/**
 * Guarantee the workspace `.env` exists and carries every canonical key the
 * stack needs. Keys already present keep their value — a database volume was
 * initialised with whatever the file said at first start, and both the db
 * service and the backend read the same variable, so they stay consistent
 * by construction. Returns { path, added: [keys] }.
 */
export function ensureWorkspaceEnv(workspaceDir, { database = false, vectordb = false } = {}) {
  const filePath = workspaceEnvPath(workspaceDir);
  const have = readEnvFile(filePath);
  const missing = {};
  for (const [k, v] of Object.entries(canonicalEnvEntries({ database, vectordb }))) {
    if (have[k] == null) missing[k] = v;
  }
  const added = upsertEnvFile(filePath, missing, { header: WORKSPACE_ENV_HEADER });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `${WORKSPACE_ENV_HEADER}\n`, { mode: 0o600 });
  return { path: filePath, added };
}

/**
 * The credentials the app's database container was actually started with:
 * the workspace `.env` values, falling back to the canonical ones for any key
 * it lacks. Harness code that runs `psql` inside that container must use
 * this, not the constants — a hand-built app keeps its own values.
 */
export function workspaceDbCredentials(workspaceDir) {
  const env = readEnvFile(workspaceEnvPath(workspaceDir));
  return {
    ...LOCAL_DB_CREDENTIALS,
    name: env.DATABASE_NAME || LOCAL_DB_CREDENTIALS.name,
    user: env.DATABASE_USER || LOCAL_DB_CREDENTIALS.user,
    password: env.DATABASE_PASSWORD || LOCAL_DB_CREDENTIALS.password,
  };
}
