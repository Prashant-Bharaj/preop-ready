// db-credential-consistency-validator.js — deterministic pre-compose enforcement
// of the canonical local-dev DB connection identity (Layer 2 of the cred fix).
//
// The bug this closes: on a fresh build the integration LLM agent sometimes
// renames the database/user to the project theme (e.g. `myapp` → `tasktracker`)
// and applies the rename to ONE service but not the other (or diverges from
// `db.ts`), so the backend authenticates against a database/user that doesn't
// exist → `password authentication failed` / `database "myapp" does not exist`
// → backend container never becomes healthy → `compose up` fails.
//
// Layer 1 (the synthesized DB report + .platform-rules/common.md) tells the
// agents the fixed values; this validator GUARANTEES them: it rewrites the
// db service's POSTGRES_{DB,USER,PASSWORD} and the backend service's
// DATABASE_{NAME,USER,PASSWORD,HOST,PORT} to one authoritative set before
// `compose up`, regardless of what the LLM wrote. Pure JS + YAML parse, runs
// in the existing applyAllValidators pass — no extra `compose up`, ~ms cost.
//
// Contract matches the sibling validators (scan*(workspaceDir) → issues[],
// apply*Fixes(workspaceDir, issues) → applied[]). Reads inline `environment:`
// blocks (list or object form). Creds hidden in an `env_file` are out of scope
// here (Layer 1 covers that path).

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { LOCAL_DB_CREDENTIALS } from '../../config/defaults.js';

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

/**
 * Find any DB-credential value that deviates from LOCAL_DB_CREDENTIALS (or where
 * the backend points at the wrong host/port). Returns a flat array of rewrites:
 *   { service, key, from, to }
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

  // db service: POSTGRES_* → canonical (present-but-wrong is rewritten,
  // MISSING is added — postgres refuses to initialize without
  // POSTGRES_PASSWORD, which kills compose up outright; observed live).
  const dbExpect = { POSTGRES_DB: c.name, POSTGRES_USER: c.user, POSTGRES_PASSWORD: c.password };
  for (const [key, want] of Object.entries(dbExpect)) {
    if (dbEnv[key] != null && dbEnv[key] !== String(want)) {
      rewrites.push({ service: dbName, key, from: dbEnv[key], to: String(want) });
    } else if (dbEnv[key] == null && dbEnv.POSTGRES_HOST_AUTH_METHOD == null && services[dbName]?.env_file == null) {
      // env_file-fed services keep their creds out of compose — out of scope.
      rewrites.push({ service: dbName, key, from: null, to: String(want), add: true });
    }
  }

  // Any OTHER postgres-family service (vectordb — excluded from the primary-DB
  // reconciliation above) is a SEPARATE store, but its container creds
  // (POSTGRES_{DB,USER,PASSWORD}) must still match what the backend connects
  // with (VECTORDB_{NAME,USER,PASSWORD}) — the backend is authoritative, its
  // values come from the contract + env wiring. The integration agent sometimes
  // copies the primary-DB creds onto the vectordb service instead of the
  // backend's VECTORDB_* target (observed live: vectordb POSTGRES_USER=myapp_user
  // vs backend VECTORDB_USER=vector_user → `password authentication failed for
  // user "vector_user"` on the first embedding insert). Align the container to
  // the backend; when the backend declares no VECTORDB_* target, fall back to
  // just guaranteeing a password so the container can start (postgres exits(1)
  // without POSTGRES_PASSWORD/POSTGRES_HOST_AUTH_METHOD). Postgres-family is
  // detected from `image:` OR, for the build-based pgvector scaffold, the
  // build-context Dockerfile's FROM.
  for (const [name, service] of Object.entries(services)) {
    if (name === dbName || !service || typeof service !== 'object') continue;
    if (!isPostgresFamilyService(service, workspaceDir)) continue;
    const env = extractEnvFromService(service);
    if (service.env_file != null || env.POSTGRES_HOST_AUTH_METHOD != null) continue; // creds out of scope
    const align = {
      POSTGRES_DB: backendEnv.VECTORDB_NAME,
      POSTGRES_USER: backendEnv.VECTORDB_USER,
      POSTGRES_PASSWORD: backendEnv.VECTORDB_PASSWORD || String(c.password),
    };
    let alignedAny = false;
    for (const [key, want] of Object.entries(align)) {
      if (want == null) continue; // backend didn't declare this dimension
      alignedAny = true;
      if (env[key] != null && env[key] !== String(want)) {
        rewrites.push({ service: name, key, from: env[key], to: String(want) });
      } else if (env[key] == null) {
        rewrites.push({ service: name, key, from: null, to: String(want), add: true });
      }
    }
    if (!alignedAny && env.POSTGRES_PASSWORD == null) {
      rewrites.push({ service: name, key: 'POSTGRES_PASSWORD', from: null, to: String(c.password), add: true });
    }
  }

  // backend service: DATABASE_* → canonical. HOST must equal the db service
  // name (that's how it resolves on the compose network); others to constant.
  const backendExpect = {
    DATABASE_HOST: dbName,
    DATABASE_PORT: String(c.port),
    DATABASE_NAME: c.name,
    DATABASE_USER: c.user,
    DATABASE_PASSWORD: c.password,
  };
  for (const [key, want] of Object.entries(backendExpect)) {
    if (backendEnv[key] != null && backendEnv[key] !== String(want)) {
      rewrites.push({ service: backendName, key, from: backendEnv[key], to: String(want) });
    }
  }

  return rewrites;
}

/**
 * Rewrite each drifted value in docker-compose.yml to the canonical value.
 * Regex-edits the YAML source text (both `- KEY=val` and `KEY: val` forms) to
 * preserve formatting — mirrors applyEnvVarNamingFixes. The POSTGRES and
 * DATABASE keys are service-unique, so per-key replacement is unambiguous.
 */
/**
 * Insert `KEY=value` into a service's `environment:` block, matching the
 * block's existing entry style (list vs object); creates the block right
 * after the service header when absent. Returns the new text, or null when
 * the service header can't be located.
 */
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
  for (const r of rewrites) {
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
  return applied;
}
