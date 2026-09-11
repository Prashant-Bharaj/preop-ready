// Pre-`compose up` static cross-check between Postgres init scripts and the
// service's Dockerfile FROM. Catches the bug class:
//
//   `init.sql` says `CREATE EXTENSION IF NOT EXISTS vector;`
//   `Dockerfile` says `FROM postgres:16`
//
// `docker-compose build` returns 0 — extensions aren't installed at build,
// they're loaded by the postgres entrypoint when init scripts run on first
// startup. On `compose up`, postgres starts, runs the init scripts, fails
// with "extension X is not available", exits non-zero, dependent services
// never start, run returns ok=false.
//
// Empirically observed on the t6-smart-docs run (2026-04-26): vectordb
// scope wrote `CREATE EXTENSION vector;` against `postgres:16` (vanilla
// postgres has no pgvector). Same root-cause shape as the directive
// validator's stripped-image check, but on init.sql + Dockerfile FROM
// rather than compose-level directives.
//
// Strategy: scan compose.yml services with `build:`, find init scripts in
// each service's build context (or the volume-mounted ones), extract any
// `CREATE EXTENSION` calls, look up which extensions require non-default
// base images, and rewrite the Dockerfile FROM to a compatible image.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// Postgres extensions that REQUIRE a non-default base image. Maps to a
// recommended replacement image keyed by detected base-image major version.
// Key by extension name; value is a function that takes the current base
// image string and returns the recommended replacement.
const EXTENSION_TO_BASE_IMAGE = {
  vector: (current) => {
    // Match the postgres major version when present; default to pg16.
    // PIN to an explicit pgvector release tag — the floating `pgvector/pgvector:pgN`
    // tag has been observed pulling broken images (Debian 13 trixie, no vector
    // extension files at /usr/share/postgresql/N/extension/) on 2026-05-05.
    // Explicit-version tags (0.7.4-pg16, 0.8.0-pg16, etc.) ship the extension
    // reliably. Using `0.7.4-pg16` as the known-good pin; bump after verifying.
    const versionMatch = current.match(/postgres:(\d+)/);
    const version = versionMatch ? versionMatch[1] : '16';
    return `pgvector/pgvector:0.7.4-pg${version}`;
  },
};

// Postgres extensions built into the official `postgres` images — no fix
// needed, just here so the scanner doesn't false-flag them.
const BUILTIN_PG_EXTENSIONS = new Set([
  'pg_trgm', 'pgcrypto', 'unaccent', 'uuid-ossp', 'btree_gin', 'btree_gist',
  'citext', 'hstore', 'tablefunc', 'fuzzystrmatch', 'pg_stat_statements',
  'plpgsql', 'pageinspect', 'pgrowlocks', 'pgstattuple',
]);

function readDockerfileFrom(dockerfilePath) {
  if (!fs.existsSync(dockerfilePath)) return null;
  try {
    const content = fs.readFileSync(dockerfilePath, 'utf-8');
    // Last FROM wins for multi-stage; runtime image is what postgres runs as.
    const matches = [...content.matchAll(/^\s*FROM\s+([^\s\n]+)/gim)];
    return matches.length > 0 ? matches[matches.length - 1][1] : null;
  } catch {
    return null;
  }
}

function extractCreateExtensions(sqlContent) {
  // Match: CREATE EXTENSION [IF NOT EXISTS] [SCHEMA ...] "name" | name
  const pattern = /\bCREATE\s+EXTENSION\b(?:\s+IF\s+NOT\s+EXISTS)?\s+"?(\w[\w-]*)"?/gi;
  const found = new Set();
  let m;
  while ((m = pattern.exec(sqlContent)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

function findInitScripts(buildContextDir, composeService) {
  // Init scripts can come from two places:
  //   1. COPY into /docker-entrypoint-initdb.d/ from the build context
  //   2. compose volume mount onto /docker-entrypoint-initdb.d/
  //
  // We scan the build context recursively (depth 3) for .sql files and
  // also the host-side paths from any volume mount that targets the
  // initdb directory.
  const scripts = new Set();

  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.sql')) scripts.add(full);
    }
  }
  walk(buildContextDir, 0);

  // Volume-mounted init scripts — look for `/docker-entrypoint-initdb.d`
  // target on the volume mount and resolve the host-side path.
  const volumes = composeService?.volumes;
  if (Array.isArray(volumes)) {
    for (const v of volumes) {
      let host, target;
      if (typeof v === 'string') {
        const parts = v.split(':');
        if (parts.length < 2) continue;
        host = parts[0];
        target = parts[1];
      } else if (v && typeof v === 'object') {
        host = v.source;
        target = v.target;
      }
      if (!target || !target.includes('/docker-entrypoint-initdb.d')) continue;
      if (!host || host.startsWith('/')) continue; // absolute or anonymous, skip
      // Relative to compose file's directory (workspace root in our case).
      // The buildContextDir is one level into workspace; up one to root.
      // We won't bother resolving — the recursive scan above already covers
      // build-context cases. Volume mounts to .sql files are uncommon when
      // a build context exists.
    }
  }

  return [...scripts];
}

function imageMatchesProvider(image, providerPrefix) {
  return image === providerPrefix
    || image.startsWith(`${providerPrefix}:`)
    || image.startsWith(`${providerPrefix}/`);
}

// Step 7e: known vector-engine image prefixes that are NOT postgres-based.
// When a Dockerfile FROM matches one of these, the agent picked a non-pgvector
// engine (qdrant, chroma, etc.) — the init SQL with `CREATE EXTENSION vector`
// is the inconsistency, not the Dockerfile. Don't rewrite FROM in that case;
// the Step 7e vector_engine contract is the right place to make the choice.
const NON_PGVECTOR_ENGINE_PREFIXES = [
  'qdrant/qdrant',
  'chromadb/chroma',
  'milvusdb/milvus',
  'weaviate/weaviate',
];

function isNonPgvectorEngineImage(image) {
  return NON_PGVECTOR_ENGINE_PREFIXES.some(prefix => imageMatchesProvider(image, prefix));
}

export function scanInitSqlForBadExtensions(workspaceDir) {
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
    if (!service.build) continue;

    const buildPath = typeof service.build === 'string' ? service.build : service.build?.context;
    if (!buildPath) continue;
    const buildContextDir = path.resolve(workspaceDir, buildPath);
    if (!fs.existsSync(buildContextDir)) continue;

    const baseImage = readDockerfileFrom(path.join(buildContextDir, 'Dockerfile'));
    if (!baseImage) continue;

    // Step 7e: agent picked a non-pgvector vector engine (qdrant, chroma, etc.)
    // — don't try to rewrite the Dockerfile FROM back to pgvector. The init SQL
    // is the inconsistency to address (via the vector_engine contract); the
    // Dockerfile FROM stays. The validator's job ends here for this service.
    if (isNonPgvectorEngineImage(baseImage)) {
      continue;
    }

    const sqlFiles = findInitScripts(buildContextDir, service);
    if (!sqlFiles.length) continue;

    for (const sqlFile of sqlFiles) {
      let sqlContent;
      try {
        sqlContent = fs.readFileSync(sqlFile, 'utf-8');
      } catch {
        continue;
      }
      const extensions = extractCreateExtensions(sqlContent);

      for (const ext of extensions) {
        if (BUILTIN_PG_EXTENSIONS.has(ext)) continue;

        const imageBuilder = EXTENSION_TO_BASE_IMAGE[ext];
        if (!imageBuilder) continue; // unknown extension, leave to postgres' own error

        const recommendedImage = imageBuilder(baseImage);
        const recommendedProvider = recommendedImage.split(':')[0]; // e.g. pgvector/pgvector
        const recommendedImageName = recommendedProvider.split('/').pop(); // pgvector

        // Already on the right provider? (matches `pgvector/pgvector:pg16`)
        if (imageMatchesProvider(baseImage, recommendedProvider)) continue;

        issues.push({
          service: serviceName,
          buildContextDir,
          baseImage,
          sqlFile: path.relative(workspaceDir, sqlFile),
          extension: ext,
          recommendedImage,
        });
      }
    }
  }
  return issues;
}

export function applyInitSqlFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];

  // Group issues by service so we rewrite each Dockerfile at most once.
  const byService = new Map();
  for (const issue of issues) {
    if (!byService.has(issue.service)) byService.set(issue.service, []);
    byService.get(issue.service).push(issue);
  }

  for (const [serviceName, serviceIssues] of byService) {
    const buildContextDir = serviceIssues[0].buildContextDir;
    const dockerfilePath = path.join(buildContextDir, 'Dockerfile');

    // Pick the recommended image of the first issue. If multiple extensions
    // need different base images we'd need a smarter resolver, but the
    // common case is one extension per service.
    const recommendedImage = serviceIssues[0].recommendedImage;
    const previousImage = serviceIssues[0].baseImage;

    let content;
    try {
      content = fs.readFileSync(dockerfilePath, 'utf-8');
    } catch {
      continue;
    }
    // Replace the LAST FROM (runtime image for multi-stage) — same heuristic
    // readDockerfileFrom uses to pick the right one.
    const matches = [...content.matchAll(/^\s*FROM\s+([^\s\n]+)/gim)];
    if (matches.length === 0) continue;
    const last = matches[matches.length - 1];
    const newContent = content.slice(0, last.index)
      + last[0].replace(last[1], recommendedImage)
      + content.slice(last.index + last[0].length);
    if (newContent === content) continue;

    fs.writeFileSync(dockerfilePath, newContent, 'utf-8');
    applied.push({
      service: serviceName,
      previousImage,
      newImage: recommendedImage,
      reasons: serviceIssues.map((i) => `${i.sqlFile}: CREATE EXTENSION ${i.extension}`),
    });
  }

  return applied;
}

// ──────────────────────────────────────────────────────────────────────
// Step 6b — canonical column-presence cross-check.
//
// Catches the bug class observed on t31 ORCH (2026-05-04 Step 5c gate):
//
//   backend/src/middleware/auth.js:
//     INSERT INTO users (oidc_sub, email) VALUES ($1, $2) ...
//   database/init/init.sql:
//     CREATE TABLE IF NOT EXISTS users (
//       id SERIAL PRIMARY KEY,
//       email VARCHAR(255) UNIQUE NOT NULL,
//       name VARCHAR(100),
//       created_at TIMESTAMPTZ DEFAULT NOW()
//     );
//
// `compose build` returns 0 (init.sql syntax is fine, schema is loaded
// from a copy at build time). On `compose up`, postgres initializes the
// users table without `oidc_sub`. Backend's first INSERT fails with
// `column "oidc_sub" of relation "users" does not exist`, container
// exits, run returns ok=false.
//
// LLM-only schema-contract checks routinely miss this — the LLM reads
// both files but misses the mismatch. Static check is robust.
//
// Anti-overrestriction guardrails (per the canonical-anchored design
// principle for Step 6):
//
// - Only checks for KNOWN CANONICAL columns. The producing-agents are
//   free to use custom column names like `tenant_id` or `external_ref`;
//   those are NOT auto-added if missing — agent's own custom schema,
//   agent's responsibility.
// - Only fires when the BACKEND'S OWN CODE references the column.
//   We don't add `oidc_sub` to a users table just because `has-users`
//   is set in the planning spec; only when actual backend code uses it.
// - Append-only via ALTER TABLE — never modifies existing CREATE TABLE
//   columns or rewrites the agent's schema.
// - Skip if the relevant CREATE TABLE doesn't exist in init.sql at all
//   — that's a different failure mode that requires the full schema,
//   not a column patch.

// Canonical columns mapped to their CREATE TABLE patterns and the
// ALTER TABLE clause to add them. Keyed by `<table>.<column>`. The
// `pattern` regex matches the column reference in backend source code
// (e.g., INSERT INTO users (...oidc_sub...) or WHERE oidc_sub = ...).
//
// Add new entries here only when a recurring failure pattern surfaces
// AND the column has a well-defined canonical type. For one-off custom
// columns, prefer fixing at the producing-agent prompt layer.
const CANONICAL_COLUMNS = {
  'users.oidc_sub': {
    table: 'users',
    column: 'oidc_sub',
    alter: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub TEXT UNIQUE;',
    backendPattern: /\boidc_sub\b/,
  },
  'users.password_hash': {
    table: 'users',
    column: 'password_hash',
    alter: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;',
    backendPattern: /\bpassword_hash\b/,
  },
};

// Extract column names from a `CREATE TABLE <name> (...)` block.
// Heuristic regex — covers the common case (one column per line, name
// is first token). Doesn't try to be a full SQL parser.
function extractTableColumns(sqlContent, tableName) {
  const tableRe = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\s*\\(([\\s\\S]*?)\\)\\s*;`,
    'i'
  );
  const m = sqlContent.match(tableRe);
  if (!m) return null; // table not declared in this SQL
  const body = m[1];
  // Split by top-level commas (rough — doesn't handle nested parens
  // for CHECK constraints etc., but good enough for column extraction).
  const cols = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      cols.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) cols.push(buf.trim());
  // Each col line starts with the name (or PRIMARY KEY / CONSTRAINT
  // for table-level clauses, which we skip).
  const names = [];
  for (const c of cols) {
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(c)) continue;
    const nameMatch = c.match(/^"?(\w+)"?\s/);
    if (nameMatch) names.push(nameMatch[1].toLowerCase());
  }
  return names;
}

// Walk backend/src recursively, return all .js .ts .py .mjs source
// content concatenated. Bounded depth so we don't traverse node_modules.
function readBackendSources(workspaceDir) {
  const root = path.join(workspaceDir, 'backend');
  const srcDir = path.join(root, 'src');
  const candidates = [srcDir, root];
  const out = [];
  const seen = new Set();
  for (const start of candidates) {
    if (!fs.existsSync(start)) continue;
    const stack = [{ dir: start, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      if (depth > 6) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push({ dir: full, depth: depth + 1 });
        } else if (/\.(js|mjs|cjs|ts|tsx|py)$/.test(e.name) && !seen.has(full)) {
          seen.add(full);
          try {
            out.push(fs.readFileSync(full, 'utf-8'));
          } catch {}
        }
      }
    }
  }
  return out.join('\n');
}

function findInitSqlFiles(workspaceDir) {
  const root = path.join(workspaceDir, 'database', 'init');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.sql')) files.push(path.join(root, e.name));
  }
  return files;
}

/**
 * Scan for canonical columns the backend references but the database's
 * init.sql doesn't declare. Returns issues that can be auto-fixed by
 * appending ALTER TABLE statements.
 *
 * @returns {Array<{key, table, column, alter, sqlFile}>}
 */
export function scanInitSqlForMissingCanonicalColumns(workspaceDir) {
  const sqlFiles = findInitSqlFiles(workspaceDir);
  if (!sqlFiles.length) return [];
  const backendSrc = readBackendSources(workspaceDir);
  if (!backendSrc) return [];

  const issues = [];
  for (const [key, spec] of Object.entries(CANONICAL_COLUMNS)) {
    // Backend must actually reference the canonical column. If it
    // doesn't, we don't need this column — leave the agent's schema
    // alone.
    if (!spec.backendPattern.test(backendSrc)) continue;

    // Find which SQL file declares the relevant CREATE TABLE.
    let foundFile = null;
    let existingCols = null;
    for (const sqlFile of sqlFiles) {
      let content;
      try {
        content = fs.readFileSync(sqlFile, 'utf-8');
      } catch {
        continue;
      }
      const cols = extractTableColumns(content, spec.table);
      if (cols == null) continue; // table not in this file
      foundFile = sqlFile;
      existingCols = cols;
      break;
    }
    if (!foundFile) continue; // table not declared anywhere — not our case
    if (existingCols.includes(spec.column.toLowerCase())) continue; // already there

    issues.push({
      key,
      table: spec.table,
      column: spec.column,
      alter: spec.alter,
      sqlFile: foundFile,
    });
  }
  return issues;
}

/**
 * Append ALTER TABLE statements for missing canonical columns to the
 * appropriate init.sql file. Append-only — never modifies existing
 * CREATE TABLE columns.
 *
 * @returns {Array<{table, column, sqlFile}>}
 */
export function applyMissingCanonicalColumnFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];

  // Group by sqlFile so we append all ALTERs for the same file in one
  // write.
  const byFile = new Map();
  for (const issue of issues) {
    if (!byFile.has(issue.sqlFile)) byFile.set(issue.sqlFile, []);
    byFile.get(issue.sqlFile).push(issue);
  }

  for (const [sqlFile, fileIssues] of byFile) {
    let content;
    try {
      content = fs.readFileSync(sqlFile, 'utf-8');
    } catch {
      continue;
    }
    const additions = fileIssues.map(
      (i) => `\n-- Step 6b auto-added: backend code references ${i.table}.${i.column} but CREATE TABLE didn't declare it.\n${i.alter}\n`
    );
    const newContent = content.replace(/\s*$/, '') + '\n' + additions.join('') + '\n';
    if (newContent === content) continue;
    try {
      fs.writeFileSync(sqlFile, newContent, 'utf-8');
      for (const issue of fileIssues) {
        applied.push({
          table: issue.table,
          column: issue.column,
          sqlFile: path.relative(workspaceDir, sqlFile),
        });
      }
    } catch {}
  }
  return applied;
}

// ── DB-switching statements in init scripts ────────────────────────────────
//
// docker-entrypoint-initdb.d scripts already run connected to the service's
// POSTGRES_DB — `CREATE DATABASE X` / `\connect X` in them is ALWAYS wrong:
// the tables land in X while the app connects to POSTGRES_DB. Observed live
// (2026-07-16, sop-assistant): a gate-fix agent wrote `CREATE DATABASE
// stub_db` + `\connect stub_db` into vectordb/init/01_init.sql; every gate
// passed and the app 500'd with `relation "doc_chunks" does not exist`.

const DB_SWITCH_LINE_RE = /(CREATE\s+DATABASE\b|^\s*\\(connect|c)\b)/i;

export function scanInitSqlForDbSwitching(workspaceDir) {
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
    if (!service || typeof service !== 'object' || !service.build) continue;
    const buildPath = typeof service.build === 'string' ? service.build : service.build?.context;
    if (!buildPath) continue;
    const buildContextDir = path.resolve(workspaceDir, buildPath);
    if (!fs.existsSync(buildContextDir)) continue;
    for (const sqlFile of findInitScripts(buildContextDir, service)) {
      let content;
      try {
        content = fs.readFileSync(sqlFile, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('--')) continue;
        if (DB_SWITCH_LINE_RE.test(lines[i])) {
          issues.push({ service: serviceName, sqlFile: path.relative(workspaceDir, sqlFile), line: i + 1, statement: lines[i].trim().slice(0, 120) });
        }
      }
    }
  }
  return issues;
}

export function applyDbSwitchingFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];
  const byFile = new Map();
  for (const issue of issues) {
    if (!byFile.has(issue.sqlFile)) byFile.set(issue.sqlFile, []);
    byFile.get(issue.sqlFile).push(issue);
  }
  for (const [rel, fileIssues] of byFile) {
    const abs = path.join(workspaceDir, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (const issue of fileIssues) {
      const idx = issue.line - 1;
      if (idx < 0 || idx >= lines.length || lines[idx].trim().startsWith('--')) continue;
      lines[idx] = `-- [platform] removed (init scripts already run against POSTGRES_DB): ${lines[idx]}`;
      applied.push(issue);
    }
    fs.writeFileSync(abs, lines.join('\n'), 'utf-8');
  }
  return applied;
}
