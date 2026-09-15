// db-credential-consistency-validator.js — deterministic pre-compose enforcement
// of the canonical local-dev credential wiring (Layer 2 of the cred fix).
//
// The bug this closes: on a fresh build the integration LLM agent sometimes
// renames the database/user to the project theme (e.g. `myapp` → `tasktracker`)
// and applies the rename to ONE service but not the other (or diverges from
// `db.ts`), so the backend authenticates against a database/user that doesn't
// exist → `password authentication failed` / `database "myapp" does not exist`
// → backend container never becomes healthy → `compose up` fails.
//
// The wiring it guarantees — the same one .platform-rules/scope-integration.md
// prescribes for hand-built apps, and the only one the pre-commit security
// check lets through (docker-compose.yml is tracked; a literal `*_PASSWORD`
// value blocks the commit):
//   • the VALUES live in the workspace-root `.env` (gitignored):
//     DATABASE_NAME/USER/PASSWORD and, with a pgvector service,
//     VECTORDB_NAME/USER/PASSWORD — written add-missing, never overwritten;
//   • the db service references them: POSTGRES_DB: ${DATABASE_NAME} …;
//   • a pgvector vectordb service references POSTGRES_*: ${VECTORDB_*};
//   • the backend loads the file (`env_file: - .env`), keeps DATABASE_HOST =
//     the db service name and DATABASE_PORT, and any inline DATABASE_* /
//     VECTORDB_* credential literal becomes the ${VAR} reference.
// Both sides read the same variable, so they cannot drift. Layer 1 (the
// synthesized DB report + scope-integration.md) tells the agents the same;
// this runs in applyAllValidators before every compose up as the backstop.
//
// Contract matches the sibling validators (scan*(workspaceDir) → issues[],
// apply*Fixes(workspaceDir, issues) → applied[]). Reads inline `environment:`
// blocks (list or object form). A db service that loads its own env_file is
// out of scope (older hand-built layout) and left alone.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LOCAL_DB_CREDENTIALS } from '../../config/defaults.js';
import {
  canonicalEnvEntries, ensureWorkspaceEnv, readEnvFile, upsertEnvFile,
  workspaceEnvPath, WORKSPACE_ENV_HEADER,
} from '../../core/workspace-env.js';

const DB_REFS = {
  POSTGRES_DB: '${DATABASE_NAME}',
  POSTGRES_USER: '${DATABASE_USER}',
  POSTGRES_PASSWORD: '${DATABASE_PASSWORD}',
};
const VECTORDB_REFS = {
  POSTGRES_DB: '${VECTORDB_NAME}',
  POSTGRES_USER: '${VECTORDB_USER}',
  POSTGRES_PASSWORD: '${VECTORDB_PASSWORD}',
};
// Backend-side credential keys that must never carry a literal value.
const BACKEND_REFS = {
  DATABASE_NAME: '${DATABASE_NAME}',
  DATABASE_USER: '${DATABASE_USER}',
  DATABASE_PASSWORD: '${DATABASE_PASSWORD}',
  VECTORDB_NAME: '${VECTORDB_NAME}',
  VECTORDB_USER: '${VECTORDB_USER}',
  VECTORDB_PASSWORD: '${VECTORDB_PASSWORD}',
};
export const WORKSPACE_ENV_FILE = '.env';

// `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?err}` all reference VAR.
function referencesVar(value, ref) {
  const name = ref.slice(2, -1);
  return new RegExp(`^\\$\\{${name}(?:[:?-][^}]*)?\\}$`).test(String(value).trim());
}

function extractEnvFromService(service) {
  // compose `environment:` accepts list-of-strings (`KEY=val`) and object form
  // (`KEY: val`). Normalize to a flat { KEY: value } object. (Mirror of the
  // helper in pgdata-validator.js — kept local; no shared util module exists.)
  const env = service?.environment;
  if (!env) return {};
  if (Array.isArray(env)) {
    const out = {};
    for (const entry of env) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      out[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
    }
    return out;
  }
  if (typeof env === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(env)) out[k] = v == null ? '' : String(v);
    return out;
  }
  return {};
}

// env_file accepts a scalar, a list of scalars, or a list of { path, required }.
function envFilePaths(service) {
  const ef = service?.env_file;
  if (ef == null) return [];
  const list = Array.isArray(ef) ? ef : [ef];
  return list
    .map((e) => (typeof e === 'string' ? e : e?.path))
    .filter((p) => typeof p === 'string')
    .map((p) => p.replace(/^\.\//, ''));
}

function isPostgresService(name, service, env) {
  if (name === 'database') return true;
  if (name === 'vectordb') return false; // pgvector is a separate store
  if (env.POSTGRES_DB != null || env.POSTGRES_USER != null || env.POSTGRES_PASSWORD != null) return true;
  const image = typeof service?.image === 'string' ? service.image.toLowerCase() : '';
  if (image.startsWith('postgres') || image.includes('/postgres')) return true;
  return false;
}

// Postgres-family detection that also covers BUILD-based services: the
// pgvector scaffold ships a `build: ./vectordb` Dockerfile rather than an
// inline `image:`, so an image-string check alone missed it. Reads the
// build-context Dockerfile's FROM (last FROM wins, multi-stage) when there's
// no inline image.
function isPostgresFamilyService(service, workspaceDir) {
  const image = typeof service?.image === 'string' ? service.image.toLowerCase() : '';
  if (image.startsWith('postgres') || image.includes('/postgres') || image.includes('pgvector')) return true;
  const buildPath = typeof service?.build === 'string' ? service.build : service?.build?.context;
  if (!buildPath || !workspaceDir) return false;
  try {
    const dockerfile = path.join(path.resolve(workspaceDir, buildPath), 'Dockerfile');
    if (!fs.existsSync(dockerfile)) return false;
    const froms = [...fs.readFileSync(dockerfile, 'utf-8').matchAll(/^\s*FROM\s+([^\s\n]+)/gim)];
    const from = froms.length ? froms[froms.length - 1][1].toLowerCase() : '';
    return from.startsWith('postgres') || from.includes('/postgres') || from.includes('pgvector');
  } catch {
    return false;
  }
}

function isBackendService(name, service) {
  if (name === 'backend') return true;
  const dep = service?.depends_on;
  if (!dep) return false;
  if (Array.isArray(dep)) return dep.some((d) => d === 'database' || d === 'db');
  if (typeof dep === 'object') return Boolean(dep.database || dep.db);
  return false;
}

// Present-but-wrong is rewritten to the reference; MISSING is added (postgres
// refuses to initialize without POSTGRES_PASSWORD, which kills compose up
// outright; observed live). Services that load their own env_file or use
// trust auth keep their creds out of compose — out of scope. Returns the
// literal values found ({ VAR: value }) so the env file can be seeded with
// what the database volume was actually initialised with.
function pushPostgresRefs(rewrites, name, service, env, refs) {
  const literals = {};
  if (envFilePaths(service).length || env.POSTGRES_HOST_AUTH_METHOD != null) return literals;
  for (const [key, ref] of Object.entries(refs)) {
    if (env[key] == null) rewrites.push({ service: name, key, from: null, to: ref, add: true });
    else if (!referencesVar(env[key], ref)) {
      rewrites.push({ service: name, key, from: env[key], to: ref });
      if (!/^\$\{/.test(String(env[key])) && String(env[key]).trim() !== '') literals[ref.slice(2, -1)] = String(env[key]).trim();
    }
  }
  return literals;
}

/**
 * Find every deviation from the canonical wiring. Returns a flat array of
 * rewrites:
 *   { service, key, from, to [, add] }        compose environment entry
 *   { service, key: 'env_file', to: '.env' }  backend must load the env file
 *   { file: '.env', key, from: null, to, add } missing value in the env file
 * Empty when there's no inline db+backend pair or everything already matches.
 */
export function scanComposeForCredentialDrift(workspaceDir) {
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];

  let compose;
  try {
    compose = YAML.parse(fs.readFileSync(composePath, 'utf-8'));
  } catch {
    return [];
  }
  const services = compose?.services;
  if (!services || typeof services !== 'object') return [];

  // Locate the primary Postgres service + the backend service.
  let dbName = null;
  let dbEnv = null;
  let backendName = null;
  let backendEnv = null;
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object') continue;
    const env = extractEnvFromService(service);
    if (dbName == null && isPostgresService(name, service, env)) {
      dbName = name;
      dbEnv = env;
    }
    if (backendName == null && isBackendService(name, service)) {
      backendName = name;
      backendEnv = env;
    }
  }
  if (!dbName || !backendName) return []; // nothing to reconcile

  const c = LOCAL_DB_CREDENTIALS;
  const rewrites = [];

  // db service: POSTGRES_* → ${DATABASE_*}
  const literals = pushPostgresRefs(rewrites, dbName, services[dbName], dbEnv, DB_REFS);

  // Any OTHER postgres-family service is the dedicated vector store; its
  // container creds are a separate set (VECTORDB_*) — the integration agent
  // sometimes copies the primary-DB creds onto it (observed live: `password
  // authentication failed for user "vector_user"` on the first embedding
  // insert). Postgres-family is detected from `image:` OR, for the
  // build-based pgvector scaffold, the build-context Dockerfile's FROM.
  let hasVectordb = false;
  for (const [name, service] of Object.entries(services)) {
    if (name === dbName || !service || typeof service !== 'object') continue;
    if (!isPostgresFamilyService(service, workspaceDir)) continue;
    const env = extractEnvFromService(service);
    if (envFilePaths(service).length || env.POSTGRES_HOST_AUTH_METHOD != null) continue;
    hasVectordb = true;
    Object.assign(literals, pushPostgresRefs(rewrites, name, service, env, VECTORDB_REFS));
  }

  // backend service: HOST must equal the db service name (that's how it
  // resolves on the compose network), PORT the constant, and no credential
  // literal — the values arrive through env_file.
  const backendExpect = { DATABASE_HOST: dbName, DATABASE_PORT: String(c.port) };
  for (const [key, want] of Object.entries(backendExpect)) {
    if (backendEnv[key] != null && backendEnv[key] !== want) {
      rewrites.push({ service: backendName, key, from: backendEnv[key], to: want });
    }
  }
  for (const [key, ref] of Object.entries(BACKEND_REFS)) {
    if (backendEnv[key] != null && !referencesVar(backendEnv[key], ref)) {
      rewrites.push({ service: backendName, key, from: backendEnv[key], to: ref });
      // A db-side literal is only trusted when the backend carried the SAME
      // value — that pair was actually working. A disagreement is the drift
      // bug itself (db renamed, backend not): fall back to the canonical value.
      if (literals[key] != null && String(backendEnv[key]).trim() !== literals[key]) delete literals[key];
    }
  }
  if (!envFilePaths(services[backendName]).includes(WORKSPACE_ENV_FILE)) {
    rewrites.push({ service: backendName, key: 'env_file', from: null, to: WORKSPACE_ENV_FILE, add: true });
  }

  // The env file itself: every referenced value must exist (add-missing only).
  // A literal that was just turned into a reference wins over the canonical
  // value: an existing database volume was initialised with it, and switching
  // the value would break authentication on the next start (hand-built apps
  // adopting the layout; harness apps already carry the canonical values).
  const have = readEnvFile(workspaceEnvPath(workspaceDir));
  for (const [key, value] of Object.entries(canonicalEnvEntries({ database: true, vectordb: hasVectordb }))) {
    if (have[key] == null) rewrites.push({ file: WORKSPACE_ENV_FILE, key, from: null, to: literals[key] ?? value, add: true });
  }

  return rewrites;
}

// Locate a SERVICE block by anchoring on the `services:`-child indent, so a
// nested key of the same name (e.g. `depends_on:\n  database:`) is never
// mistaken for the service header. Returns { headerIdx, blockEnd, headerIndent }
// or null.
function findServiceBlock(lines, serviceName) {
  let servicesIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*services:\s*$/.test(lines[i])) { servicesIdx = i; break; }
  }
  if (servicesIdx === -1) return null;
  let serviceIndent = null;
  for (let i = servicesIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ind = lines[i].match(/^(\s*)/)[1];
    if (ind.length === 0) return null; // a top-level key — services had no children
    serviceIndent = ind;
    break;
  }
  if (serviceIndent == null) return null;
  const esc = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^${serviceIndent}${esc}:\\s*$`);
  let headerIdx = -1;
  for (let i = servicesIdx + 1; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return null;
  let blockEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].startsWith(`${serviceIndent} `)) { blockEnd = i; break; }
  }
  return { headerIdx, blockEnd, headerIndent: serviceIndent };
}

/**
 * Insert `KEY=value` into a service's `environment:` block, matching the
 * block's existing entry style (list vs object); creates the block right
 * after the service header when absent. Returns the new text, or null when
 * the service header can't be located.
 */
function insertEnvEntry(text, serviceName, key, value) {
  const lines = text.split('\n');
  const blk = findServiceBlock(lines, serviceName);
  if (!blk) return null;
  const { headerIdx, blockEnd, headerIndent } = blk;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    if (!/^\s+environment:\s*$/.test(lines[i])) continue;
    const next = lines[i + 1] || '';
    const nextIsEntry = i + 1 < blockEnd && next.trim().length > 0;
    const entryIndent = nextIsEntry ? next.match(/^(\s*)/)[1] : `${headerIndent}    `;
    const objectStyle = nextIsEntry && !/^\s*-\s/.test(next);
    lines.splice(i + 1, 0, objectStyle ? `${entryIndent}${key}: ${value}` : `${entryIndent}- ${key}=${value}`);
    return lines.join('\n');
  }
  lines.splice(headerIdx + 1, 0, `${headerIndent}  environment:`, `${headerIndent}    - ${key}=${value}`);
  return lines.join('\n');
}

/**
 * Make `env_file:` on a service list `item` first. Handles the three shapes
 * compose accepts — block list (appends an item), inline flow list
 * (`env_file: [a, b]`) and scalar (`env_file: ./a`, converted to a block
 * list) — and creates the key right after the service header when absent.
 * Returns the new text, or null when the service header can't be located.
 */
function insertEnvFileItem(text, serviceName, item) {
  const lines = text.split('\n');
  const blk = findServiceBlock(lines, serviceName);
  if (!blk) return null;
  const { headerIdx, blockEnd, headerIndent } = blk;
  for (let i = headerIdx + 1; i < blockEnd; i++) {
    const m = lines[i].match(/^(\s+)env_file:[ \t]*(.*)$/);
    if (!m) continue;
    const [, indent, rest] = m;
    if (rest.trim() === '') {
      const next = lines[i + 1] || '';
      const entryIndent = next.trim().startsWith('-') ? next.match(/^(\s*)/)[1] : `${indent}  `;
      lines.splice(i + 1, 0, `${entryIndent}- ${item}`);
    } else if (rest.trim().startsWith('[')) {
      lines[i] = `${indent}env_file: [${item}, ${rest.trim().slice(1).replace(/^\s*/, '')}`.replace(/\[\.env, \]$/, '[.env]');
    } else {
      lines.splice(i, 1, `${indent}env_file:`, `${indent}  - ${item}`, `${indent}  - ${rest.trim()}`);
    }
    return lines.join('\n');
  }
  lines.splice(headerIdx + 1, 0, `${headerIndent}  env_file:`, `${headerIndent}    - ${item}`);
  return lines.join('\n');
}

// Replace `key`'s value ONLY within `serviceName`'s block. The earlier global
// regex assumed POSTGRES_* keys were unique to the database service; once the
// vectordb service also carries them (with a DIFFERENT target — e.g. database
// POSTGRES_USER=myapp_user vs vectordb POSTGRES_USER=vector_user), a global
// replace clobbered the wrong service. Block-scope the replacement instead.
function replaceEnvEntryInService(text, serviceName, key, value) {
  const lines = text.split('\n');
  const blk = findServiceBlock(lines, serviceName);
  if (!blk) return { text, changed: false };
  const listRe = new RegExp(`^(\\s*-\\s*${key}\\s*=).*$`);
  const objRe = new RegExp(`^(\\s*${key}\\s*:[ \\t]*).*$`);
  let changed = false;
  for (let i = blk.headerIdx + 1; i < blk.blockEnd; i++) {
    if (listRe.test(lines[i])) { lines[i] = lines[i].replace(listRe, `$1${value}`); changed = true; }
    else if (objRe.test(lines[i])) { lines[i] = lines[i].replace(objRe, `$1${value}`); changed = true; }
  }
  return { text: lines.join('\n'), changed };
}

/**
 * Apply the rewrites: regex-edit the compose YAML source text (both
 * `- KEY=val` and `KEY: val` forms) to preserve formatting — mirrors
 * applyEnvVarNamingFixes — and add the missing values to the env file.
 */
export function applyCredentialConsistencyFixes(workspaceDir, rewrites) {
  if (!rewrites.length) return [];
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  let text;
  try {
    text = fs.readFileSync(composePath, 'utf-8');
  } catch {
    return [];
  }

  const applied = [];
  let modified = text;
  const envEntries = {};
  let envFileAdded = false;
  for (const r of rewrites) {
    if (r.file === WORKSPACE_ENV_FILE) { envEntries[r.key] = r.to; applied.push(r); continue; }
    if (r.key === 'env_file') {
      const next = insertEnvFileItem(modified, r.service, r.to);
      if (next != null) { modified = next; applied.push(r); envFileAdded = true; }
      continue;
    }
    if (r.add) {
      const next = insertEnvEntry(modified, r.service, r.key, r.to);
      if (next != null) { modified = next; applied.push(r); }
      continue;
    }
    // Block-scoped replace (POSTGRES_* is no longer service-unique — the
    // vectordb service carries its own set with different target values).
    const { text: next, changed } = replaceEnvEntryInService(modified, r.service, r.key, r.to);
    if (changed) { modified = next; applied.push(r); }
  }

  if (modified !== text) {
    fs.writeFileSync(composePath, modified, 'utf-8');
  }
  if (Object.keys(envEntries).length) {
    upsertEnvFile(workspaceEnvPath(workspaceDir), envEntries, { header: WORKSPACE_ENV_HEADER });
  } else if (envFileAdded) {
    ensureWorkspaceEnv(workspaceDir); // the file must exist for compose to load it
  }
  return applied;
}
