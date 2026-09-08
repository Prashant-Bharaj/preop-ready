import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { appendEvent } from './transcript.js';
import { sessionEvents } from './events.js';
import { accumulateAgentTotals } from './lifecycle.js';
import { tlog } from '../util/timestamped-log.js';
import { logAndSwallow } from '../util/log-helpers.js';
import { WORKSPACE_DIR } from '../core/paths.js';
import { detectPortConflicts } from '../util/port-conflicts.js';
import { scanComposeForBadDirectives, applyStrategyAFixes } from '../validators/docker/directive-validator.js';
import { scanComposeForHealthcheckConsistency, applyHealthcheckConsistencyFixes } from '../validators/docker/healthcheck-consistency-validator.js';
import { applyMgaEnvWiringFix } from '../validators/docker/mga-env-wiring-validator.js';
import { scanInitSqlForBadExtensions, applyInitSqlFixes, scanInitSqlForMissingCanonicalColumns, applyMissingCanonicalColumnFixes, scanInitSqlForDbSwitching, applyDbSwitchingFixes } from '../validators/db/init-sql-validator.js';
import { scanComposeForPgdataMisconfig, applyPgdataFixes, scanComposeForHealthcheckUserMismatch, applyHealthcheckUserFixes, scanDockerfilesForUserBeforeMkdir, applyUserBeforeMkdirFixes } from '../validators/db/pgdata-validator.js';
import { scanForMissingCanonicalFiles, applyCanonicalFixes } from '../validators/docker/canonical-file-validator.js';
import { scanComposeContainerNames, stripContainerNames } from '../validators/docker/compose-sanitizer.js';
import { scanForDependencyDrift, applyDependencyDriftFixes } from '../validators/code/dependency-drift-validator.js';
import { scanComposeForEnvVarNamingDrift, applyEnvVarNamingFixes } from '../validators/db/env-var-naming-validator.js';
import { scanComposeForCredentialDrift, applyCredentialConsistencyFixes } from '../validators/db/db-credential-consistency-validator.js';
import { scanFrontendForGhostImports, applyGhostImportFixes } from '../validators/code/ghost-import-validator.js';
import { scanBackendForEsmFootguns, applyEsmFootgunFixes } from '../validators/code/esm-footgun-validator.js';
import { flushReconcilerVerdicts } from '../util/telemetry-verdicts.js';
import { adoptLegitimateExtras } from '../agent/coordinator/contract-store.js';
import { readContracts } from './harness-state.js';
import { findReferenceTables, REFERENCE_DATA_FILE } from '../agent/coordinator/reference-data-generator.js';
import {
  COMPOSE_DEFAULT_MS,
  COMPOSE_BUILD_MS,
  COMPOSE_UP_MS,
  COMPOSE_DOWN_MS,
  COMPOSE_LOGS_MS,
  HTTP_PROBE_TOTAL_MS,
  HTTP_PROBE_POLL_MS,
  HTTP_PROBE_POLL_LIVE_MS,
  HTTP_PROBE_REQUEST_MS,
  RECONCILER_PHASE_TIMEOUT_MS,
  PER_SCOPE_REENGAGE_BUDGET,
  MAX_FIX_ATTEMPTS_PER_SCOPE,
  MAX_RECOVERY_TOKENS_PER_BUILD,
  MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE,
  LOCAL_DB_CREDENTIALS,
} from '../config/defaults.js';
import {
  probeApiEndpoints,
  checkComposeHealthAfterProbe,
  formatProbeFailures,
} from '../reconciler/endpoint-probe.js';
import { isMgaApp } from '../reconciler/mga-wiring-check.js';
import { runUiSanityCheck } from '../reconciler/ui-sanity-check.js';
import { readWorkspaceMgaEnv } from '../core/app-secrets-scaffold.js';

/**
 * Run a docker-compose sub-command, preferring `docker compose` (v2) and
 * falling back to `docker-compose` (v1). Returns { ok, stderr } — never throws.
 * `cmd` is the sub-command after compose (e.g. 'up -d', 'down').
 */
export function runCompose(cmd, { timeout = COMPOSE_DEFAULT_MS, captureStdout = false } = {}) {
  for (const binary of ['docker compose', 'docker-compose']) {
    try {
      const out = execSync(`${binary} ${cmd}`, {
        cwd: WORKSPACE_DIR,
        stdio: 'pipe',
        timeout,
      });
      return { ok: true, binary, stdout: captureStdout ? out.toString() : null };
    } catch (err) {
      // v2 may be unavailable → fall through to v1; v1 failing is a real error
      if (binary === 'docker compose' && /not found|unknown|is not a docker command/i.test(err.message || '')) continue;
      // Stderr capped at 4000 chars: enough to surface the actual compose
      // error (post-build "Bind 0.0.0.0:3000 failed", postgres init errors,
      // healthcheck failures) which typically lives at the END of stderr,
      // past the verbose build-phase output. Earlier 500-char cap kept
      // truncating the diagnostic itself, leaving us guessing at root
      // cause every t6 failure. The full stderr can be much larger; tail
      // it so the latest (most informative) lines survive.
      const rawStderr = err.stderr?.toString() || err.message || '';
      const stderrTail = rawStderr.length > 4000 ? rawStderr.slice(-4000) : rawStderr;
      return {
        ok: false,
        binary,
        stderr: stderrTail,
        stdout: captureStdout ? (err.stdout?.toString() || '') : null,
      };
    }
  }
  return { ok: false, binary: null, stderr: 'neither "docker compose" nor "docker-compose" available' };
}

/**
 * Rewrite host ports in `<workspace>/docker-compose.yml` by adding
 * `offset * 10` to every host-side port mapping. Used by the smoke harness's
 * parallel mode (smoke.js sets `SMOKE_PORT_OFFSET=<slotIndex>` per scenario)
 * so multiple scenarios running concurrently don't collide on host port 8080
 * or 3000. No-op if the file is missing or has no `ports:` blocks.
 *
 * Returns the list of remappings applied, or null if nothing changed.
 *
 * Conservative regex-based rewrite (no YAML parser) — handles the common
 * compose port-mapping forms the integration agent emits:
 *   - "8080:8080"          — quoted
 *   - 8080:8080            — bare
 *   - "8080:8080/tcp"      — with protocol
 * Does NOT touch bare `8080` (container-port-only, no host bind) or
 * `127.0.0.1:8080:8080` (explicit bind IP — rare in our flows).
 */
function applyPortOffsetToCompose(workspaceDir, offset) {
  if (!offset || offset <= 0) return null;
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!existsSync(composePath)) return null;
  const text = readFileSync(composePath, 'utf-8');
  const lines = text.split('\n');
  const out = [];
  const remappings = [];
  let inPortsBlock = false;
  let portsIndent = -1;
  for (const line of lines) {
    const lineIndent = (line.match(/^(\s*)/) || ['', ''])[1].length;
    if (inPortsBlock) {
      // Block ends when we hit a blank line or pop back to ≤ ports' indent.
      if (line.trim() === '' || lineIndent <= portsIndent) {
        inPortsBlock = false;
        // Fall through to the regular line-handling below (which may also
        // detect a new `ports:` opener on this line).
      } else {
        // Inside the ports block — rewrite the first <host>:<container> on the line.
        const replaced = line.replace(
          /(["']?)(\d+):(\d+)(\/[a-z]+)?(["']?)/,
          (_m, q1, host, ctr, proto, q2) => {
            const newHost = parseInt(host, 10) + offset * 10;
            remappings.push({ from: `${host}:${ctr}`, to: `${newHost}:${ctr}` });
            return `${q1}${newHost}:${ctr}${proto || ''}${q2}`;
          },
        );
        out.push(replaced);
        continue;
      }
    }
    const portsMatch = line.match(/^(\s*)ports:\s*$/);
    if (portsMatch) {
      inPortsBlock = true;
      portsIndent = portsMatch[1].length;
    }
    out.push(line);
  }
  if (remappings.length === 0) return null;
  writeFileSync(composePath, out.join('\n'), 'utf-8');
  return remappings;
}

/**
 * Poll a URL until it returns any HTTP response (any status code), or timeout.
 * Used to wait for a backend/frontend to accept connections after
 * `compose up -d`. Returns the last status seen (or null on timeout).
 */
async function waitForHttp(url, { timeoutMs = HTTP_PROBE_TOTAL_MS, intervalMs = HTTP_PROBE_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_PROBE_REQUEST_MS) });
      lastStatus = res.status;
      if (res.status < 500) return { ok: true, status: res.status, error: null };
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, status: lastStatus, error: lastError };
}

/**
 * Scan backend container logs for error-shaped lines. Runtime errors (DB
 * connection failures, uncaught exceptions, 5xx responses) show up here even
 * when `compose up` technically succeeded — the container is "up" but the
 * app inside is crashing on every request.
 *
 * Returns up to `maxLines` suspicious lines plus the last 40 lines of log
 * for context, or null when the logs look clean.
 */
function scanBackendLogsForErrors({ maxLines = 10 } = {}) {
  const result = runCompose('logs backend --tail=80 --no-color', { captureStdout: true, timeout: COMPOSE_LOGS_MS });
  const logs = result.stdout || '';
  if (!logs.trim()) return null;

  const errorPattern = /\b(error|exception|traceback|econnrefused|eaddrinuse|unhandledrejection|cannot connect|failed to|getaddrinfo|fatal)\b/i;
  const errorLines = logs
    .split('\n')
    .filter(l => errorPattern.test(l))
    .slice(-maxLines);

  if (errorLines.length === 0) return null;
  return {
    errorLines,
    tail: logs.split('\n').slice(-40).join('\n'),
  };
}

/**
 * Run the deterministic pre-flight validators that mutate the workspace
 * before `docker compose build/up`. Each validator is best-effort: failure
 * is logged and the chain continues. Order matters in some cases (e.g. the
 * directive scan may add downgrades that the healthcheck-consistency check
 * then sees) — keep the original sequence.
 */
async function applyAllValidators(session) {
  // MGA env wiring: if the workspace .env carries MGA_* credentials, the
  // backend service must load them. Deterministic (yaml patch); covers the
  // iterate-introduces-AI path where integration never re-dispatches, and
  // heals existing apps on their next start.
  try {
    const wiring = applyMgaEnvWiringFix(WORKSPACE_DIR);
    if (wiring.applied) {
      tlog('[session] Auto-start: MGA env wiring fix — %s', wiring.reason);
      const fixEvent = appendEvent(session.id, 'cline', {
        say: 'text',
        text: 'Pre-start auto-correction: wired the workspace `.env` (MGA credentials) into the backend service in `docker-compose.yml`.',
      });
      sessionEvents.emit('event', session.id, fixEvent);
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: MGA env wiring fix failed (non-fatal)');
  }

  // Pre-flight directive scan: catch the bug class where a healthcheck (or
  // other compose directive) invokes a binary that isn't on the chosen base
  // image's PATH (e.g. `curl` in a chromadb/chroma healthcheck). `compose
  // build` returns 0 — healthchecks aren't validated at build — but `compose
  // up` then fails at runtime. Prompt-side guidance has been observed to
  // miss this repeatedly, so we apply Strategy A in code: strip the broken
  // directive and downgrade dependents from service_healthy to
  // service_started. Best-effort; any failure logs and falls through.
  try {
    const issues = scanComposeForBadDirectives(WORKSPACE_DIR);
    if (issues.length) {
      const applied = applyStrategyAFixes(WORKSPACE_DIR, issues);
      if (applied.length) {
        tlog('[session] Auto-start: applied %d directive fix(es) before compose up', applied.length);
        const lines = applied.map((a) => {
          const tail = a.downgraded.length
            ? `; downgraded depends_on(${a.downgraded.join(', ')}) → service_started`
            : '';
          return `- \`${a.service}\` (image \`${a.image}\`): removed healthcheck — image lacks \`${a.missingBin}\`${tail}`;
        });
        const text =
          `Pre-start auto-correction in \`docker-compose.yml\`:\n${lines.join('\n')}\n\n` +
          `The verification step missed this — these directives would have failed at runtime even though \`docker-compose build\` passed. Applied Strategy A: stripped the broken directive, fell back to base-image defaults.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: directive scan failed (non-fatal)');
  }

  // Pre-flight healthcheck-consistency scan: catch the case where a service
  // is referenced via `depends_on: condition: service_healthy` but the
  // referenced service has no `healthcheck:` block. directive-validator
  // strips healthchecks for missing-binary cases AND downgrades dependents;
  // this validator catches the case where the healthcheck was never written
  // in the first place.
  try {
    const hcIssues = scanComposeForHealthcheckConsistency(WORKSPACE_DIR);
    if (hcIssues.length) {
      const hcApplied = applyHealthcheckConsistencyFixes(WORKSPACE_DIR, hcIssues);
      if (hcApplied.length) {
        tlog('[session] Auto-start: applied %d healthcheck-consistency fix(es) before compose up', hcApplied.length);
        const lines = hcApplied.map((a) =>
          `- \`${a.depender}\` depends_on \`${a.dependency}\`: \`service_healthy\` → \`service_started\` (\`${a.dependency}\` has no healthcheck block)`
        );
        const text =
          `Pre-start auto-correction in \`docker-compose.yml\`:\n${lines.join('\n')}\n\n` +
          `Detected services that wait on \`condition: service_healthy\` for a dependency that has no \`healthcheck:\` block. \`compose up -d\` would have hung waiting for a healthcheck that never reports, eventually returning ok=false. Downgraded the dependent's condition to \`service_started\` so the chain still waits for the dependency to start, just not for a healthcheck that doesn't exist.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: healthcheck-consistency scan failed (non-fatal)');
  }

  // Pre-flight init.sql ↔ Dockerfile cross-check. Catches the bug class
  // where init.sql says `CREATE EXTENSION vector;` but the Dockerfile is
  // `FROM postgres:16` — `compose build` passes (extensions aren't
  // installed at build), but on `compose up` the postgres entrypoint runs
  // the init scripts and exits non-zero with "extension X is not
  // available". Same code-level safety-net pattern as the directive
  // validator. Best-effort.
  try {
    const initIssues = scanInitSqlForBadExtensions(WORKSPACE_DIR);
    if (initIssues.length) {
      const initFixes = applyInitSqlFixes(WORKSPACE_DIR, initIssues);
      if (initFixes.length) {
        tlog('[session] Auto-start: applied %d init.sql / Dockerfile FROM fix(es) before compose up', initFixes.length);
        const lines = initFixes.map((f) =>
          `- \`${f.service}/Dockerfile\`: \`${f.previousImage}\` → \`${f.newImage}\` (reason: ${f.reasons.join('; ')})`
        );
        const text =
          `Pre-start auto-correction in service Dockerfile FROM lines:\n${lines.join('\n')}\n\n` +
          `Detected \`CREATE EXTENSION\` calls in init.sql that the original base image doesn't ship. ` +
          `Switched to a compatible image so the postgres entrypoint can load the extension on first start.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: init-sql scan failed (non-fatal)');
  }

  // DB-switching statements in init scripts (CREATE DATABASE / \connect) put
  // the schema in a database the app never connects to — always wrong in
  // docker-entrypoint-initdb.d, which already targets POSTGRES_DB. Observed
  // live as `relation "doc_chunks" does not exist` after a gate-fix agent
  // wrote CREATE DATABASE stub_db into the vectordb init. Deterministic
  // strip; best-effort.
  try {
    const switchIssues = scanInitSqlForDbSwitching(WORKSPACE_DIR);
    if (switchIssues.length) {
      const switchFixes = applyDbSwitchingFixes(WORKSPACE_DIR, switchIssues);
      if (switchFixes.length) {
        tlog('[session] Auto-start: commented out %d DB-switching init.sql line(s) before compose up', switchFixes.length);
        const lines = switchFixes.map((f) => `- \`${f.sqlFile}:${f.line}\`: \`${f.statement}\``);
        const text =
          `Pre-start auto-correction in database init scripts:\n${lines.join('\n')}\n\n` +
          `Init scripts run against the service's own POSTGRES_DB — creating or switching databases inside them puts the tables where the app never looks. Commented those lines out.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: init-sql db-switching scan failed (non-fatal)');
  }

  // Pre-flight PGDATA-vs-volume-mount cross-check. Catches the bug class
  // where a Dockerfile sets `ENV PGDATA=/data/postgres` and the compose
  // service mounts a volume directly onto that same path. `compose build`
  // passes (the Dockerfile is valid). On `compose up`, docker mounts a
  // fresh root-owned named volume at the postgres data path and the
  // postgres entrypoint exits 3 with permission/initdb errors. Same
  // code-level safety-net pattern as the directive / init-sql validators.
  // Fix: move PGDATA to a subdir of the mount (`/data/postgres/pgdata`)
  // so the entrypoint creates and owns it cleanly. Best-effort.
  try {
    const pgdataIssues = scanComposeForPgdataMisconfig(WORKSPACE_DIR);
    if (pgdataIssues.length) {
      const pgdataFixes = applyPgdataFixes(WORKSPACE_DIR, pgdataIssues);
      if (pgdataFixes.length) {
        tlog('[session] Auto-start: applied %d PGDATA-vs-volume-mount fix(es) before compose up', pgdataFixes.length);
        const lines = pgdataFixes.map((f) =>
          `- \`${f.service}/Dockerfile\`: \`PGDATA=${f.previousPgdata}\` → \`PGDATA=${f.recommendedPgdata}\` (volume \`${f.mountTarget}\` was mounting onto the data dir)`
        );
        const text =
          `Pre-start auto-correction in service Dockerfile PGDATA paths:\n${lines.join('\n')}\n\n` +
          `Detected a Dockerfile \`ENV PGDATA\` whose target is the same path as a compose volume mount. The mount sits as a fresh root-owned dir, blocking postgres' initdb. Moved PGDATA to a subdir of the mount so the entrypoint can take ownership cleanly.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: pgdata scan failed (non-fatal)');
  }

  // Pre-flight check for `USER postgres` directives that aren't preceded by
  // a `RUN ... mkdir ... chown ... postgres` line. Postgres-derived images
  // (postgres, pgvector/pgvector) need either root or a pre-prepared PGDATA
  // dir to bootstrap initdb. When the agent emits `USER postgres` without
  // first creating + chowning the PGDATA target, the entrypoint exits 1
  // with "mkdir: cannot create directory '/data': Permission denied" on
  // first start. Build PASSED but runtime crashes — same shape as pgdata-
  // misconfig. Observed on t32-doc-search-api (2026-05-08).
  // Fix: remove the USER directive. The image's gosu-based entrypoint
  // drops privileges to the postgres user when needed.
  // Anti-overrestriction: only fires when (1) FROM is postgres-derived AND
  // (2) USER directive exists AND (3) no preceding mkdir+chown protects
  // PGDATA. Other images' USER directives are left alone.
  try {
    const userIssues = scanDockerfilesForUserBeforeMkdir(WORKSPACE_DIR);
    if (userIssues.length) {
      const userFixes = applyUserBeforeMkdirFixes(WORKSPACE_DIR, userIssues);
      if (userFixes.length) {
        tlog('[session] Auto-start: applied %d USER-before-mkdir fix(es) before compose up', userFixes.length);
        const lines = userFixes.map((f) =>
          `- \`${f.service}/Dockerfile\`: removed \`${f.removedDirective}\` (no preceding \`RUN mkdir ... chown postgres\`; entrypoint would have failed at first start)`
        );
        const text =
          `Pre-start auto-correction in service Dockerfiles:\n${lines.join('\n')}\n\n` +
          `Detected \`USER postgres\` directive(s) in postgres-derived Dockerfile(s) without a preceding \`RUN mkdir + chown\` to prepare PGDATA. The postgres entrypoint can't create its data dir as the postgres user, so the container exits 1 on first start. Removed the USER directive; the image's gosu-based entrypoint handles privilege dropping internally.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: USER-before-mkdir scan failed (non-fatal)');
  }

  // Pre-flight env-var-naming check on backend service. The platform's
  // canonical names for AWS-injected env vars (DATABASE_HOST, _PORT, _NAME,
  // _USER, _PASSWORD, _URL for database; VECTORDB_* equivalents) are FIXED
  // and engine-independent — backend code reads `process.env.DATABASE_HOST`
  // regardless of whether the database service is postgres or MySQL. The
  // router improvises non-canonical abbreviations (DB_HOST, MYSQL_HOST,
  // PG_HOST) in its task.task prose; downstream agents follow the prose.
  // Locally this works (compose sets whatever) but production AWS injects
  // the canonical names → backend can't read them → connection fails.
  // Observed on t36-mysql-shop (2026-05-08): backend env had DB_HOST,
  // DB_PORT, DB_NAME etc. instead of DATABASE_*. Fix: rewrite backend
  // service env keys to canonical. Database service env (POSTGRES_DB,
  // MYSQL_DATABASE, etc.) is left untouched — those are correct on the
  // image side. See `.platform-rules/reference/secrets.md` for the
  // canonical name list.
  try {
    const envIssues = scanComposeForEnvVarNamingDrift(WORKSPACE_DIR);
    if (envIssues.length) {
      const envFixes = applyEnvVarNamingFixes(WORKSPACE_DIR, envIssues);
      if (envFixes.length) {
        tlog('[session] Auto-start: applied %d env-var-naming fix(es) before compose up', envFixes.length);
        const lines = envFixes.map((f) =>
          `- \`docker-compose.yml\` (service \`${f.service}\`): \`${f.from}\` → \`${f.to}\``
        );
        const text =
          `Pre-start auto-correction in docker-compose.yml backend env-var names:\n${lines.join('\n')}\n\n` +
          `Detected non-canonical env var names (DB_HOST, MYSQL_HOST, etc.) on the backend service. AWS injects these as DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD in production regardless of database engine. Local compose must use the same canonical names so backend code's \`process.env.DATABASE_HOST\` works in both contexts. Renamed to canonical.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: env-var-naming scan failed (non-fatal)');
  }

  // DB credential consistency. Runs AFTER env-var-naming so the backend's keys
  // are already canonical (DATABASE_*). Enforces ONE authoritative credential
  // set (LOCAL_DB_CREDENTIALS) across the db service (POSTGRES_*) and the
  // backend service (DATABASE_*): the integration agent sometimes renames the
  // database/user to the project theme and applies it to one service but not
  // the other, so the backend authenticates against a database/user that
  // doesn't exist → backend container never goes healthy → compose up fails.
  // Layer 1 (synthesized DB report + common.md) tells the agents the fixed
  // values; this is the deterministic backstop that guarantees them.
  try {
    const credIssues = scanComposeForCredentialDrift(WORKSPACE_DIR);
    if (credIssues.length) {
      const credFixes = applyCredentialConsistencyFixes(WORKSPACE_DIR, credIssues);
      if (credFixes.length) {
        tlog('[session] Auto-start: applied %d DB-credential-consistency fix(es) before compose up', credFixes.length);
        const lines = credFixes.map((f) =>
          `- \`docker-compose.yml\` (service \`${f.service}\`): \`${f.key}\` \`${f.from}\` → \`${f.to}\``
        );
        const text =
          `Pre-start auto-correction in docker-compose.yml DB credentials:\n${lines.join('\n')}\n\n` +
          `The database and backend services disagreed on the connection credentials (or diverged from the fixed local-dev values). The backend connects to the db service by these exact values, so a mismatch makes the backend unable to authenticate. Reconciled both services to the canonical local-dev credentials.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: DB-credential-consistency scan failed (non-fatal)');
  }

  // Pre-flight ghost-import check on frontend/src. Frontend agent
  // sometimes writes JSX files containing default-imports of components
  // it never actually wrote (e.g., NewRequestForm imports DatePicker
  // from '../components/DatePicker' but no DatePicker.jsx exists).
  // Vite/webpack build then fails: `Could not resolve "..."`.
  // Auto-fix writes a stub at the resolved path:
  //   - Canonical UI primitives (DatePicker, Modal, Toast, Spinner,
  //     ConfirmModal, LoadingIndicator, ErrorBoundary, StatusBadge) →
  //     functional minimal implementation that actually works.
  //   - Unknown component names → soft-stub `() => null` so build
  //     succeeds; the missing feature renders nothing visible. SOFT-WARN
  //     surfaces visibility so user knows agent left a placeholder.
  // Observed on t39-time-off-full-stack (2026-05-08): frontend agent
  // wrote `import DatePicker from '../components/DatePicker'` and its
  // own completion report acknowledged "Build will fail; the fix is
  // straightforward but was not completed before finalization."
  try {
    const ghostIssues = scanFrontendForGhostImports(WORKSPACE_DIR);
    if (ghostIssues.length) {
      const ghostFixes = applyGhostImportFixes(WORKSPACE_DIR, ghostIssues);
      if (ghostFixes.length) {
        const canonicalCount = ghostFixes.filter((f) => f.kind === 'canonical').length;
        const softStubCount = ghostFixes.filter((f) => f.kind === 'soft-stub').length;
        const skipCount = ghostFixes.filter((f) => f.kind === 'skip').length;
        tlog('[session] Auto-start: applied %d ghost-import fix(es) (canonical=%d, soft-stub=%d, skip=%d) before compose up',
          ghostFixes.length, canonicalCount, softStubCount, skipCount);
        const lines = ghostFixes
          .filter((f) => f.kind !== 'skip')
          .map((f) => {
            const relStub = path.relative(WORKSPACE_DIR, f.stubPath);
            const tag = f.kind === 'canonical' ? '✓ canonical' : '⚠ soft-stub';
            return `- \`${relStub}\` (\`${f.componentName}\`) — ${tag}`;
          });
        const skipLines = ghostFixes
          .filter((f) => f.kind === 'skip')
          .map((f) => `- ${path.relative(WORKSPACE_DIR, f.sourceFile)} imports \`${f.importPath}\` (named-only, no default; no auto-stub possible)`);
        const text =
          `Pre-start auto-correction in frontend/src:\n${lines.join('\n')}\n` +
          (skipLines.length ? `\n_Skipped (no auto-fix):_\n${skipLines.join('\n')}\n` : '') +
          `\nDetected ES6 imports referencing files the frontend agent never wrote. Canonical UI primitives auto-stubbed with functional minimal implementations; unknown component names auto-stubbed with \`() => null\` placeholders so the build succeeds. Replace soft-stubs with real implementations to restore the features that render nothing currently.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: ghost-import scan failed (non-fatal)');
  }

  // Pre-flight ESM-footgun check. An ESM backend ("type": "module") that uses
  // `__dirname`/`__filename` passes tsc (valid TS with @types/node) but throws
  // `ReferenceError: __dirname is not defined` at import time → container
  // exits(1) → compose up fails. Inject the standard ESM shim so it boots.
  try {
    const esmIssues = scanBackendForEsmFootguns(WORKSPACE_DIR);
    if (esmIssues.length) {
      const esmFixes = applyEsmFootgunFixes(WORKSPACE_DIR, esmIssues);
      if (esmFixes.length) {
        tlog('[session] Auto-start: applied %d ESM-footgun fix(es) before compose up', esmFixes.length);
        const lines = esmFixes.map((f) => `- \`${path.relative(WORKSPACE_DIR, f.file)}\` — shimmed ${f.needs.join(', ')}`);
        const fixEvent = appendEvent(session.id, 'cline', {
          say: 'text',
          text: `Pre-start auto-correction in backend (ESM):\n${lines.join('\n')}\n\nThis backend is \`"type": "module"\`, where \`__dirname\`/\`__filename\` are undefined at runtime (they pass \`tsc\` but crash on boot). Injected the standard \`import.meta.url\` shim so the container starts.`,
        });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: ESM-footgun scan failed (non-fatal)');
  }

  // Pre-flight init.sql canonical-column-presence check. Catches the bug
  // class where backend code references a known canonical column (e.g.,
  // `oidc_sub` for ALB OIDC integration) but the database's init.sql
  // CREATE TABLE doesn't declare it. `compose build` passes (init.sql
  // syntax is fine); at runtime, backend's first query fails with
  // `column "oidc_sub" does not exist`, container exits, run ok=false.
  // LLM-only schema-contract checks routinely miss this; static check is robust.
  // Anti-overrestriction: only fires for columns in CANONICAL_COLUMNS
  // (well-defined types, recurring patterns). Custom column names the
  // agent invented are NOT auto-added — agent's responsibility, fails
  // honestly. Fix is append-only ALTER TABLE; never modifies existing
  // CREATE TABLE columns.
  // Observed on t31 ORCH (2026-05-04 Step 5c verification gate).
  try {
    const colIssues = scanInitSqlForMissingCanonicalColumns(WORKSPACE_DIR);
    if (colIssues.length) {
      const colFixes = applyMissingCanonicalColumnFixes(WORKSPACE_DIR, colIssues);
      if (colFixes.length) {
        tlog('[session] Auto-start: applied %d canonical-column fix(es) before compose up', colFixes.length);
        const lines = colFixes.map((f) =>
          `- \`${f.sqlFile}\`: appended \`ALTER TABLE ${f.table} ADD COLUMN ${f.column}\` (backend code references it but CREATE TABLE didn't declare it)`
        );
        const text =
          `Pre-start auto-correction in init.sql:\n${lines.join('\n')}\n\n` +
          `Detected backend references to canonical columns (e.g., \`oidc_sub\` for OIDC auth) that the database schema didn't declare. Appended ALTER TABLE; the migration runs on first \`compose up\` so the backend's first query succeeds.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: canonical-column scan failed (non-fatal)');
  }

  // Pre-flight pg_isready healthcheck-user consistency check. Catches the
  // bug class where a database service has both `environment.POSTGRES_USER:
  // tasks_user` and `healthcheck: pg_isready -U postgres` — compose build
  // passes (both are valid in isolation), but at runtime the healthcheck
  // queries with a role that doesn't exist in the freshly-initialized
  // database. Healthcheck fails, dependent services with
  // `condition: service_healthy` never start, run reports ok=false.
  // Observed on t31 ORCH (2026-05-04 Step 5c verification gate).
  // Anti-overrestriction: only fires when there's an actual mismatch.
  // Default postgres-vs-postgres is fine; agent's intentional non-default
  // values get respected, healthcheck just rewritten to match.
  try {
    const hcIssues = scanComposeForHealthcheckUserMismatch(WORKSPACE_DIR);
    if (hcIssues.length) {
      const hcFixes = applyHealthcheckUserFixes(WORKSPACE_DIR, hcIssues);
      if (hcFixes.length) {
        tlog('[session] Auto-start: applied %d healthcheck-user mismatch fix(es) before compose up', hcFixes.length);
        const lines = hcFixes.map((f) =>
          `- \`${f.service}\` healthcheck: \`${f.previousCmd}\` → \`${f.newCmd}\` (matched POSTGRES_USER=${f.recommendedUser}${f.recommendedDb ? ', POSTGRES_DB=' + f.recommendedDb : ''})`
        );
        const text =
          `Pre-start auto-correction in \`docker-compose.yml\`:\n${lines.join('\n')}\n\n` +
          `Detected \`pg_isready -U <user>\` in healthcheck that didn't match the service's \`POSTGRES_USER\` env. The healthcheck would have failed at runtime even though build PASSED. Rewrote the healthcheck to match the env values.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: healthcheck-user scan failed (non-fatal)');
  }

  // Pre-flight canonical-file scan. Catches the bug class where a producing
  // agent's Dockerfile contains `COPY <name> ...` referencing a canonical
  // platform filename (e.g., `nginx.conf`), but no agent ever wrote that
  // file to disk. Build then fails with "failed to compute cache key:
  // ... not found". A simple Dockerfile-exists check doesn't verify that
  // its COPY paths resolve.
  // Anti-overrestriction guardrail: the validator's CANONICAL_FILE_MAP only
  // lists known platform filenames. Custom filenames the agent invented
  // are NOT auto-fixed — they fail honestly via the graceful-skip path.
  // Observed on t30 ORCH (2026-05-04 Step 5c verification gate).
  try {
    const canonicalIssues = scanForMissingCanonicalFiles(WORKSPACE_DIR);
    if (canonicalIssues.length) {
      const canonicalFixes = applyCanonicalFixes(WORKSPACE_DIR, canonicalIssues);
      if (canonicalFixes.length) {
        tlog('[session] Auto-start: applied %d canonical-file fix(es) before compose up', canonicalFixes.length);
        const lines = canonicalFixes.map((f) =>
          `- \`${f.missingPath}\`: created from canonical \`${f.snippet}\` (${f.scope}/Dockerfile referenced \`${f.copyName}\` but no agent wrote it)`
        );
        const text =
          `Pre-start auto-correction in workspace files:\n${lines.join('\n')}\n\n` +
          `Detected Dockerfile \`COPY\` directives referencing canonical platform filenames where the file was missing on disk. Filled from \`snippets/\`.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: canonical-file scan failed (non-fatal)');
  }

  // ── Dependency drift: backfill missing Node deps in package.json ──
  // Catches the bug class where backend/frontend source `require()` /
  // `import`s a package that isn't listed in package.json. `npm ci` (run by
  // the Dockerfile build) fails with "Cannot find module 'foo'" before any
  // app code runs. We scan source files for non-relative, non-builtin import
  // specifiers, compare against the matching package.json's deps, and
  // append any missing names with version "*" (npm resolves at install time).
  // Conservative: add-only, never remove unused.
  try {
    const ddIssues = scanForDependencyDrift(WORKSPACE_DIR);
    if (ddIssues.length) {
      const ddApplied = applyDependencyDriftFixes(WORKSPACE_DIR, ddIssues);
      if (ddApplied.length) {
        const totalAdded = ddApplied.reduce((n, a) => n + a.added.length, 0);
        tlog('[session] Auto-start: backfilled %d missing Node dep(s) before compose build', totalAdded);
        const lines = ddApplied.flatMap((a) =>
          a.added.map((pkg) => `- \`${a.scope}/package.json\`: added \`${pkg}\` (was imported in source but not declared)`)
        );
        const text =
          `Pre-start auto-correction (Node dependency drift):\n${lines.join('\n')}\n\n` +
          `Source files \`require()\`d / imported these packages, but they weren't listed in \`dependencies\`. ` +
          `\`npm ci\` would have failed at \`docker-compose build\` time. Added each with version \`"*"\` so npm resolves to the latest published version on install.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: dependency-drift scan failed (non-fatal)');
  }

  // ── Compose sanitizer: strip `container_name:` overrides ──
  // Phase agents sometimes add `container_name: <service>` to compose.yml,
  // which makes the container name GLOBAL to the docker daemon (defeats
  // compose's project-prefix isolation). Two scenarios using the same
  // fixed name collide: "container name backend already in use." Observed
  // t31 in 2026-05-05 gate at parallel=1. None of the canonical compose
  // snippets use `container_name:` — agent invented it.
  try {
    const cnScan = scanComposeContainerNames(WORKSPACE_DIR);
    if (cnScan.count > 0) {
      const stripped = stripContainerNames(WORKSPACE_DIR);
      if (stripped > 0) {
        tlog('[session] Auto-start: stripped %d `container_name:` line(s) from docker-compose.yml before compose up', stripped);
        const text =
          `Pre-start auto-correction in docker-compose.yml: stripped ${stripped} \`container_name:\` line(s).\n\n` +
          `These override docker-compose's default project-prefixed naming, making container names global to the docker daemon. ` +
          `Two scenarios using the same fixed name collide. The canonical compose templates omit \`container_name:\` for this reason.`;
        const fixEvent = appendEvent(session.id, 'cline', { say: 'text', text });
        sessionEvents.emit('event', session.id, fixEvent);
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: compose-sanitizer scan failed (non-fatal)');
  }
}

/**
 * Emit the "starting" UI event, apply smoke port-offset, stop any prior
 * containers, and bail out if a host port is already taken. Returns false
 * when a port conflict was detected (caller has already received a
 * user-visible event and must abort the boot); true otherwise.
 */
async function prepareForCompose(session) {
  // NOTE: we deliberately do NOT announce "Starting your app" here — this runs
  // BEFORE the cross-scope reconciler + auto-recovery (which can take minutes of
  // LLM work). Announcing the start now made the wait read as "starting is
  // stuck". The actual start is announced in buildAndStartContainers, right
  // before `docker compose build/up`.

  // Smoke parallel-mode: if SMOKE_PORT_OFFSET > 0, shift every host port in
  // the generated compose file by (offset * 10) so multiple parallel smoke
  // scenarios don't collide on host port 8080. No-op outside smoke (offset
  // unset or 0). Best-effort; any failure logs and continues with original ports.
  try {
    const offset = parseInt(process.env.SMOKE_PORT_OFFSET || '0', 10);
    if (offset > 0) {
      const remappings = applyPortOffsetToCompose(WORKSPACE_DIR, offset);
      if (remappings && remappings.length) {
        tlog('[session] Auto-start: applied SMOKE_PORT_OFFSET=%d → %s',
          offset, remappings.map((r) => `${r.from}→${r.to}`).join(', '));
      }
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: port-offset rewrite failed (non-fatal)');
  }

  // Stop any prior containers first so ports are free. Best-effort.
  runCompose('down', { timeout: COMPOSE_DOWN_MS });

  // Pre-flight host-port conflict check. Catches the common case where
  // another dev container (e.g. dd-template-repo-spike-backend-1) is
  // already binding port 3000 — compose up would otherwise spend minutes
  // on builds before failing with a generic "Bind for 0.0.0.0:3000
  // failed". Detect, name the offender, skip cleanly. Best-effort.
  try {
    const conflicts = await detectPortConflicts(WORKSPACE_DIR);
    if (conflicts.length) {
      const lines = conflicts.map((c) => {
        const holder = c.holder ? `held by container \`${c.holder}\`` : 'held by an unknown process';
        return `- Host port \`${c.port}\` (compose service \`${c.service}\`) is ${holder}`;
      });
      tlog('[session] Auto-start skipped — port conflict on %s',
        conflicts.map((c) => `${c.port}${c.holder ? `→${c.holder}` : ''}`).join(', '));
      const text =
        `Cannot start your app — host port collision detected:\n\n${lines.join('\n')}\n\n` +
        `Stop the conflicting container(s), then click **Run locally** to retry. ` +
        `If the holder is another \`docker compose\` project, \`docker compose down\` from that project's directory will free the port.`;
      const conflictEvent = appendEvent(session.id, 'cline', { say: 'text', text });
      sessionEvents.emit('event', session.id, conflictEvent);
      return false;
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: port conflict check failed (non-fatal)');
  }

  return true;
}

/**
 * Run the cross-scope reconciler: extract → compare → judge-extras →
 * promote-to-soft-mismatch → per-scope re-engage (per-scope budget
 * PER_SCOPE_REENGAGE_BUDGET), with a final-pass compare to capture the
 * LAST re-engage's effects. Returns false on unresolved hard mismatches
 * (caller has already emitted a user-visible diagnostic and must abort
 * the boot); true otherwise. Non-fatal: any thrown error is logged and
 * the function returns true so the build still proceeds — the reconciler
 * is advisory, not load-bearing. The whole phase is bounded by
 * RECONCILER_PHASE_TIMEOUT_MS; on timeout the loop aborts with whatever
 * mismatches were last seen and lets the final-pass + diagnostic emit
 * as usual.
 */
async function runReconcilerLoop(session, routerContracts, scopeCounters, { contractAgentMessages = null } = {}) {
  const phaseStart = Date.now();
  const phaseDeadline = phaseStart + RECONCILER_PHASE_TIMEOUT_MS;
  // W3.RECOV — `scopeCounters` is a shared `Map<scope, { reengages, fixAttempts }>`
  // owned by the calling auto-start flow. The reconciler tracks `.reengages`
  // here (same semantics as the prior `reengageCount` Map); the auto-recovery
  // loop tracks `.fixAttempts` separately. Both kinds of per-scope budgets
  // live on the same map so a single scope's drift across the build is
  // visible to both loops (and to telemetry consumers downstream).
  let timedOut = false;
  tlog('[reconciler-loop] start: budget=%d/scope timeout=%dms',
    PER_SCOPE_REENGAGE_BUDGET, RECONCILER_PHASE_TIMEOUT_MS);

  // Surface the cross-scope reconciler as a first-class "verification" phase
  // card (it was previously invisible — only tlog). Emits a scope card the UI
  // already knows how to render (PHASE1_SCOPES has 'verification'): a live
  // "working" heartbeat while we check, then a one-line result.
  let verifHardFailed = false;
  const emitVerif = (payload) => {
    const ev = appendEvent(session.id, 'cline', { ...payload, scope: 'verification' });
    sessionEvents.emit('event', session.id, ev);
  };
  const emitVerifStatus = (status, exitCode = 0) => {
    const ev = appendEvent(session.id, 'scope_status', { scope: 'verification', status, exitCode });
    sessionEvents.emit('event', session.id, ev);
  };
  emitVerifStatus('running');
  emitVerif({
    say: 'text',
    text: 'Checking the generated app fits together — frontend calls match backend routes, the columns it reads exist in the schema, and there are no missing imports.',
  });

  // Per-step timing: each surfaced step carries the seconds since the previous
  // step, so the verification card shows where the time goes.
  let lastStepTs = Date.now();
  const fmtSecs = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000).toString());
  const stepSecs = () => { const d = Date.now() - lastStepTs; lastStepTs = Date.now(); return fmtSecs(d); };
  const emitVerifStep = (text) => emitVerif({ say: 'text', text: `${text} · ${stepSecs()}s` });

  const getReengages = (scope) => (scopeCounters.get(scope)?.reengages || 0);
  const bumpReengages = (scope) => {
    const cur = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
    scopeCounters.set(scope, { ...cur, reengages: cur.reengages + 1 });
  };
  const reengagesSnapshot = () => Object.fromEntries(
    Array.from(scopeCounters.entries()).map(([s, c]) => [s, c.reengages || 0])
  );

  try {
    const { extractBackendRoutes } = await import('../reconciler/extract-backend-routes.js');
    const { extractFrontendFetches } = await import('../reconciler/extract-frontend-fetches.js');
    const { extractDbSchema } = await import('../reconciler/extract-db-schema.js');
    const { compareScopes } = await import('../reconciler/compare.js');
    const { judgeExtras } = await import('../reconciler/judge-extras.js');
    const { reengageScopeForMismatch } = await import('../reconciler/reengage.js');
    const { formatHardFailDiagnostic, formatSoftDeviationNote } = await import('../reconciler/format.js');
    const { runSqlPrepareGate } = await import('../reconciler/sql-prepare-gate.js');
    const { extractRuntimeRoutes } = await import('../reconciler/extract-routes-runtime.js');

    // SQL column validation via the Postgres-PREPARE oracle (replaces the regex
    // column check removed from compare.js). Merges hard findings into a compare
    // result so they flow through the same log → re-engage → block path. Fails
    // open: any gate error / unavailable validator → no findings, never blocks.
    const mergeSqlGate = async (cmp) => {
      try {
        const gate = await runSqlPrepareGate(WORKSPACE_DIR, { sessionId: session.id });
        if (gate.ran && gate.findings.length) {
          cmp.mismatches = cmp.mismatches.concat(gate.findings);
        }
      } catch { /* fail-open */ }
      return cmp;
    };

    // W3.TEL — session-level in-memory mirror of every verdict the reconciler
    // emits this build. The mirror is what writeRunSummary reads at end-of-
    // build to populate `reconcilerVerdicts: { ok, mismatch, legitimate, noise }`.
    // The jsonl on disk is the source of truth; the mirror just avoids
    // re-reading + parsing it right before writing the run-summary.
    session.reconcilerVerdictCounts = session.reconcilerVerdictCounts
      || { ok: 0, mismatch: 0, legitimate: 0, noise: 0 };
    const verdictSink = (record) => {
      const v = record?.verdict;
      if (v && Object.prototype.hasOwnProperty.call(session.reconcilerVerdictCounts, v)) {
        session.reconcilerVerdictCounts[v]++;
      }
    };

    let attempt = 0;
    let allMismatches = [];
    let extras = [];
    // Iterate dispatches hand the reconciler a routerContracts whose contract
    // fields are null (diffs carry the change; full contract lives on disk).
    // Fall back to the envelope so extras/adoption compare against the app's
    // real contract instead of nothing — same fallback the visual check uses.
    if (!Array.isArray(routerContracts?.apiContract?.endpoints)) {
      try {
        const envData = readContracts(WORKSPACE_DIR)?.data;
        if (envData?.apiContract?.endpoints) {
          routerContracts = { ...routerContracts, apiContract: envData.apiContract };
          tlog('[reconciler-loop] apiContract missing from dispatch — hydrated from envelope (%d endpoints)',
            envData.apiContract.endpoints.length);
        }
      } catch (err) { logAndSwallow(err, '[reconciler-loop] envelope hydrate failed'); }
    }
    while (true) {
      if (Date.now() > phaseDeadline) {
        timedOut = true;
        tlog('[reconciler-loop] phase timeout after %dms — aborting loop before attempt=%d',
          Date.now() - phaseStart, attempt);
        break;
      }
      const extracted = {
        extractedBackend: extractBackendRoutes(WORKSPACE_DIR),
        extractedFrontend: extractFrontendFetches(WORKSPACE_DIR),
        extractedDb: extractDbSchema(WORKSPACE_DIR),
        // Live router table (authority for route existence); null → fail-open.
        extractedBackendRuntime: await extractRuntimeRoutes(WORKSPACE_DIR),
      };
      const result = await mergeSqlGate(compareScopes({
        workspaceDir: WORKSPACE_DIR,
        ...extracted,
        routerContracts,
        onVerdict: verdictSink,
      }));
      tlog('[session] Reconciler attempt=%d: %d mismatches, %d extras',
        attempt, result.mismatches.length, result.extras.length);
      emitVerifStep(`Cross-scope check (pass ${attempt + 1}) — ${result.mismatches.length} mismatch(es), ${result.extras.length} extra(s) to review`);
      // Log each mismatch + extra structurally so we can see WHAT the comparator
      // found, not just the count. Critical for debugging the re-engage loop —
      // without this it's impossible to tell if the comparator is finding real
      // contract drift or just noise.
      for (const m of result.mismatches) {
        tlog('[session] Reconciler MISMATCH attempt=%d kind=%s scope=%s severity=%s where=%s contract=%j actual=%j',
          attempt, m.kind, m.scope, m.severity, m.file ? `${m.file}${m.line ? ':' + m.line : ''}` : (m.evidence || '-'),
          m.contract, m.actual);
      }
      for (const e of result.extras) {
        tlog('[session] Reconciler EXTRA attempt=%d kind=%s scope=%s where=%j',
          attempt, e.kind, e.scope, e.evidence || e.path || e.contract || e.component || '-');
      }

      const judgedExtras = result.extras.length
        ? await judgeExtras(result.extras, routerContracts, {
            workspaceDir: WORKSPACE_DIR,
            onVerdict: verdictSink,
            // PR 2 / Alt A — contract agent continuation: the judge call
            // appends `[user(extras+...) ]` to this prefix so the model
            // sees its own prior contract decision when classifying.
            // Null falls back to stateless single-shot through the
            // contract agent assistant (no continuation benefit but still
            // routes through the right agent).
            contractAgentMessages,
          })
        : [];
      // Surface the reconciler-judge's full per-extra verdicts (the previously
      // invisible "big chunk") under the verification card.
      if (judgedExtras.length) {
        const verdictLines = judgedExtras.map((e) => {
          const where = e.method ? `${e.method} ${e.path}` : (e.path || e.component || e.kind || 'item');
          return `- ${e.scope}: ${where} → ${e.judgment}`;
        });
        emitVerif({
          say: 'text',
          text: `Reviewed ${judgedExtras.length} extra item(s) the agents added · ${stepSecs()}s\n\n${verdictLines.join('\n')}`,
        });
      }
      // Promote judge-flagged extras to mismatches:
      //   - 'mismatch:<id>' → soft (rename/reshape; agent can resolve)
      //   - 'noise' → soft (router may have promised something nobody needs)
      //   - 'legitimate' → drop (extra stays as observability, not a mismatch)
      const promotedFromExtras = judgedExtras
        .filter(e => e.judgment !== 'legitimate')
        .map(e => ({
          ...e,
          severity: 'soft',
          contract: e.judgment.startsWith('mismatch:')
            ? `judge says this is the same as contract item: ${e.judgment.slice('mismatch:'.length).trim()}`
            : `judge classified as ${e.judgment}`,
          actual: `${e.scope} produced ${e.method ? `${e.method} ${e.path}` : (e.kind || 'this item')}`,
        }));
      allMismatches = [
        ...result.mismatches,
        ...promotedFromExtras,
      ];
      extras = judgedExtras;
      // Contract adoption: legitimate code-present routes converge the
      // envelope to reality (and the endpoint probe covers them this run).
      const adoption = adoptLegitimateExtras(WORKSPACE_DIR, judgedExtras);
      if (adoption.adopted) {
        session.contractStoreStats = session.contractStoreStats || { mergedKinds: [], adoptedRoutes: 0 };
        session.contractStoreStats.adoptedRoutes += adoption.adopted;
        emitVerif({ say: 'text', text: `Adopted ${adoption.adopted} legitimate route(s) into the app contract.` });
      }
      if (allMismatches.length === 0) break;

      const scopes = [...new Set(allMismatches.map(m => m.scope).filter(Boolean))];
      // Per-scope budget gate: any scope that has already been re-engaged
      // PER_SCOPE_REENGAGE_BUDGET times this run is exhausted — its
      // remaining mismatches survive into the final-pass diagnostic but
      // we don't dispatch another subagent run for it. If ALL scopes with
      // current mismatches are exhausted, no further iteration can make
      // progress — break the outer loop so the final-pass + hard-fail
      // emission runs immediately.
      const allExhausted = scopes.every(s => getReengages(s) >= PER_SCOPE_REENGAGE_BUDGET);
      if (allExhausted) {
        tlog('[reconciler-loop] all scopes with mismatches exhausted (%j) — breaking out of re-engage loop',
          reengagesSnapshot());
        break;
      }
      for (const scope of scopes) {
        const used = getReengages(scope);
        if (used >= PER_SCOPE_REENGAGE_BUDGET) {
          tlog('[reconciler-loop] scope=%s budget-exhausted (%d/%d) — skipping re-engage',
            scope, used, PER_SCOPE_REENGAGE_BUDGET);
          continue;
        }
        const scopeMismatches = allMismatches.filter(m => m.scope === scope);
        tlog('[session] Reconciler: re-engaging scope=%s with %d mismatch(es) [budget %d/%d]',
          scope, scopeMismatches.length, used + 1, PER_SCOPE_REENGAGE_BUDGET);
        emitVerifStep(`Re-aligning the ${scope} scope — ${scopeMismatches.length} item(s) to fix`);
        await reengageScopeForMismatch(scope, scopeMismatches, session, {
          routerContracts,
          // Pass the just-extracted state so the re-engage directive can
          // include sibling-scope reality (init.sql columns, frontend fetch
          // shapes, backend route surface) — prevents the cascade where
          // backend invents new column names because it didn't see the
          // existing schema. Observed t39 (2026-05-09).
          currentState: extracted,
          accumulateTotals: accumulateAgentTotals,
        });
        bumpReengages(scope);
      }
      attempt++;
    }

    // Final compare to measure the LAST re-engage's effects. Without this we
    // classify on the second-to-last compare, missing fixes from the final
    // re-engage cycle. Observed t39 (2026-05-09): frontend re-engage #2 wrote
    // all the React app files but the loop exited before compareScopes saw
    // them — hard-fail emitted despite the fix actually landing.
    if (allMismatches.length) {
      const finalExtracted = {
        extractedBackend: extractBackendRoutes(WORKSPACE_DIR),
        extractedFrontend: extractFrontendFetches(WORKSPACE_DIR),
        extractedDb: extractDbSchema(WORKSPACE_DIR),
        extractedBackendRuntime: await extractRuntimeRoutes(WORKSPACE_DIR),
      };
      const finalResult = await mergeSqlGate(compareScopes({
        workspaceDir: WORKSPACE_DIR,
        ...finalExtracted,
        routerContracts,
        onVerdict: verdictSink,
      }));
      tlog('[session] Reconciler final-pass: %d mismatches, %d extras',
        finalResult.mismatches.length, finalResult.extras.length);
      const finalJudged = finalResult.extras.length
        ? await judgeExtras(finalResult.extras, routerContracts, {
            workspaceDir: WORKSPACE_DIR,
            onVerdict: verdictSink,
            contractAgentMessages,
          })
        : [];
      // Same adoption as the loop pass — idempotent (already-known routes skip).
      const finalAdoption = adoptLegitimateExtras(WORKSPACE_DIR, finalJudged);
      if (finalAdoption.adopted) {
        session.contractStoreStats = session.contractStoreStats || { mergedKinds: [], adoptedRoutes: 0 };
        session.contractStoreStats.adoptedRoutes += finalAdoption.adopted;
      }
      const finalPromoted = finalJudged
        .filter(e => e.judgment !== 'legitimate')
        .map(e => ({
          ...e,
          severity: 'soft',
          contract: e.judgment.startsWith('mismatch:')
            ? `judge says this is the same as contract item: ${e.judgment.slice('mismatch:'.length).trim()}`
            : `judge classified as ${e.judgment}`,
          actual: `${e.scope} produced ${e.method ? `${e.method} ${e.path}` : (e.kind || 'this item')}`,
        }));
      allMismatches = [
        ...finalResult.mismatches,
        ...finalPromoted,
      ];
    }

    if (allMismatches.length) {
      const hard = allMismatches.filter(m => m.severity === 'hard');
      if (hard.length) {
        tlog('[session] Reconciler: %d hard mismatch(es) remain — skipping compose build',
          hard.length);
        const diagnostic = formatHardFailDiagnostic(allMismatches);
        // tlog the full diagnostic to stdout so the smoke harness (and any
        // log tail) can see it without relying on the socket.io cline event.
        // Each line is prefixed for visibility in mixed log output.
        for (const line of diagnostic.split('\n')) {
          tlog('[reconciler-diag] %s', line);
        }
        const event = appendEvent(session.id, 'cline', {
          say: 'text',
          text: diagnostic,
        });
        sessionEvents.emit('event', session.id, event);
        verifHardFailed = true;
        return false;
      }
      tlog('[session] Reconciler: %d soft deviation(s) — proceeding with build',
        allMismatches.length);
      const softNote = formatSoftDeviationNote(allMismatches);
      for (const line of softNote.split('\n')) {
        tlog('[reconciler-diag] %s', line);
      }
      const event = appendEvent(session.id, 'cline', {
        say: 'text',
        text: softNote,
      });
      sessionEvents.emit('event', session.id, event);
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: cross-scope reconciler failed (non-fatal)');
  } finally {
    // Always log the summary — hard-fail returns from inside the try
    // would otherwise skip this and lose the wall-time + reengages map.
    tlog('[reconciler-loop] done: wall=%dms timeout=%s reengages=%j',
      Date.now() - phaseStart, timedOut, reengagesSnapshot());
    // W3.TEL belt-and-braces: drain any verdict buffer that escaped a
    // phase-boundary flush (judgeExtras + compareScopes each flush at
    // their boundaries; this catches edge cases like a thrown error
    // mid-batch that prevented their flush).
    flushReconcilerVerdicts(WORKSPACE_DIR);

    // Close the verification card with a one-line, user-facing result.
    const counts = session.reconcilerVerdictCounts || {};
    const reviewed = (counts.ok || 0) + (counts.mismatch || 0) + (counts.legitimate || 0) + (counts.noise || 0);
    const reAligned = Object.values(reengagesSnapshot()).reduce((a, b) => a + b, 0);
    const totalSecs = fmtSecs(Date.now() - phaseStart);
    let summary;
    if (verifHardFailed) {
      summary = `Found cross-scope issues that need a fix before the app can run (details above) · ${totalSecs}s total.`;
    } else if (reviewed || reAligned) {
      summary = `Cross-scope check complete — reviewed ${reviewed} item${reviewed === 1 ? '' : 's'}`
        + (reAligned ? `, re-aligned ${reAligned} scope pass${reAligned === 1 ? '' : 'es'}` : '')
        + `. Everything lines up · ${totalSecs}s total.`;
    } else {
      summary = `Cross-scope check complete — frontend, backend, and database are consistent · ${totalSecs}s total.`;
    }
    emitVerif({ say: 'completion_result', text: summary });
    emitVerifStatus('completed', verifHardFailed ? 1 : 0);
  }
  return true;
}

/**
 * `compose build` (long cap) followed by `compose up -d --no-build` (tight
 * cap). Returns false when either step fails (caller has already emitted a
 * user-visible failure event and must abort the boot); true otherwise.
 *
 * Split rationale: a combined `up -d --build` exits non-zero when the BUILD
 * exceeds the up-d timeout even if containers would have come up fine.
 * Separating gives the build its own (long) cap and the start its own
 * (short) cap that accurately reflects "did up-d succeed." Observed t32 v3
 * in 2026-05-05 gate: combined call returned ok=false at 7448ms but
 * containers became healthy when run manually 6s later.
 */
async function buildAndStartContainers(session) {
  const emitStatus = (text) => {
    const ev = appendEvent(session.id, 'cline', { say: 'text', text });
    sessionEvents.emit('event', session.id, ev);
  };
  // Announce the REAL start here — after the reconciler + auto-recovery. Two
  // steps so the (often minute+) image build isn't a silent "stuck" gap.
  emitStatus('Packaging your app into containers — this can take a minute…');
  const tBuild = Date.now();
  const built = runCompose('build', { timeout: COMPOSE_BUILD_MS });
  tlog('[session] Auto-start: compose build (%dms, ok=%s)', Date.now() - tBuild, built.ok);
  if (!built.ok) {
    // Surface the build error to the smoke log too — the UI event captures it
    // for chat users, but smoke runs and CI need it in stdout for triage.
    // Tail the stderr (last 60 lines) to keep the log scannable while still
    // showing the actual docker build failure (which is usually in the last
    // ~20 lines after the "ERROR:" marker).
    const stderr = built.stderr || 'unknown error';
    const stderrLines = stderr.split('\n');
    const tail = stderrLines.length > 60
      ? stderrLines.slice(-60).join('\n')
      : stderr;
    tlog('[session] Auto-start: compose build FAILED — stderr tail (last %d of %d lines):\n%s',
      Math.min(60, stderrLines.length), stderrLines.length, tail);
    const failEvent = appendEvent(session.id, 'cline', {
      say: 'text',
      text: `Build failed. Try **Run locally** to retry, or paste the error in chat:\n\n\`\`\`\n${stderr}\n\`\`\``,
    });
    sessionEvents.emit('event', session.id, failEvent);
    return false;
  }

  emitStatus('Containers built — starting your app…');
  // 180s cap: `up -d` itself returns once containers are scheduled, but with
  // `depends_on: condition: service_healthy` chains, the command waits for
  // healthchecks to pass before returning. A 4-service stack (database +
  // backend + frontend + auxiliary like mailhog) can legitimately take 60-90s
  // for the postgres start_period (default 120s) to complete. 60s was too
  // tight — observed t39 hit exactly 60022ms and report ok=false even though
  // the database and mailhog were already healthy. 180s gives the chain
  // enough room without making real failures slow to surface.
  //
  // One bounded repair round on failure: a compose-up failure used to dead-end
  // into "ask me to fix it" — observed live, a missing POSTGRES_PASSWORD
  // killed the dependency chain and the pipeline went idle on an app that a
  // fix agent repairs in one dispatch. Same posture as the probe/visual loops.
  for (let attempt = 1; ; attempt++) {
    const t = Date.now();
    const up = runCompose('up -d --no-build', { timeout: COMPOSE_UP_MS });
    tlog('[session] Auto-start: compose up (%dms, ok=%s, attempt=%d)', Date.now() - t, up.ok, attempt);
    if (up.ok) return true;

    // Same treatment as compose build failure: surface stderr tail to the
    // smoke log alongside the UI event.
    const stderr = up.stderr || 'unknown error';
    const stderrLines = stderr.split('\n');
    const tail = stderrLines.length > 60
      ? stderrLines.slice(-60).join('\n')
      : stderr;
    tlog('[session] Auto-start: compose up FAILED — stderr tail (last %d of %d lines):\n%s',
      Math.min(60, stderrLines.length), stderrLines.length, tail);
    // The stderr only says WHICH container exited; capture each service's own
    // logs so the actual crash reason (EACCES on a runtime mkdir, a Postgres
    // init error, a backend throw-on-boot) is recorded here instead of forcing
    // a manual reproduce later. Best-effort, and empty when nothing started
    // (e.g. a Docker address-pool exhaustion, which the stderr above explains).
    let containerLogs = '';
    try {
      const logs = runCompose('logs --tail=40 --no-color', { captureStdout: true, timeout: COMPOSE_LOGS_MS });
      containerLogs = (logs.stdout || '').trim();
    } catch { /* best-effort */ }
    if (containerLogs) {
      const logLines = containerLogs.split('\n');
      const logTail = logLines.length > 80 ? logLines.slice(-80).join('\n') : containerLogs;
      tlog('[session] Auto-start: compose up FAILED — container logs (last %d of %d lines):\n%s',
        Math.min(80, logLines.length), logLines.length, logTail);
    }

    if (attempt >= 2) {
      const failEvent = appendEvent(session.id, 'cline', {
        say: 'text',
        text: `Couldn't start containers. The build succeeded but \`compose up -d\` failed:\n\n\`\`\`\n${stderr}\n\`\`\``
          + (containerLogs ? `\n\nContainer logs:\n\n\`\`\`\n${containerLogs.split('\n').slice(-40).join('\n')}\n\`\`\`` : ''),
      });
      sessionEvents.emit('event', session.id, failEvent);
      return false;
    }

    // Repair round scope: the CRASHING service owns the fix. Classify from
    // the container logs' crash content — the compose stderr always names
    // database containers in dependency-chain noise ("database-1 Waiting"),
    // which previously vetoed a correct backend classification (observed
    // live: a backend require-in-ESM boot crash was dispatched to
    // integration, which fiddled with compose and fixed nothing). Only when
    // no service shows a crash do env-wiring/compose concerns default to
    // integration.
    const CRASH_RE = /(Error|FATAL|Traceback|Cannot find module|exited)/;
    const crashingService = ['backend', 'frontend', 'database', 'vectordb'].find((svc) => {
      const svcLines = containerLogs.split('\n').filter((l) => l.includes(`${svc}-1`));
      return svcLines.length > 0 && CRASH_RE.test(svcLines.join('\n'));
    });
    const scope = crashingService || 'integration';
    tlog('[session] Auto-start: compose up repair round — dispatching %s fix', scope);
    emitStatus('Start-up hit a snag — fixing it automatically…');
    const ev = appendEvent(session.id, 'compose_up_fix_dispatch', { scope, attempt });
    sessionEvents.emit('event', session.id, ev);
    try {
      const { buildFixDirective, pushAutoRecoveryRecord } = await import('./auto-recovery.js');
      pushAutoRecoveryRecord(session, {
        scope,
        attemptN: 1,
        triggeredBy: 'compose-up',
        failureSummary: 'compose up -d failed after a successful build',
        exhausted: false,
      });
      const formatted = [
        '=== COMPOSE UP FAILURE (containers built, but the stack cannot start) ===',
        '',
        '`docker compose up -d` failed. Diagnose from the evidence below and fix',
        'the root cause (compose env wiring, service config, or a boot crash).',
        'Do NOT add new endpoints, tables, or features.',
        '',
        '--- compose stderr ---',
        tail,
        ...(containerLogs ? ['', '--- container logs ---', containerLogs.split('\n').slice(-40).join('\n')] : []),
      ].join('\n');
      const directive = buildFixDirective(scope, [{ source: 'runtime-gate', formatted }]);
      const { runCustomAgent } = await import('../agent/agent.js');
      const { PHASES } = await import('../agent/loop/phase.js');
      const agentResult = await runCustomAgent(session.id, directive, {
        conversationId: null,
        scope,
        phase: PHASES.SUBAGENT,
        priorTokenTotals: session.coderTokenTotals || null,
      });
      accumulateAgentTotals(session, agentResult);
    } catch (err) {
      logAndSwallow(err, '[session] Auto-start: compose up repair dispatch threw');
    }
    runCompose('build', { timeout: COMPOSE_BUILD_MS });
    // loop → second (final) up attempt
  }
}

/**
 * Post-compose endpoint verification loop. Probes every contracted endpoint
 * through the frontend proxy; on failures, dispatches a fix agent to the
 * owning scope (budget MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE), rebuilds, and
 * re-probes only the failed endpoints until clean or budget out.
 *
 * Returns a summary for the app-ready message, or { skipped } when there is
 * no contract to verify / the escape hatch is set. Never throws — the caller
 * wraps it in logAndSwallow posture anyway.
 */
async function runEndpointVerificationLoop(session, baseUrl, routerContracts, scopeCounters) {
  if (process.env.ENDPOINT_PROBE_SKIP === 'true') return { skipped: 'env' };

  let apiContract = routerContracts?.apiContract || null;
  if (!apiContract) {
    // Fallback to the on-disk envelope (legacy callers don't pass contracts).
    try {
      const envelopePath = path.join(WORKSPACE_DIR, '.harness', 'contracts.json');
      if (existsSync(envelopePath)) {
        const envelope = JSON.parse(readFileSync(envelopePath, 'utf-8'));
        apiContract = envelope?.data?.api_contract || envelope?.data?.apiContract || null;
      }
    } catch { /* no envelope — skip below */ }
  }
  if (!Array.isArray(apiContract?.endpoints) || apiContract.endpoints.length === 0) {
    return { skipped: 'no-contract' };
  }

  const isAiApp = isMgaApp(WORKSPACE_DIR);
  const referencePrefixes = resolveReferencePrefixes(routerContracts, apiContract);
  const emitProbeEvent = (type, payload) => {
    const ev = appendEvent(session.id, type, payload);
    sessionEvents.emit('event', session.id, ev);
  };

  emitProbeEvent('endpoint_probe_started', { endpointCount: apiContract.endpoints.length, isAiApp });
  tlog('[endpoint-probe] starting: %d endpoint(s) via %s (isAiApp=%s)',
    apiContract.endpoints.length, baseUrl, isAiApp);

  let result = await probeApiEndpoints({ baseUrl, apiContract, isAiApp, referencePrefixes });
  let health = checkComposeHealthAfterProbe(runCompose);
  const probedTotal = result.probed;
  const initialFailed = result.failed.length;
  let rounds = 1;
  let fixDispatches = 0;
  emitProbeEvent('endpoint_probe_result', {
    round: rounds, probed: result.probed, passed: result.passed,
    failed: result.failed.map((f) => ({ method: f.method, path: f.path, status: f.status, error: f.error })),
    skipped: result.skipped, crashed: health.crashed,
  });
  tlog('[endpoint-probe] round=%d probed=%d passed=%d failed=%d crashed=%d (%dms)',
    rounds, result.probed, result.passed, result.failed.length, health.crashed.length, result.durationMs);

  // Timeout-class failures (no HTTP status at all) are usually transient —
  // a slow MGA round-trip, a container still warming. Re-probe ONCE without
  // an agent before burning a fix dispatch: observed live, a transient MGA
  // timeout cost an 8-minute fix agent for an endpoint that had already
  // healed by the post-fix re-probe.
  if (result.failed.length > 0 && result.failed.every((f) => f.status == null)) {
    tlog('[endpoint-probe] all %d failure(s) are timeout-class — re-probing once before any fix dispatch',
      result.failed.length);
    await new Promise((r) => setTimeout(r, 10_000));
    const failedContract = { endpoints: apiContract.endpoints.filter((ep) =>
      result.failed.some((f) => f.method === ep.method && f.path === ep.path)) };
    const reprobe = await probeApiEndpoints({ baseUrl, apiContract: failedContract, isAiApp, referencePrefixes });
    rounds++;
    emitProbeEvent('endpoint_probe_result', {
      round: rounds, probed: reprobe.probed, passed: reprobe.passed,
      failed: reprobe.failed.map((f) => ({ method: f.method, path: f.path, status: f.status, error: f.error })),
      skipped: reprobe.skipped, crashed: [], transientRetry: true,
    });
    tlog('[endpoint-probe] transient re-probe: %d/%d recovered', reprobe.passed, reprobe.probed);
    result = { ...result, failed: reprobe.failed, passed: result.passed + reprobe.passed };
  }

  while (result.failed.length > 0) {
    const backendLogs = scanBackendLogsForErrors({ maxLines: 10 });
    const logsTail = backendLogs?.tail || '';
    const scope = classifyProbeFailureScope(logsTail);
    const counter = scopeCounters.get(scope) || { reengages: 0, fixAttempts: 0 };
    counter.probeFixAttempts = counter.probeFixAttempts || 0;
    if (counter.probeFixAttempts >= MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE) {
      tlog('[endpoint-probe] scope=%s probe-fix budget exhausted (%d/%d) — surfacing remaining failures',
        scope, counter.probeFixAttempts, MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE);
      break;
    }
    counter.probeFixAttempts++;
    scopeCounters.set(scope, counter);
    fixDispatches++;

    emitProbeEvent('endpoint_probe_fix_dispatch', {
      scope,
      attempt: counter.probeFixAttempts,
      budget: MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE,
      endpoints: result.failed.map((f) => `${f.method} ${f.path}`),
    });
    tlog('[endpoint-probe] dispatching fix scope=%s attempt=%d/%d endpoints=%d',
      scope, counter.probeFixAttempts, MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE, result.failed.length);

    try {
      const { buildFixDirective, pushAutoRecoveryRecord } = await import('./auto-recovery.js');
      pushAutoRecoveryRecord(session, {
        scope,
        attemptN: counter.probeFixAttempts,
        triggeredBy: 'smoke',
        failureSummary: `${result.failed.length} endpoint(s) failing live probe`,
        exhausted: false,
      });
      const directive = buildFixDirective(scope, [{
        source: 'endpoint-probe',
        errorCount: result.failed.length,
        formatted: formatProbeFailures(result.failed, { logsTail, crashed: health.crashed }),
      }]);
      const { runCustomAgent } = await import('../agent/agent.js');
      const { PHASES } = await import('../agent/loop/phase.js');
      const agentResult = await runCustomAgent(session.id, directive, {
        conversationId: null,
        scope,
        phase: PHASES.SUBAGENT,
        priorTokenTotals: session.coderTokenTotals || null,
      });
      accumulateAgentTotals(session, agentResult);
    } catch (err) {
      logAndSwallow(err, '[endpoint-probe] fix dispatch threw');
      break;
    }

    // Rebuild the fixed scope's image (integration fixes only touch the
    // compose file) and restart — `up -d` recreates only changed containers.
    if (scope === 'backend') {
      runCompose('build backend', { timeout: COMPOSE_BUILD_MS });
    }
    const up = runCompose('up -d', { timeout: COMPOSE_UP_MS });
    if (!up.ok) {
      tlog('[endpoint-probe] compose up after fix failed: %s', up.stderr);
      break;
    }
    await waitForHttp(baseUrl, { timeoutMs: HTTP_PROBE_TOTAL_MS, intervalMs: HTTP_PROBE_POLL_LIVE_MS });

    const failedKeys = new Set(result.failed.map((f) => `${f.method} ${f.path}`));
    // A persistence failure is only observable as POST-then-GET — re-probing
    // the GET alone would trivially pass (nothing was created). Re-run the
    // matching POST too.
    for (const f of result.failed) {
      if (String(f.error || '').startsWith('persistence:')) failedKeys.add(`POST ${f.path}`);
    }
    // A reference-data failure is only fixable by rows landing in the live
    // DB: init/ never re-runs on an initialized volume, so re-apply the seed
    // file the fix was told to write, then re-probe the collection GET too —
    // it is what supplies the id for the mutation.
    const referenceFailures = result.failed.filter((f) => String(f.error || '').startsWith('reference-data:'));
    if (referenceFailures.length) {
      applyReferenceDataFile();
      for (const f of referenceFailures) failedKeys.add(`GET ${probeCollectionPrefix(f.path)}`);
    }
    result = await probeApiEndpoints({
      baseUrl, apiContract, isAiApp, referencePrefixes,
      filter: (s) => failedKeys.has(`${s.method} ${s.path}`),
    });
    health = checkComposeHealthAfterProbe(runCompose);
    rounds++;
    emitProbeEvent('endpoint_probe_result', {
      round: rounds, probed: result.probed, passed: result.passed,
      failed: result.failed.map((f) => ({ method: f.method, path: f.path, status: f.status, error: f.error })),
      skipped: result.skipped, crashed: health.crashed,
    });
    tlog('[endpoint-probe] round=%d re-probed=%d passed=%d failed=%d (%dms)',
      rounds, result.probed, result.passed, result.failed.length, result.durationMs);
  }

  const summary = {
    probed: probedTotal,
    initialFailed,
    stillBroken: result.failed,
    crashed: health.crashed,
    fixed: Math.max(0, initialFailed - result.failed.length),
    rounds,
    // Fix dispatches rebuild + restart containers; a visual check running in
    // parallel with this loop is only trustworthy when this stayed 0.
    fixDispatches,
  };
  emitProbeEvent('endpoint_probe_done', {
    probed: summary.probed,
    fixed: summary.fixed,
    stillBroken: summary.stillBroken.map((f) => `${f.method} ${f.path}`),
    crashed: summary.crashed,
    rounds,
  });
  tlog('[endpoint-probe] done: probed=%d fixed=%d stillBroken=%d rounds=%d',
    summary.probed, summary.fixed, summary.stillBroken.length, rounds);
  return summary;
}

/**
 * Which scope owns a probe failure: integration when the backend logs show
 * MGA env vars missing AND compose doesn't wire them (env plumbing gap);
 * backend for everything else (5xx = handler/code).
 */
/**
 * Collection prefixes ('/lines') of tables the API acts on via :id routes
 * but never creates — the same detection that pre-staged their starter rows.
 * A mutation 404 there is the empty-table silent failure, not a legitimate
 * "row doesn't exist". Empty when the data model is unavailable.
 */
function resolveReferencePrefixes(routerContracts, apiContract) {
  try {
    const dataModel = routerContracts?.dataModel || readContracts(WORKSPACE_DIR)?.data?.dataModel || null;
    if (!dataModel) return [];
    return findReferenceTables({ dataModel, apiContract }).flatMap((r) => r.prefixes);
  } catch (err) {
    logAndSwallow(err, '[endpoint-probe] reference-table detection failed');
    return [];
  }
}

function probeCollectionPrefix(p) {
  const idx = p.search(/:[A-Za-z_]|\{[A-Za-z_]/);
  return (idx === -1 ? p : p.slice(0, idx)).replace(/\/+$/, '');
}

/** Re-run database/init/02_reference_data.sql against the live DB (idempotent: guarded blocks). */
function applyReferenceDataFile() {
  const file = path.join(WORKSPACE_DIR, REFERENCE_DATA_FILE);
  if (!existsSync(file)) return false;
  try {
    const db = LOCAL_DB_CREDENTIALS;
    execSync(`docker compose exec -T database psql -v ON_ERROR_STOP=1 -U ${db.user} -d ${db.name}`, {
      cwd: WORKSPACE_DIR,
      input: readFileSync(file, 'utf-8'),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    tlog('[endpoint-probe] re-applied %s to the running database', REFERENCE_DATA_FILE);
    return true;
  } catch (err) {
    tlog('[endpoint-probe] re-applying %s failed: %s', REFERENCE_DATA_FILE, (err.stderr?.toString() || err.message || '').slice(0, 300));
    return false;
  }
}

function classifyProbeFailureScope(logsTail) {
  if (/MGA(_API_KEY|_BASE_URL|_ASSISTANT_ID)?[^\n]*(undefined|not configured)|MGA not configured/i.test(logsTail)) {
    try {
      const composePath = path.join(WORKSPACE_DIR, 'docker-compose.yml');
      if (existsSync(composePath) && !/MGA_API_KEY/.test(readFileSync(composePath, 'utf-8'))) {
        return 'integration';
      }
    } catch { /* fall through to backend */ }
  }
  return 'backend';
}

/**
 * After containers are up: wait for HTTP, verify contracted endpoints with
 * live requests (auto-fixing failures), scan backend logs for error-shaped
 * lines, and emit the app_ready_prompt event so the UI can offer to open
 * the app. Best-effort — failures here log only; the user can still click
 * "Run locally" manually.
 */
// Exported for the deterministic /start-app endpoint: a user-initiated app
// start re-runs the post-compose verification (pending migrations, endpoint
// probe, visual check, honest app-ready message) without the LLM in the loop.
export async function runSmokeAndPrompt(session, envContext, routerContracts = {}, scopeCounters = new Map()) {
  // Honor SMOKE_PORT_OFFSET — applyPortOffsetToCompose shifts host ports by
  // (offset * 10) in the compose file, so the /health probe must use the
  // shifted host port. Without this, smoke /health probe always 404s under
  // simultaneous-run port isolation (introduced in commit 659f3c6).
  const offset = parseInt(process.env.SMOKE_PORT_OFFSET || '0', 10);
  const frontendHostPort = 8080 + (offset > 0 ? offset * 10 : 0);
  const url = envContext?.codespaceUrl || `http://localhost:${frontendHostPort}`;

  // ── Smoke test ──
  // `compose up -d` just says containers were scheduled — it does NOT prove
  // the app inside is healthy. Wait for HTTP to accept connections, then scan
  // backend logs for error patterns. If the app is crashing on every request
  // (e.g. DB host wrong, missing env var, bad init.sql), the container is
  // "up" but every API call will 5xx — exactly the case where the user opens
  // the browser and sees an opaque "Failed to load (500)" toast with no clue
  // why. Surfacing the backend error lines here points them at the real
  // cause in the chat, immediately.
  tlog('[session] Auto-start: smoke probe starting url=%s', url);
  const ready = await waitForHttp(url, { timeoutMs: HTTP_PROBE_TOTAL_MS, intervalMs: HTTP_PROBE_POLL_LIVE_MS });
  tlog('[session] Auto-start: smoke probe done ok=%s status=%s error=%s', ready.ok, ready.status, ready.error);
  if (!ready.ok) {
    tlog('[session] Auto-start: smoke test — frontend did not respond within 30s (lastStatus=%s lastError=%s)',
      ready.status, ready.error);
  }

  // ── Visual sanity — STARTED EARLY, in parallel with endpoint verification ──
  // The screenshot + LLM verdict costs 10-25s and needs nothing from the
  // probe; running them sequentially was pure wall-clock. A probe fix
  // dispatch rebuilds + restarts containers though, so the early screenshot
  // is only trusted when the verification loop dispatched zero fixes —
  // otherwise the check re-runs against the post-fix app below.
  // Iterate callers pass uiContract: null — fall back to the on-disk
  // envelope so iterates get the visual check too (a blank page after an
  // iterate is exactly the class this catches; observed live).
  let uiContractForCheck = routerContracts?.uiContract || null;
  if (!uiContractForCheck) {
    try {
      const envelopePath = path.join(WORKSPACE_DIR, '.harness', 'contracts.json');
      if (existsSync(envelopePath)) {
        const envelope = JSON.parse(readFileSync(envelopePath, 'utf-8'));
        uiContractForCheck = envelope?.data?.uiContract || envelope?.data?.ui_contract || null;
      }
    } catch { /* no envelope — check will skip */ }
  }
  emitVerifyStep(session.id, 'visual-check', 'start');
  const earlyVisual = runUiSanityCheck({ url, uiContract: uiContractForCheck })
    .catch((err) => { logAndSwallow(err, '[ui-sanity] early check threw'); return null; });

  // ── Endpoint verification (contract-driven, self-healing) ──
  // A probe-harness bug must never block app_ready_prompt — same L.5
  // posture as everything else in this function.
  let verification = null;
  try {
    emitVerifyStep(session.id, 'endpoint-tests', 'start');
    verification = await runEndpointVerificationLoop(session, url, routerContracts, scopeCounters);
    if (verification?.skipped) {
      emitVerifyStep(session.id, 'endpoint-tests', 'done', 'skipped');
    } else if (verification) {
      const broken = verification.stillBroken.length;
      emitVerifyStep(session.id, 'endpoint-tests', broken ? 'warn' : 'done',
        broken
          ? `${broken} of ${verification.probed} still failing`
          : `${verification.probed}/${verification.probed} passed${verification.fixed ? ` (${verification.fixed} auto-fixed)` : ''}`);
    }
    if (verification && !verification.skipped) {
      // A6 telemetry — picked up by writeRunSummary in the confirm handler.
      session.endpointProbeSummary = {
        probed: verification.probed,
        initialFailed: verification.initialFailed,
        fixed: verification.fixed,
        stillBroken: verification.stillBroken.map((f) => `${f.method} ${f.path}`),
        rounds: verification.rounds,
      };
    }
  } catch (err) {
    logAndSwallow(err, '[endpoint-probe] verification loop threw');
  }

  // ── Visual sanity resolution ──
  // The probe proves handlers respond; this catches what a user would SEE
  // broken on the primary view ([object Object], blank page, raw errors).
  try {
    // Trust the early parallel screenshot only when nothing restarted the
    // containers since it was taken: verification ran (or was skipped —
    // skipped means no probe, so no restarts) with zero fix dispatches. A
    // thrown loop leaves container state unknown — re-run fresh.
    const earlyResult = await earlyVisual;
    let uiSanity;
    if (earlyResult && verification && (verification.skipped || (verification.fixDispatches ?? 0) === 0)) {
      uiSanity = earlyResult;
    } else {
      if (earlyResult) tlog('[ui-sanity] probe dispatched %d fix(es) after the early screenshot — re-running visual check', verification?.fixDispatches ?? -1);
      uiSanity = await runUiSanityCheck({ url, uiContract: uiContractForCheck });
    }
    if (uiSanity?.skipped) {
      emitVerifyStep(session.id, 'visual-check', 'done', 'skipped');
    } else if (uiSanity) {
      emitVerifyStep(session.id, 'visual-check', uiSanity.sane ? 'done' : 'warn',
        uiSanity.sane ? 'looks good' : `${uiSanity.defects.length} visual defect(s) — details below`);
    }

    // High-severity defects mean the primary view is broken for the user —
    // dispatch ONE bounded frontend fix (same posture as the endpoint-probe
    // loop) instead of only reporting. Lower severities stay report-only:
    // cosmetic drift isn't worth a fix agent.
    const highDefects = (!uiSanity?.skipped && !uiSanity?.sane)
      ? (uiSanity?.defects || []).filter((d) => String(d.severity).toLowerCase() === 'high')
      : [];
    if (highDefects.length > 0) {
      const counter = scopeCounters.get('frontend') || {};
      if (!counter.visualFixAttempts) {
        counter.visualFixAttempts = 1;
        scopeCounters.set('frontend', counter);
        const ev = appendEvent(session.id, 'ui_sanity_fix_dispatch', { defects: highDefects });
        sessionEvents.emit('event', session.id, ev);
        tlog('[ui-sanity] %d high-severity defect(s) — dispatching frontend fix', highDefects.length);
        const { buildFixDirective, pushAutoRecoveryRecord } = await import('./auto-recovery.js');
        pushAutoRecoveryRecord(session, {
          scope: 'frontend',
          attemptN: 1,
          triggeredBy: 'visual-check',
          failureSummary: `${highDefects.length} high-severity visual defect(s) on the primary view`,
          exhausted: false,
        });
        const formatted = [
          '=== VISUAL CHECK FAILURES (screenshot of the running app) ===',
          '',
          'A screenshot of the app\'s primary view shows it is broken for the user:',
          ...highDefects.map((d) => `  - ${d.description}`),
          '',
          uiContractForCheck?.primary_view ? `Contract primary view: ${uiContractForCheck.primary_view}` : null,
          uiContractForCheck?.primary_action ? `Contract primary action: ${uiContractForCheck.primary_action}` : null,
          '',
          'Find and fix the frontend defect (common causes: unguarded null field',
          'access while rendering, empty-state not handled, failed fetch rendered',
          'raw). Do NOT change API calls, endpoints, or contract shapes.',
        ].filter((l) => l !== null).join('\n');
        const directive = buildFixDirective('frontend', [{ source: 'visual-check', formatted }]);
        const { runCustomAgent } = await import('../agent/agent.js');
        const { PHASES } = await import('../agent/loop/phase.js');
        const agentResult = await runCustomAgent(session.id, directive, {
          conversationId: null,
          scope: 'frontend',
          phase: PHASES.SUBAGENT,
          priorTokenTotals: session.coderTokenTotals || null,
        });
        accumulateAgentTotals(session, agentResult);
        runCompose('build frontend', { timeout: COMPOSE_BUILD_MS });
        const up = runCompose('up -d', { timeout: COMPOSE_UP_MS });
        if (up.ok) {
          await waitForHttp(url, { timeoutMs: HTTP_PROBE_TOTAL_MS, intervalMs: HTTP_PROBE_POLL_LIVE_MS });
          const recheck = await runUiSanityCheck({ url, uiContract: uiContractForCheck });
          if (recheck && !recheck.skipped) uiSanity = recheck;
          emitVerifyStep(session.id, 'visual-check', uiSanity.sane ? 'done' : 'warn',
            uiSanity.sane ? 'fixed after 1 repair round' : `${uiSanity.defects.length} visual defect(s) remain after repair`);
        } else {
          tlog('[ui-sanity] compose up after visual fix failed: %s', up.stderr);
        }
      }
    }

    if (uiSanity && !uiSanity.skipped) {
      session.uiSanitySummary = { sane: uiSanity.sane, defects: uiSanity.defects };
      const ev = appendEvent(session.id, 'ui_sanity_result', session.uiSanitySummary);
      sessionEvents.emit('event', session.id, ev);
      if (!uiSanity.sane && uiSanity.defects.length > 0) {
        const list = uiSanity.defects.map((d) => `- (${d.severity}) ${d.description}`).join('\n');
        const msg =
          `I took a screenshot of the running app and spotted visual defects on the primary view:\n\n${list}\n\n` +
          `Ask me to fix these and I'll dispatch the frontend agent.`;
        const warnEv = appendEvent(session.id, 'cline', { say: 'text', text: msg });
        sessionEvents.emit('event', session.id, warnEv);
      }
    } else if (uiSanity?.skipped) {
      tlog('[ui-sanity] skipped: %s', uiSanity.skipped);
    }
  } catch (err) {
    logAndSwallow(err, '[ui-sanity] check threw');
  }

  // ── Authz posture fingerprint (behavioral, warn-only) ──
  // Role × endpoint matrix from the app's own advertised roles. First build
  // records the baseline; iterates diff against it. An iterate was observed
  // to silently remove a role gate (operator 403 → 201 on an admin surface)
  // with every other check green — expansions are surfaced loudly, all other
  // posture changes land in the report. Never blocks app-ready.
  try {
    emitVerifyStep(session.id, 'authz-check', 'start');
    let apiContractForAuthz = routerContracts?.apiContract || null;
    if (!apiContractForAuthz) {
      try {
        const env2 = readContracts(WORKSPACE_DIR);
        apiContractForAuthz = env2?.data?.apiContract || env2?.data?.api_contract || null;
      } catch { /* skip below */ }
    }
    if (apiContractForAuthz) {
      const { buildAuthzMatrix, diffAuthzMatrix, formatAuthzDiff, deriveExpectedRoles, verifyAuthzAgainstRules, formatAuthzViolations } = await import('../reconciler/authz-matrix.js');
      const { readAuthzMatrix, writeAuthzMatrix } = await import('./harness-state.js');
      let next = await buildAuthzMatrix({ baseUrl: url, apiContract: apiContractForAuthz });
      if (!next) {
        emitVerifyStep(session.id, 'authz-check', 'done', 'skipped (no roles advertised)');
      } else {
        // ── Baseline-vs-rules verification + repair ──
        // The diff below catches posture CHANGES across iterates, but a fresh
        // build can ship a gate that was never implemented (observed: a
        // technician could POST /sops though the rules said quality_team only).
        // Derive the expected role posture from the business_logic rules and
        // dispatch ONE bounded backend fix on any gate MISS (a role reachable
        // where the rules forbid it). Runs on every build; conservative —
        // only endpoints whose rule parsed confidently are judged.
        let businessLogicForAuthz = routerContracts?.businessLogicContract || null;
        if (!businessLogicForAuthz) {
          try {
            const env3 = readContracts(WORKSPACE_DIR);
            businessLogicForAuthz = env3?.data?.businessLogicContract || env3?.data?.business_logic_contract || null;
          } catch { /* none */ }
        }
        const expectedRoles = deriveExpectedRoles({ apiContract: apiContractForAuthz, businessLogic: businessLogicForAuthz, roles: next.roles });
        let verdict = verifyAuthzAgainstRules(next, expectedRoles);
        const authzHandled = verdict.violations.length > 0; // owns the verify-step below
        if (verdict.violations.length > 0) {
          const counter = scopeCounters.get('backend') || {};
          if (!counter.authzFixAttempts) {
            counter.authzFixAttempts = 1;
            scopeCounters.set('backend', counter);
            const formatted = [
              '=== AUTHZ GATE MISSING (a role can reach an endpoint the rules forbid) ===',
              '',
              'The live app lets these roles reach endpoints the business_logic rules',
              'restrict — a real authorization hole. Enforce the gate in the handler',
              '(return 403 when the current user\'s role is not permitted). This applies',
              'to EVERY route for the resource, including multipart/upload handlers.',
              '',
              formatAuthzViolations(verdict),
              '',
              'Relevant rules:',
              ...((businessLogicForAuthz?.rules) || []).map((r) => `  - ${r}`),
            ].join('\n');
            tlog('[authz-check] %d gate violation(s) — dispatching backend fix:\n%s', verdict.violations.length, formatAuthzViolations(verdict));
            const ev = appendEvent(session.id, 'authz_gate_fix_dispatch', verdict);
            sessionEvents.emit('event', session.id, ev);
            try {
              const { buildFixDirective, pushAutoRecoveryRecord } = await import('./auto-recovery.js');
              pushAutoRecoveryRecord(session, { scope: 'backend', attemptN: 1, triggeredBy: 'authz-check', failureSummary: `${verdict.violations.length} authz gate violation(s)`, exhausted: false });
              const directive = buildFixDirective('backend', [{ source: 'runtime-gate', formatted }]);
              const { runCustomAgent } = await import('../agent/agent.js');
              const { PHASES } = await import('../agent/loop/phase.js');
              const agentResult = await runCustomAgent(session.id, directive, { conversationId: null, scope: 'backend', phase: PHASES.SUBAGENT, priorTokenTotals: session.coderTokenTotals || null });
              accumulateAgentTotals(session, agentResult);
              runCompose('build backend', { timeout: COMPOSE_BUILD_MS });
              const up = runCompose('up -d', { timeout: COMPOSE_UP_MS });
              if (up.ok) {
                await waitForHttp(url, { timeoutMs: HTTP_PROBE_TOTAL_MS, intervalMs: HTTP_PROBE_POLL_LIVE_MS });
                const reprobe = await buildAuthzMatrix({ baseUrl: url, apiContract: apiContractForAuthz });
                if (reprobe) { next = reprobe; verdict = verifyAuthzAgainstRules(reprobe, expectedRoles); }
              }
            } catch (err) {
              logAndSwallow(err, '[authz-check] gate-fix dispatch threw');
            }
          }
          emitVerifyStep(session.id, 'authz-check', verdict.violations.length ? 'warn' : 'done',
            verdict.violations.length ? `${verdict.violations.length} gate violation(s) remain after repair` : 'gate violation fixed after 1 repair round');
          if (verdict.violations.length > 0) {
            const msg = `Security check — these access rules aren't being enforced yet:\n\n${formatAuthzViolations(verdict)}\n\nAsk me to fix these and I'll add the missing checks.`;
            const warnEv = appendEvent(session.id, 'cline', { say: 'text', text: msg });
            sessionEvents.emit('event', session.id, warnEv);
          }
        }

        // Session-scoped: an iterate diffs against ITS app's baseline; a
        // fresh build (new session) never diffs against the previous app.
        const stored = readAuthzMatrix(WORKSPACE_DIR);
        const prev = stored && stored.sessionId === session.id ? stored : null;
        writeAuthzMatrix(WORKSPACE_DIR, { sessionId: session.id, ...next });
        const diff = prev ? diffAuthzMatrix(prev, next) : null;
        const changed = diff && (diff.expansions.length || diff.tightenings.length || diff.added.length || diff.removed.length || (diff.unserved || []).length);
        if (!prev) {
          if (!authzHandled) emitVerifyStep(session.id, 'authz-check', 'done', `baseline recorded (${next.roles.length} roles × ${Object.keys(next.entries).length} endpoints)`);
        } else if (!changed) {
          if (!authzHandled) emitVerifyStep(session.id, 'authz-check', 'done', 'posture unchanged');
        } else {
          session.authzSummary = diff;
          const ev = appendEvent(session.id, 'authz_posture_change', diff);
          sessionEvents.emit('event', session.id, ev);
          emitVerifyStep(session.id, 'authz-check', diff.expansions.length ? 'warn' : 'done',
            `${diff.expansions.length} expansion(s), ${diff.tightenings.length} tightening(s), +${diff.added.length}/-${diff.removed.length} endpoints, ${(diff.unserved || []).length} unserved`);
          tlog('[authz-check] posture changed:\n%s', formatAuthzDiff(diff));
          if (diff.expansions.length) {
            const msg =
              `Heads up — this change ALTERED who can access what:\n\n${formatAuthzDiff(diff)}\n\n` +
              `If you asked for these access changes, all good. If not, tell me and I'll restore the previous restrictions.`;
            const warnEv = appendEvent(session.id, 'cline', { say: 'text', text: msg });
            sessionEvents.emit('event', session.id, warnEv);
          }
        }
      }
    } else {
      emitVerifyStep(session.id, 'authz-check', 'done', 'skipped (no contract)');
    }
  } catch (err) {
    logAndSwallow(err, '[authz-check] threw (non-fatal)');
  }

  tlog('[session] Auto-start: scanning backend logs');
  const backendErrors = scanBackendLogsForErrors();
  tlog('[session] Auto-start: backend log scan done found=%s', backendErrors ? backendErrors.errorLines.length : 0);
  if (backendErrors) {
    const msg =
      `Your app started, but the backend container is logging errors. The app may crash on API calls until this is fixed.\n\n` +
      `**Errors detected:**\n\`\`\`\n${backendErrors.errorLines.join('\n')}\n\`\`\`\n\n` +
      `<details><summary>Last 40 lines of \`docker compose logs backend\`</summary>\n\n\`\`\`\n${backendErrors.tail}\n\`\`\`\n</details>\n\n` +
      `Ask me to debug this, or run \`docker compose logs backend\` yourself.`;
    const warnEvent = appendEvent(session.id, 'cline', { say: 'text', text: msg });
    sessionEvents.emit('event', session.id, warnEvent);
    tlog('[session] Auto-start: backend logs contain %d error line(s) — surfaced to UI', backendErrors.errorLines.length);
  }

  // Still-broken endpoints get their own detail message so the app-ready
  // prompt stays scannable.
  if (verification && verification.stillBroken?.length > 0) {
    const list = verification.stillBroken
      .map((f) => `- \`${f.method} ${f.path}\` — ${f.status !== null && f.status !== undefined ? `HTTP ${f.status}` : f.error}`)
      .join('\n');
    const brokenMsg =
      `I probed every endpoint from the plan against the running app. ` +
      `${verification.stillBroken.length} of ${verification.probed} still fail after ${MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE} automatic fix attempt(s):\n\n${list}\n\n` +
      (verification.crashed?.length ? `Containers not running: ${verification.crashed.map((c) => `${c.service} (${c.state})`).join(', ')}.\n\n` : '') +
      `Ask me to debug these and I'll pick up from the probe results.`;
    const brokenEvent = appendEvent(session.id, 'cline', { say: 'text', text: brokenMsg });
    sessionEvents.emit('event', session.id, brokenEvent);
  }

  session.pendingAppOpen = { url, startedAt: Date.now() };

  // MGA status line for AI apps: confirm the credentials flow worked, or
  // warn when assistants exist but the env file is incomplete.
  let mgaLine = '';
  try {
    const mgaEnv = readWorkspaceMgaEnv(WORKSPACE_DIR);
    const isAiApp = (session.createdMgaAssistantIds?.length || 0) > 0 || mgaEnv.present;
    if (isAiApp) {
      const complete = mgaEnv.present && mgaEnv.apiKeySet && mgaEnv.assistants.some((a) => a.set);
      mgaLine = complete
        ? ' MGA assistant is provisioned and wired via the workspace .env (local only — deploy wiring is manual for now).'
        : ' Warning: this app expects MGA credentials but the workspace .env is incomplete — AI features may fail. Check the App Secrets panel.';
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-start: MGA status line failed');
  }

  tlog('[session] Auto-start: emitting app_ready_prompt');
  const securityLine = session.securitySummary?.stillOpen
    ? ` ${session.securitySummary.stillOpen} security issue(s) need your attention (see above).`
    : '';
  const promptEvent = appendEvent(session.id, 'app_ready_prompt', {
    url,
    message: buildAppReadyMessage(verification, backendErrors) + mgaLine + securityLine,
  });
  sessionEvents.emit('event', session.id, promptEvent);
  tlog('[session] Auto-start: app_ready_prompt emitted; runSmokeAndPrompt returning');
}

/**
 * Security review of the GENERATED app. Runs on every build, BEFORE containers
 * build (so an auto-fix re-drives the container build + all downstream verify).
 * Reviews the source, AUTO-FIXES Critical/High (one round per scope, modeled on
 * the authz gate), and reports the rest. Non-blocking — findings never stop the
 * build. Sets session.securitySummary for the app-ready line + run summary.
 * SECURITY_REVIEW_SKIP=true disables it.
 */
async function runSecurityReviewAndFix(session, scopeCounters, routerContracts) {
  if (process.env.SECURITY_REVIEW_SKIP === 'true') return;
  const scopes = Array.isArray(routerContracts?.tasks)
    ? [...new Set(routerContracts.tasks.map((t) => t && t.scope).filter(Boolean))]
    : [];
  try {
    emitVerifyStep(session.id, 'security-review', 'start');
    const { reviewGeneratedApp, partitionFindings, formatSecurityFixDirective } =
      await import('../reconciler/security-review.js');
    const result = await reviewGeneratedApp({ workspaceDir: WORKSPACE_DIR, scopes });
    if (result.skipped) { emitVerifyStep(session.id, 'security-review', 'done', 'skipped'); return; }

    const findings = result.findings || [];
    const { criticalHigh, reportOnly, byScope } = partitionFindings(findings);

    let fixedCount = 0;
    const stillOpen = [];
    for (const [scope, scopeFindings] of byScope) {
      const counter = scopeCounters.get(scope) || {};
      if (counter.securityFixAttempts) { stillOpen.push(...scopeFindings); continue; } // budget: 1/scope/build
      counter.securityFixAttempts = 1;
      scopeCounters.set(scope, counter);
      const ev = appendEvent(session.id, 'security_fix_dispatch', { scope, count: scopeFindings.length, findings: scopeFindings });
      sessionEvents.emit('event', session.id, ev);
      try {
        const { buildFixDirective, pushAutoRecoveryRecord } = await import('./auto-recovery.js');
        pushAutoRecoveryRecord(session, { scope, attemptN: 1, triggeredBy: 'security-review', failureSummary: `${scopeFindings.length} security finding(s)`, exhausted: false });
        const formatted = formatSecurityFixDirective(scope, scopeFindings);
        const directive = buildFixDirective(scope, [{ source: 'security', formatted }]);
        const { runCustomAgent } = await import('../agent/agent.js');
        const { PHASES } = await import('../agent/loop/phase.js');
        const agentResult = await runCustomAgent(session.id, directive, { conversationId: null, scope, phase: PHASES.SUBAGENT, priorTokenTotals: session.coderTokenTotals || null });
        accumulateAgentTotals(session, agentResult);
        fixedCount += scopeFindings.length; // dispatched; the ensuing build + verify re-check the code
      } catch (err) {
        logAndSwallow(err, '[security-review] fix dispatch threw');
        stillOpen.push(...scopeFindings);
      }
    }

    session.securitySummary = {
      reviewed: findings.length,
      critical: findings.filter((f) => f.severity === 'Critical').length,
      high: findings.filter((f) => f.severity === 'High').length,
      fixed: fixedCount,
      stillOpen: stillOpen.length,
      reportOnly: reportOnly.length,
    };
    const detail = findings.length === 0
      ? 'no issues'
      : `${criticalHigh.length} critical/high (${fixedCount} auto-fixed${stillOpen.length ? `, ${stillOpen.length} open` : ''}), ${reportOnly.length} lower`;
    emitVerifyStep(session.id, 'security-review', stillOpen.length ? 'warn' : 'done', detail);

    const notable = [...stillOpen, ...reportOnly];
    if (notable.length) {
      const lines = notable.map((f) => `  [${f.severity}] ${f.summary}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`);
      const msg = `Security review — ${fixedCount ? `auto-fixed ${fixedCount} critical/high issue(s); ` : ''}${notable.length} item(s) to review:\n\n${lines.join('\n')}\n\nAsk me to fix any of these.`;
      const warnEv = appendEvent(session.id, 'cline', { say: 'text', text: msg });
      sessionEvents.emit('event', session.id, warnEv);
    }
  } catch (err) {
    emitVerifyStep(session.id, 'security-review', 'warn', 'review skipped');
    logAndSwallow(err, '[security-review] phase threw');
  }
}

/**
 * Uniform per-phase progress event for the verification pipeline. The UI
 * folds these into a step list ("Code quality → Cross-checks → Containers →
 * Endpoint tests → Visual check") so the verify phase isn't an opaque
 * multi-minute silence. status: 'start' | 'fixing' | 'done' | 'warn'.
 * detail is a short human-readable outcome composed server-side.
 */
function emitVerifyStep(sessionId, step, status, detail = '') {
  try {
    const ev = appendEvent(sessionId, 'verify_step', { step, status, detail, ts: Date.now() });
    sessionEvents.emit('event', sessionId, ev);
  } catch (err) {
    logAndSwallow(err, '[verify-step] emit failed');
  }
}

/**
 * Apply database migrations that landed after the DB volume was created.
 * Init SQL only runs on an EMPTY volume, so an iterate that adds a table
 * ships database/migrations/NNN_*.sql that nothing executes (observed live:
 * prompt_templates table missing → 500s/timeouts on the new endpoints).
 * Ledger at .harness/applied-migrations.json prevents re-runs; failures are
 * warn-level — the endpoint probe downstream surfaces real breakage.
 */
function applyPendingMigrations(session) {
  const migrationsDir = path.join(WORKSPACE_DIR, 'database', 'migrations');
  if (!existsSync(migrationsDir)) return { applied: [], failed: [] };
  const ledgerPath = path.join(WORKSPACE_DIR, '.harness', 'applied-migrations.json');
  let ledger = [];
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')); } catch { ledger = []; }
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !ledger.includes(f));
  const applied = [];
  const failed = [];
  for (const file of pending) {
    try {
      const sql = readFileSync(path.join(migrationsDir, file), 'utf-8');
      const db = LOCAL_DB_CREDENTIALS;
      execSync(`docker compose exec -T database psql -v ON_ERROR_STOP=1 -U ${db.user} -d ${db.name}`, {
        cwd: WORKSPACE_DIR,
        input: sql,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      applied.push(file);
      ledger.push(file);
      tlog('[migrations] applied %s to the running database', file);
    } catch (err) {
      failed.push(file);
      tlog('[migrations] FAILED to apply %s: %s', file, (err.stderr?.toString() || err.message || '').slice(0, 300));
    }
  }
  if (applied.length) {
    try {
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    } catch (err) { logAndSwallow(err, '[migrations] ledger write failed'); }
  }
  return { applied, failed };
}

/**
 * The honest app-ready line: what was probed, what was healed, what's still
 * broken. Falls back to the legacy boot-error phrasing when verification
 * didn't run (no contract / skipped).
 */
function buildAppReadyMessage(verification, backendErrors) {
  if (!verification || verification.skipped) {
    return backendErrors
      ? 'App is running but had errors at boot. Open anyway?'
      : 'Your app is running. Want to open it?';
  }
  if (verification.stillBroken.length > 0) {
    return `App is running but ${verification.stillBroken.length} of ${verification.probed} endpoints are still failing (details above). Open anyway?`;
  }
  const sampleNote = ' A few sample rows were created while verifying.';
  if (verification.fixed > 0) {
    const fixedPhrase = verification.fixed === 1
      ? '1 failed initially and was auto-fixed'
      : `${verification.fixed} failed initially and were auto-fixed`;
    return `Your app is running — ${verification.probed} endpoints probed, ${fixedPhrase}.${sampleNote} Want to open it?`;
  }
  return `Your app is running — all ${verification.probed} API endpoints verified.${sampleNote} Want to open it?`;
}

/**
 * After a plan finishes, boot the app with compose and hand the user a
 * prompt to open or stop it. Best-effort — any failure just logs and skips
 * the prompt; the user can still click "Run locally" manually.
 */
export async function tryAutoStartApp(session, envContext, routerContracts = {}) {
  const composePath = path.join(WORKSPACE_DIR, 'docker-compose.yml');
  if (!existsSync(composePath)) {
    tlog('[session] Auto-start skipped — no docker-compose.yml');
    return;
  }
  // PR 2 / Alt A — caller may pass the contract agent's messages[] on
  // the third arg so the reconciler-judge can continue that conversation
  // when classifying extras. Falsy = the judge falls back to a stateless
  // single-shot call routed through the contract agent assistant.
  const contractAgentMessages = routerContracts?.contractAgentMessages || null;

  await applyAllValidators(session);
  if (!await prepareForCompose(session)) return;
  // W3.RECOV — `scopeCounters` is the shared per-scope counter map both
  // the reconciler (which mutates `.reengages`) and the auto-recovery
  // loop (which mutates `.fixAttempts`) read/write. One Map per build
  // so a scope's drift across the whole boot is observable in one
  // place. See HARNESS_EVOLUTION.md Section F + the pre-flight memo's
  // L.3 paragraph.
  const scopeCounters = new Map();

  // W3.TYPES.GATE pipeline-reorder (HARNESS_EVOLUTION.md §O — explicit
  // wording added post-Phase-3): type-gate fires HERE, right after
  // subagent writes and BEFORE the reconciler-loop. Rationale: type-gate
  // is <5s/scope vs reconciler-loop's 5-7min on a 5-scope build; running
  // type-gate first means we either fix-dispatch quickly on compile
  // errors OR the reconciler-loop runs on type-clean code (fewer cross-
  // scope mismatches → faster reconciler). Per-scope fix budget caps at
  // MAX_FIX_ATTEMPTS_PER_SCOPE, shared with post-reconciler runAutoRecovery
  // via the same scopeCounters Map; reconciler re-engages count
  // separately. logAndSwallow per L.5 — type-gate phase failure must
  // never crash the build.
  try {
    const scopes = Array.isArray(routerContracts?.tasks)
      ? [...new Set(routerContracts.tasks.map((t) => t && t.scope).filter(Boolean))]
      : [];
    if (scopes.length) {
      emitVerifyStep(session.id, 'code-quality', 'start');
      const { runTypeGatePhase } = await import('./auto-recovery.js');
      await runTypeGatePhase({ session, scopes, scopeCounters, routerContracts });
      const fixedScopes = [...scopeCounters.entries()]
        .filter(([, c]) => (c.fixAttempts || 0) > 0)
        .map(([s]) => s);
      emitVerifyStep(session.id, 'code-quality', 'done',
        fixedScopes.length ? `fixed ${fixedScopes.join(', ')}` : 'clean');
    }
  } catch (err) {
    emitVerifyStep(session.id, 'code-quality', 'warn', 'check skipped');
    logAndSwallow(err, '[type-gate-phase] phase wrapper threw');
  }

  emitVerifyStep(session.id, 'cross-check', 'start');
  const reconcilerOk = await runReconcilerLoop(session, routerContracts, scopeCounters, { contractAgentMessages });
  emitVerifyStep(session.id, 'cross-check', reconcilerOk ? 'done' : 'warn', reconcilerOk ? 'parts agree' : 'did not finish');
  if (!reconcilerOk) return;

  // Auto-recovery loop (W3.RECOV §F). Runs structural-checks + file-
  // structure-check + runtime-asserts against the post-reconciler
  // workspace; dispatches fix runs per scope up to MAX_FIX_ATTEMPTS_PER_SCOPE.
  // Best-effort — any throw is swallowed so the build still proceeds.
  // Skipped silently when routerContracts has no tasks[] (orchestrator
  // ran in legacy modes that don't emit a scope list).
  try {
    const scopes = Array.isArray(routerContracts?.tasks)
      ? [...new Set(routerContracts.tasks.map((t) => t && t.scope).filter(Boolean))]
      : [];
    if (scopes.length) {
      emitVerifyStep(session.id, 'auto-recovery', 'start');
      const { runAutoRecovery } = await import('./auto-recovery.js');
      const recovery = await runAutoRecovery({
        session,
        scopes,
        scopeCounters,
        routerContracts,
      });
      const recovered = recovery?.recoveredScopes || [];
      const exhausted = recovery?.exhaustedScopes || [];
      emitVerifyStep(session.id, 'auto-recovery',
        exhausted.length ? 'warn' : 'done',
        recovered.length || exhausted.length
          ? [recovered.length ? `recovered ${recovered.join(', ')}` : null, exhausted.length ? `${exhausted.join(', ')} still failing` : null].filter(Boolean).join('; ')
          : 'nothing to fix');
    }
  } catch (err) {
    logAndSwallow(err, '[session] Auto-recovery loop failed (non-fatal)');
  }

  // Security review of the generated app. Placed BEFORE containers build so an
  // auto-fix re-drives buildAndStartContainers + the whole downstream verify
  // against fixed code. Non-blocking; own try/catch inside.
  await runSecurityReviewAndFix(session, scopeCounters, routerContracts);

  emitVerifyStep(session.id, 'containers', 'start');
  const containersOk = await buildAndStartContainers(session);
  emitVerifyStep(session.id, 'containers', containersOk ? 'done' : 'warn', containersOk ? 'built and running' : 'failed to start');
  if (!containersOk) return;

  try {
    // Live schema drift check: compare the CONTRACT's tables/columns against
    // the RUNNING database. Every static gate compares paper against paper —
    // a stale volume (init only runs when empty; observed after a failed
    // `down -v`) makes the live DB a previous app's schema and requests hang
    // on missing columns with nothing flagging it.
    try {
      const envData = readContracts(WORKSPACE_DIR)?.data;
      const tables = envData?.dataModel?.tables || [];
      const missing = [];
      // SQL identifier guard: `t.name` originates from the (LLM-authored)
      // contract, so it must NEVER be interpolated into a shell/SQL string.
      // NOTE: readContracts() only JSON.parses — it does NOT run the
      // contracts-schema validator (that runs only in the type generator), so
      // THIS use-site check is the sole enforced guard on the drift path. Keep
      // it even if ingest validation is later added here. Combined with
      // execFileSync (no shell) below, it closes both shell- and SQL-injection.
      const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
      for (const t of tables) {
        if (!SQL_IDENT.test(String(t.name || ''))) continue;
        let live = '';
        try {
          // execFileSync (no shell) — args are passed literally, so even a
          // malformed name can't break out into the host shell. The name is
          // additionally identifier-validated above before reaching the SQL.
          live = execFileSync('docker', [
            'compose', 'exec', '-T', 'database',
            'psql', '-U', LOCAL_DB_CREDENTIALS.user, '-d', LOCAL_DB_CREDENTIALS.name,
            '-t', '-A', '-c',
            `SELECT column_name FROM information_schema.columns WHERE table_name='${t.name}'`,
          ], { cwd: WORKSPACE_DIR, stdio: 'pipe', timeout: 15_000 }).toString();
        } catch { /* table query failed → counts as missing below */ }
        const liveCols = new Set(live.split('\n').map((x) => x.trim()).filter(Boolean));
        if (liveCols.size === 0) { missing.push(`table ${t.name} missing entirely`); continue; }
        for (const c of (t.columns || [])) {
          const colName = String(c.name || '').toLowerCase();
          if (colName && !liveCols.has(colName)) missing.push(`${t.name}.${colName}`);
        }
      }
      if (missing.length) {
        tlog('[schema-drift] LIVE DB does not match contract: %s', missing.slice(0, 10).join(', '));
        emitVerifyStep(session.id, 'database-schema', 'warn',
          `live database is missing ${missing.length} contract column(s)/table(s) (stale volume?) — Clean and start over recreates it: ${missing.slice(0, 5).join(', ')}`);
      }
    } catch (err) { logAndSwallow(err, '[schema-drift] live check failed'); }

    const migrations = applyPendingMigrations(session);
    if (migrations.applied.length || migrations.failed.length) {
      emitVerifyStep(session.id, 'migrations',
        migrations.failed.length ? 'warn' : 'done',
        [migrations.applied.length ? `applied ${migrations.applied.join(', ')}` : null,
         migrations.failed.length ? `${migrations.failed.join(', ')} failed` : null].filter(Boolean).join('; '));
    }
  } catch (err) {
    logAndSwallow(err, '[migrations] apply phase threw');
  }
  tlog('[session] Auto-start: containers up, calling runSmokeAndPrompt');
  await runSmokeAndPrompt(session, envContext, routerContracts, scopeCounters);
  tlog('[session] Auto-start: runSmokeAndPrompt returned, tryAutoStartApp exiting');
}
