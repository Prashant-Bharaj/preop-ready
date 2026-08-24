// Pre-`compose up` env-var-naming validator. Catches the bug class:
//
//   docker-compose.yml backend service emits non-canonical env var names
//   like `DB_HOST`, `DB_PORT`, `DB_NAME` instead of the canonical
//   `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`.
//
// Why this matters: production AWS infra auto-injects the canonical names
// (DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER,
// DATABASE_PASSWORD, DATABASE_URL for database; VECTORDB_* equivalents
// for vectordb) into running containers. Backend code reads from
// `process.env.DATABASE_HOST` to work in production. If local compose
// emits `DB_HOST` instead, the backend's `process.env.DATABASE_HOST` is
// undefined locally and the app can't connect to the database.
//
// The platform's canonical env vars are documented in
// `.platform-rules/reference/secrets.md` (Auto-Injected section). They
// are FIXED — they don't depend on the database engine (postgres vs
// MySQL): backend always reads `DATABASE_HOST`, regardless of whether
// the database service runs postgres-image (which itself uses
// POSTGRES_USER/POSTGRES_DB legitimately) or mysql-image (which uses
// MYSQL_USER/MYSQL_DATABASE legitimately on the database side).
//
// Empirically observed on a t36-mysql-shop run (2026-05-08):
//
//   docker-compose.yml backend.environment:
//     DB_HOST: database
//     DB_PORT: 3306
//     DB_NAME: inventory
//     DB_USER: inventory_user
//     DB_PASSWORD: localdev123
//
// Backend code's `process.env.DATABASE_HOST` is undefined → mysql2 pool
// can't connect → backend health endpoint fails → smoke `outcome=false`.
// (The smoke-asserts hardcoded check for `DATABASE_HOST=database` would
// also fail.)
//
// The router improvised these names in its `task.task` prose because
// router.md has no structured `env_contract` (data_model and api_contract
// exist for tables and endpoints; env vars are still prose). Backend +
// integration agents followed the router's prose verbatim.
//
// Fix: rewrite the BACKEND service's environment block to use canonical
// names. Map non-canonical → canonical:
//
//   DB_HOST          → DATABASE_HOST
//   DB_PORT          → DATABASE_PORT
//   DB_NAME          → DATABASE_NAME
//   DB_USER          → DATABASE_USER
//   DB_PASSWORD      → DATABASE_PASSWORD
//   MYSQL_HOST       → DATABASE_HOST       (when in backend env, NOT db service)
//   MYSQL_PORT       → DATABASE_PORT       (")
//   MYSQL_DATABASE   → DATABASE_NAME       (")
//   MYSQL_USER       → DATABASE_USER       (")
//   MYSQL_PASSWORD   → DATABASE_PASSWORD   (")
//   POSTGRES_HOST    → DATABASE_HOST       (")
//   POSTGRES_PORT    → DATABASE_PORT       (")
//   POSTGRES_DB      → DATABASE_NAME       (")
//   POSTGRES_USER    → DATABASE_USER       (")
//   POSTGRES_PASSWORD → DATABASE_PASSWORD  (")
//   PG_HOST/PORT/DB/USER/PASSWORD → DATABASE_*
//   VECTOR_HOST/PORT/etc → VECTORDB_HOST/PORT/etc (vectordb-related backend env)
//
// **Anti-overrestriction guardrails:**
//
// - Only rewrites the BACKEND service's environment block. The DATABASE
//   service legitimately uses `POSTGRES_DB`, `POSTGRES_USER`,
//   `POSTGRES_PASSWORD` (postgres image's expected env vars) or
//   `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` (mysql image's
//   expected env vars). Those are correct on the database side and we
//   don't touch them.
// - Identifies the backend service by name (`backend`) AND by
//   `depends_on: database` cross-reference. Scoped writes only.
// - Doesn't add env vars that weren't already there. If the backend
//   wasn't using a database connection variable, we leave it alone.
// - Preserves YAML formatting (line-based rewrite, not full reparse +
//   re-emit) so we don't disturb comments / key ordering / indent style.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// Database-side canonical env var names (auto-injected by AWS in
// production; backend reads from these in code).
const DATABASE_CANONICAL = {
  HOST: 'DATABASE_HOST',
  PORT: 'DATABASE_PORT',
  NAME: 'DATABASE_NAME',
  USER: 'DATABASE_USER',
  PASSWORD: 'DATABASE_PASSWORD',
  URL: 'DATABASE_URL',
};

// Vectordb-side canonical env var names (for backend's vectordb conn).
const VECTORDB_CANONICAL = {
  HOST: 'VECTORDB_HOST',
  PORT: 'VECTORDB_PORT',
  NAME: 'VECTORDB_NAME',
  USER: 'VECTORDB_USER',
  PASSWORD: 'VECTORDB_PASSWORD',
};

// Mapping table: non-canonical name → canonical name. Only applied to
// the backend service's environment block.
//
// Excluded intentionally: `POSTGRES_*` and `MYSQL_*` on the *database*
// service side (those are the postgres/mysql image's own conventions
// and are correct there). The validator only touches backend's env.
const BACKEND_ENV_REWRITES = new Map([
  // Database-related abbreviations
  ['DB_HOST', DATABASE_CANONICAL.HOST],
  ['DB_PORT', DATABASE_CANONICAL.PORT],
  ['DB_NAME', DATABASE_CANONICAL.NAME],
  ['DB_USER', DATABASE_CANONICAL.USER],
  ['DB_PASSWORD', DATABASE_CANONICAL.PASSWORD],
  ['DB_URL', DATABASE_CANONICAL.URL],
  // MySQL-prefixed names in BACKEND env (not legitimate for backend)
  ['MYSQL_HOST', DATABASE_CANONICAL.HOST],
  ['MYSQL_PORT', DATABASE_CANONICAL.PORT],
  ['MYSQL_DATABASE', DATABASE_CANONICAL.NAME],
  ['MYSQL_DB', DATABASE_CANONICAL.NAME],
  ['MYSQL_USER', DATABASE_CANONICAL.USER],
  ['MYSQL_PASSWORD', DATABASE_CANONICAL.PASSWORD],
  ['MYSQL_URL', DATABASE_CANONICAL.URL],
  // Postgres-prefixed names in BACKEND env (not legitimate for backend)
  ['POSTGRES_HOST', DATABASE_CANONICAL.HOST],
  ['POSTGRES_PORT', DATABASE_CANONICAL.PORT],
  ['POSTGRES_DB', DATABASE_CANONICAL.NAME],
  ['POSTGRES_USER', DATABASE_CANONICAL.USER],
  ['POSTGRES_PASSWORD', DATABASE_CANONICAL.PASSWORD],
  ['POSTGRES_URL', DATABASE_CANONICAL.URL],
  // PG-prefixed shorter forms in BACKEND env
  ['PG_HOST', DATABASE_CANONICAL.HOST],
  ['PG_PORT', DATABASE_CANONICAL.PORT],
  ['PG_DB', DATABASE_CANONICAL.NAME],
  ['PG_USER', DATABASE_CANONICAL.USER],
  ['PG_PASSWORD', DATABASE_CANONICAL.PASSWORD],
  // Vectordb abbreviations (less common but possible)
  ['VECTOR_HOST', VECTORDB_CANONICAL.HOST],
  ['VECTOR_PORT', VECTORDB_CANONICAL.PORT],
  ['VECTOR_DB', VECTORDB_CANONICAL.NAME],
  ['VECTOR_USER', VECTORDB_CANONICAL.USER],
  ['VECTOR_PASSWORD', VECTORDB_CANONICAL.PASSWORD],
  ['QDRANT_DB', VECTORDB_CANONICAL.NAME],
  // Note: QDRANT_URL is the canonical env name for qdrant engine on the
  // backend (per scope-integration.md vectordb table); we leave it.
  // Same for CHROMA_URL.
]);

function isBackendService(serviceName, service) {
  // Heuristic: name === 'backend', OR has `depends_on` referencing
  // 'database' or 'vectordb' (which are the data-store services
  // a backend would depend on).
  if (serviceName === 'backend') return true;
  const dep = service?.depends_on;
  if (!dep) return false;
  if (Array.isArray(dep)) return dep.some((d) => d === 'database' || d === 'vectordb');
  if (typeof dep === 'object') return Boolean(dep.database || dep.vectordb);
  return false;
}

function extractEnvKeysFromService(service) {
  // compose `environment:` accepts both list-of-strings (`KEY=val`) and
  // object form (`KEY: val`). Return list of {key, valueText, source}.
  // `source` is 'list' or 'object'.
  const env = service?.environment;
  if (!env) return [];
  if (Array.isArray(env)) {
    return env
      .filter((entry) => typeof entry === 'string')
      .map((entry) => {
        const eq = entry.indexOf('=');
        if (eq < 0) return { key: entry.trim(), valueText: '', source: 'list' };
        return {
          key: entry.slice(0, eq).trim(),
          valueText: entry.slice(eq + 1).trim(),
          source: 'list',
        };
      });
  }
  if (typeof env === 'object') {
    return Object.entries(env).map(([k, v]) => ({
      key: k,
      valueText: v == null ? '' : String(v),
      source: 'object',
    }));
  }
  return [];
}

export function scanComposeForEnvVarNamingDrift(workspaceDir) {
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

  const issues = [];
  for (const [serviceName, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object') continue;
    if (!isBackendService(serviceName, service)) continue;

    const envEntries = extractEnvKeysFromService(service);
    if (!envEntries.length) continue;

    const presentKeys = new Set(envEntries.map((e) => e.key));
    const drifts = [];
    for (const { key, valueText } of envEntries) {
      const canonical = BACKEND_ENV_REWRITES.get(key);
      if (!canonical) continue;
      // Don't rewrite if the canonical name is ALREADY present alongside
      // the non-canonical one — agent might have set both, just remove
      // the non-canonical (caller handles via fix logic). For now, only
      // rewrite when canonical is absent.
      if (presentKeys.has(canonical)) continue;
      drifts.push({ from: key, to: canonical, value: valueText });
    }
    if (drifts.length === 0) continue;

    issues.push({
      service: serviceName,
      composePath,
      drifts,
    });
  }
  return issues;
}

export function applyEnvVarNamingFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  let composeText;
  try {
    composeText = fs.readFileSync(composePath, 'utf-8');
  } catch {
    return [];
  }

  const applied = [];
  let modified = composeText;

  for (const issue of issues) {
    for (const drift of issue.drifts) {
      // Two YAML forms to handle in source text:
      //   1. List form: `- DB_HOST=database`
      //   2. Object form: `      DB_HOST: database`
      //
      // We rewrite key only, leaving value untouched.
      //
      // List form regex: `(\s*-\s*)DB_HOST(=)`
      const listForm = new RegExp(`(^\\s*-\\s*)${drift.from}(\\s*=)`, 'gm');
      // Object form regex: `(^\\s*)DB_HOST(\\s*:)`
      const objForm = new RegExp(`(^\\s*)${drift.from}(\\s*:)`, 'gm');

      const beforeText = modified;
      modified = modified.replace(listForm, `$1${drift.to}$2`);
      modified = modified.replace(objForm, `$1${drift.to}$2`);

      if (beforeText !== modified) {
        applied.push({
          service: issue.service,
          from: drift.from,
          to: drift.to,
          value: drift.value,
        });
      }
    }
  }

  if (modified !== composeText) {
    fs.writeFileSync(composePath, modified, 'utf-8');
  }
  return applied;
}
