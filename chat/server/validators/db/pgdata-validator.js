// Pre-`compose up` cross-check between Dockerfile `ENV PGDATA=...` and
// compose volume mount targets. Catches the bug class:
//
//   Dockerfile: `ENV PGDATA=/data/postgres`
//   docker-compose.yml: `volumes: [vectordb-data:/data/postgres]`
//
// `compose build` returns 0 (the Dockerfile is valid). On `compose up`,
// docker mounts a fresh root-owned named volume at exactly the path
// postgres wants for its data directory. Postgres' entrypoint can't
// initdb into a non-empty (it has lost+found / metadata) or wrong-owner
// directory and exits 3, dependent services never start, run reports
// ok=false.
//
// Empirically observed on a t8-farmer-products run (2026-04-28):
// vectordb scope wrote exactly that pattern. Init.sql + Dockerfile
// content was correct (pgvector image, CREATE EXTENSION vector); the
// failure was at the volume/PGDATA-path layer, downstream of
// init-sql-validator's scope.
//
// Fix (Strategy A — same shape as the other validators): keep the
// volume mount where it is, but move PGDATA to a subdirectory of the
// mount target. `PGDATA=/data/postgres/pgdata` is the conventional
// pattern — postgres' entrypoint creates the subdir, takes ownership,
// and initdb runs cleanly. Minimal mutation to the model's output.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

function readDockerfile(dockerfilePath) {
  if (!fs.existsSync(dockerfilePath)) return null;
  try {
    return fs.readFileSync(dockerfilePath, 'utf-8');
  } catch {
    return null;
  }
}

function extractPgdataEnv(dockerfileContent) {
  // Match: `ENV PGDATA=<path>` or `ENV PGDATA <path>`. Supports the
  // optional inline `=<path>` form (most common) plus the legacy
  // space-separated form.
  const m = dockerfileContent.match(/^\s*ENV\s+PGDATA\s*=?\s*([^\s\n#]+)/im);
  return m ? m[1] : null;
}

function extractMountTarget(volumeEntry) {
  // Forms:
  //   "named-volume:/path"
  //   "./host-path:/path:ro"
  //   { source, target, read_only }
  //   { type, source, target }
  if (typeof volumeEntry === 'string') {
    const parts = volumeEntry.split(':');
    if (parts.length < 2) return null;
    return parts[1]; // skip flags after second colon
  }
  if (volumeEntry && typeof volumeEntry === 'object' && volumeEntry.target) {
    return String(volumeEntry.target);
  }
  return null;
}

function targetCollidesWithPgdata(mountTarget, pgdataPath) {
  if (!mountTarget || !pgdataPath) return false;
  const t = mountTarget.replace(/\/+$/, '');
  const p = pgdataPath.replace(/\/+$/, '');
  return t === p;
}

export function scanComposeForPgdataMisconfig(workspaceDir) {
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
    const dockerfilePath = path.join(buildContextDir, 'Dockerfile');
    const dockerfileContent = readDockerfile(dockerfilePath);
    if (!dockerfileContent) continue;

    const pgdataPath = extractPgdataEnv(dockerfileContent);
    if (!pgdataPath) continue;

    const volumes = service.volumes;
    if (!Array.isArray(volumes)) continue;

    for (const v of volumes) {
      const target = extractMountTarget(v);
      if (!targetCollidesWithPgdata(target, pgdataPath)) continue;

      // Recommended replacement: keep the mount where it is, move PGDATA
      // to a subdir. `pgdata` is the conventional name in production
      // postgres deployments.
      const newPgdata = `${target.replace(/\/+$/, '')}/pgdata`;
      issues.push({
        service: serviceName,
        dockerfilePath,
        composePath,
        previousPgdata: pgdataPath,
        recommendedPgdata: newPgdata,
        mountTarget: target,
      });
      break; // one issue per service is enough; same fix applies
    }
  }
  return issues;
}

export function applyPgdataFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];

  for (const issue of issues) {
    let dockerfileContent;
    try {
      dockerfileContent = fs.readFileSync(issue.dockerfilePath, 'utf-8');
    } catch {
      continue;
    }
    // Replace the PGDATA env value, preserving the rest of the directive
    // exactly. Both `ENV PGDATA=<path>` and `ENV PGDATA <path>` forms.
    const newDockerfile = dockerfileContent.replace(
      /^(\s*ENV\s+PGDATA\s*=?\s*)([^\s\n#]+)/im,
      `$1${issue.recommendedPgdata}`
    );
    if (newDockerfile === dockerfileContent) continue;

    fs.writeFileSync(issue.dockerfilePath, newDockerfile, 'utf-8');
    applied.push({
      service: issue.service,
      previousPgdata: issue.previousPgdata,
      recommendedPgdata: issue.recommendedPgdata,
      mountTarget: issue.mountTarget,
    });
  }
  return applied;
}

// ──────────────────────────────────────────────────────────────────────
// Step 6c — pg_isready healthcheck user must match POSTGRES_USER env.
//
// Catches the bug class observed on t31 ORCH (2026-05-04 Step 5c gate):
//
//   compose.yml:
//     database:
//       environment:
//         POSTGRES_USER: tasks_user
//       healthcheck:
//         test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
//
// `compose build` returns 0 — both fragments are individually valid.
// On `compose up`, postgres starts with role `tasks_user` (no `postgres`
// role exists in the new database), the healthcheck queries with
// `-U postgres`, fails immediately, marked unhealthy, dependent backend
// service never starts (depends_on: condition: service_healthy), run
// returns ok=false. Build PASSED but runtime crashes — same shape as
// the pgdata-misconfig bug above.
//
// **Anti-overrestriction guardrails:**
//
// - Only fires when there's an actual mismatch. If the agent set neither
//   POSTGRES_USER nor a `-U` flag, the postgres image defaults to
//   `postgres` for both — no mismatch, no auto-fix.
// - Only acts on `pg_isready` healthchecks; non-postgres healthchecks
//   are not our concern.
// - Doesn't change POSTGRES_USER (the env value drives the actual
//   database role; the healthcheck is the thing that must follow).
// - Doesn't add a healthcheck where there wasn't one — the fix only
//   updates an existing healthcheck.

function extractEnvFromService(service) {
  // compose `environment:` accepts both list-of-strings (`KEY=val`) and
  // object form (`KEY: val`). Normalize to a flat object for lookup.
  const env = service.environment;
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

function extractHealthcheckCommand(service) {
  // `healthcheck.test` can be a string ("CMD-SHELL pg_isready ...") or
  // an array (["CMD-SHELL", "pg_isready ..."] or ["CMD", "pg_isready", ...]).
  // Return the joined command string for regex inspection, or null.
  const hc = service.healthcheck;
  if (!hc || !hc.test) return null;
  if (typeof hc.test === 'string') return hc.test;
  if (Array.isArray(hc.test)) {
    // Skip the leading "CMD" / "CMD-SHELL" / "NONE" sentinel.
    return hc.test.slice(1).join(' ');
  }
  return null;
}

function pgIsReadyArgs(cmdString) {
  if (!cmdString) return null;
  if (!/\bpg_isready\b/.test(cmdString)) return null;
  // Capture the value passed to `-U` and `-d`, both optional. Greedy on
  // word characters; pg_isready accepts unquoted role names.
  const userMatch = cmdString.match(/-U\s+(\S+)/);
  const dbMatch = cmdString.match(/-d\s+(\S+)/);
  return {
    user: userMatch ? userMatch[1] : null,
    db: dbMatch ? dbMatch[1] : null,
  };
}

export function scanComposeForHealthcheckUserMismatch(workspaceDir) {
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
    const cmdString = extractHealthcheckCommand(service);
    const args = pgIsReadyArgs(cmdString);
    if (!args) continue; // not a pg_isready healthcheck

    const env = extractEnvFromService(service);
    const envUser = env.POSTGRES_USER;
    const envDb = env.POSTGRES_DB;

    // No mismatch possible if both env vars are absent (postgres image
    // defaults to `postgres` for both, agent's healthcheck likely uses
    // `-U postgres` or no -U; either way, default-vs-default is fine).
    if (envUser == null && envDb == null) continue;

    // `$${POSTGRES_USER}` / `$${POSTGRES_DB}` expand inside the container to
    // whatever the env block set (compose keeps the `$$` escape verbatim in
    // the parsed string) — that is the prescribed healthcheck and can never
    // mismatch, whatever the env value (literal or a ${DATABASE_*} reference).
    const userMismatch = args.user != null && envUser != null && args.user !== envUser && args.user !== '$${POSTGRES_USER}';
    const dbMismatch = args.db != null && envDb != null && args.db !== envDb && args.db !== '$${POSTGRES_DB}';
    // Also flag when env declares custom user/db but healthcheck has no
    // -U / -d (defaults to "postgres" — wrong, will fail).
    const userMissingButEnvCustom = args.user == null && envUser != null && envUser !== 'postgres';
    const dbMissingButEnvCustom = args.db == null && envDb != null && envDb !== 'postgres';

    if (!userMismatch && !dbMismatch && !userMissingButEnvCustom && !dbMissingButEnvCustom) continue;

    issues.push({
      service: serviceName,
      composePath,
      previousUser: args.user,
      previousDb: args.db,
      recommendedUser: envUser ?? args.user,
      recommendedDb: envDb ?? args.db,
      previousCmd: cmdString,
    });
  }
  return issues;
}

export function applyHealthcheckUserFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];

  // Re-load compose once and apply all fixes at once. We rewrite via
  // string replacement on the YAML source (rather than YAML.stringify
  // round-trip) to preserve the agent's formatting/comments/key order.
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  let composeText;
  try {
    composeText = fs.readFileSync(composePath, 'utf-8');
  } catch {
    return [];
  }

  let modified = composeText;
  for (const issue of issues) {
    const newCmd = (issue.previousCmd || '')
      // Replace existing -U value or insert one after pg_isready if absent.
      .replace(/(-U\s+)\S+/, `$1${issue.recommendedUser}`)
      .replace(/\bpg_isready\b(?!\s+-)/, `pg_isready -U ${issue.recommendedUser}`)
      // Replace existing -d value or insert one if absent (only when env defines POSTGRES_DB).
      .replace(/(-d\s+)\S+/, `$1${issue.recommendedDb}`);
    // If the previous cmd had no -d and the recommended db is set, append it.
    let finalCmd = newCmd;
    if (issue.recommendedDb != null && !/-d\s/.test(finalCmd)) {
      finalCmd = finalCmd.replace(/\bpg_isready\b((?:\s+-U\s+\S+)?)/, `pg_isready$1 -d ${issue.recommendedDb}`);
    }

    // Replace the previous command verbatim in the compose source. The
    // command may appear inside an array element (`["CMD-SHELL", "..."]`)
    // or as a plain string. Either way, the literal command text is
    // unique enough for direct replacement.
    if (issue.previousCmd && finalCmd !== issue.previousCmd) {
      const before = modified;
      modified = modified.split(issue.previousCmd).join(finalCmd);
      if (before !== modified) {
        applied.push({
          service: issue.service,
          previousCmd: issue.previousCmd,
          newCmd: finalCmd,
          recommendedUser: issue.recommendedUser,
          recommendedDb: issue.recommendedDb,
        });
      }
    }
  }

  if (modified !== composeText) {
    fs.writeFileSync(composePath, modified, 'utf-8');
  }
  return applied;
}

// ──────────────────────────────────────────────────────────────────────
// `USER postgres` directive in a postgres-derived Dockerfile — breaks the
// official postgres entrypoint's first-time initdb.
//
// Empirically observed on a t32-doc-search-api run (2026-05-08):
//
//   vectordb/Dockerfile:
//     FROM pgvector/pgvector:0.7.4-pg16
//     ENV PGDATA=/data/pgdata
//     COPY init/ /docker-entrypoint-initdb.d/
//     HEALTHCHECK ...
//     USER postgres
//     EXPOSE 5432
//
// `compose build` succeeds. On `compose up`, the container starts as the
// `postgres` user but `/data` doesn't exist yet — the entrypoint tries
// `mkdir /data/pgdata` and gets "Permission denied". Container exits 1,
// dependent backend never starts (depends_on: condition: service_healthy).
//
// The canonical snippet (snippets/vectordb/Dockerfile.pgvector) does NOT
// include a USER directive — postgres official guidance is to leave the
// gosu-based entrypoint to handle privilege switching internally. Adding
// USER postgres at the Dockerfile level breaks that mechanism. The agent
// inserted it on its own; that's the divergence the validator catches.
//
// Fix: remove the USER directive. **Always safe on postgres-derived
// images** — the entrypoint runs as root, performs the mkdir + chown +
// initdb under root, then drops privileges via gosu when launching the
// actual postgres process. A `USER postgres` directive at build time
// short-circuits that and breaks initialization.
//
// **Implementation: line-based scan, no multi-line regex.** Earlier
// attempts at "is the USER protected by a preceding mkdir+chown" used
// `[\s\S]*?` non-greedy patterns that could falsely match across
// unrelated RUN directives. Since removing USER is always safe on
// postgres-derived images regardless of surrounding directives, the
// "protected" check isn't needed.
//
// **Anti-overrestriction guardrails:**
//
// - Only acts on Dockerfiles whose `FROM` line resolves to a postgres-
//   derived image (postgres, pgvector/pgvector, postgis/postgis, etc.).
//   USER directives in non-postgres images are left alone.
// - Only removes `USER postgres` (the empirically-observed bug pattern).
//   Other USER values (e.g. numeric uids, custom user names) are not
//   touched — the agent may have set them up correctly.
// - Removes the USER line only; all other directives are preserved.

const POSTGRES_IMAGE_RE = /^(?:postgres|pgvector\/pgvector|postgis\/postgis|[\w/.-]*\/postgres|[\w/.-]*\/pgvector)(?::\S+)?$/i;

function dockerfileLines(content) {
  return String(content || '').split(/\r?\n/);
}

function isPostgresDerivedDockerfile(content) {
  // Walk lines, skip blanks/comments, match FROM directives. Multi-stage
  // builds may have several FROM lines — treating the whole file as
  // "postgres-derived" if ANY FROM is postgres-image is conservative
  // for our purposes (the bug we fix is removing a misplaced USER
  // postgres which is wrong everywhere on a postgres-image stage).
  for (const raw of dockerfileLines(content)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^FROM\s+(\S+)/i);
    if (!m) continue;
    if (POSTGRES_IMAGE_RE.test(m[1])) return true;
  }
  return false;
}

function findUserPostgresLineIndex(content) {
  const lines = dockerfileLines(content);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    // Match `USER postgres` exactly — allow trailing whitespace but no
    // extra args. We do NOT match e.g. `USER postgres:postgres` or
    // numeric uids; the agent may have intended those.
    if (/^USER\s+postgres\s*$/i.test(line)) return i;
  }
  return -1;
}

export function scanDockerfilesForUserBeforeMkdir(workspaceDir) {
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
    const dockerfilePath = path.join(buildContextDir, 'Dockerfile');
    const dockerfileContent = readDockerfile(dockerfilePath);
    if (!dockerfileContent) continue;

    if (!isPostgresDerivedDockerfile(dockerfileContent)) continue;

    const userLineIdx = findUserPostgresLineIndex(dockerfileContent);
    if (userLineIdx < 0) continue;

    const userDirective = dockerfileLines(dockerfileContent)[userLineIdx].trim();
    issues.push({
      service: serviceName,
      dockerfilePath,
      userLineIndex: userLineIdx,
      userDirective,
    });
  }
  return issues;
}

export function applyUserBeforeMkdirFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];
  for (const issue of issues) {
    let dockerfileContent;
    try {
      dockerfileContent = fs.readFileSync(issue.dockerfilePath, 'utf-8');
    } catch {
      continue;
    }
    // Re-find the line by content (in case file changed since scan).
    // This makes the fix idempotent and resilient to concurrent edits.
    const lines = dockerfileLines(dockerfileContent);
    const idx = lines.findIndex((l) => /^USER\s+postgres\s*$/i.test(l.trim()));
    if (idx < 0) continue;
    lines.splice(idx, 1);
    const newContent = lines.join('\n');
    if (newContent === dockerfileContent) continue;
    fs.writeFileSync(issue.dockerfilePath, newContent, 'utf-8');
    applied.push({
      service: issue.service,
      dockerfilePath: issue.dockerfilePath,
      removedDirective: issue.userDirective,
    });
  }
  return applied;
}
