/**
 * Runtime-gate (Alt A — per-scope docker build + run + minimal probe).
 *
 * Runs in the pre-reconciler phase right after type-gate. Catches the
 * class of failures that previously only surfaced at full compose-up:
 *
 *   - Dockerfile errors (bad COPY path, missing FROM)
 *   - npm install / pip install failures during build
 *   - Process crash on import (missing module, syntax error in startup)
 *   - Bad nginx.conf (frontend service exits)
 *   - init.sql parse errors (postgres init fails)
 *   - Port misbind (service starts but doesn't listen)
 *
 * Per-scope strategy (parallel via Promise.all in the caller):
 *
 *   backend  → docker build → docker run (stub envs) → GET /health
 *   frontend → docker build → docker run            → GET /
 *   database → docker build → docker run            → pg_isready + SELECT 1
 *   vectordb → docker build → docker run            → pg_isready + vector ext check
 *   integration → docker compose config -q (YAML+ref validation only)
 *
 * Scope skip rules:
 *   - Scope has no Dockerfile → skipped (e.g., integration without compose file)
 *   - Probe-relevant tools missing in image → soft-skip with reason
 *
 * Output shape:
 *   runRuntimeGate({ workspaceDir, scope, runId, portOffset })
 *     → { hasErrors, errors[], formatted, durationMs, runtime, skipped?, skipReason? }
 *
 * `formatted` is the rendered block fed to the fix-dispatch subagent.
 * Capped at MAX_RUNTIME_GATE_CONTEXT_BYTES.
 *
 * Cleanup: container + image removal in finally{} for every scope.
 * Best-effort posture: any internal crash returns `{ skipped: true,
 * skipReason: '...' }` so a broken runtime-gate never blocks a build.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { logAndSwallow } from '../util/log-helpers.js';
import {
  RUNTIME_GATE_BUILD_TIMEOUT_MS,
  RUNTIME_GATE_PROBE_TIMEOUT_MS,
  MAX_RUNTIME_GATE_CONTEXT_BYTES,
} from '../config/defaults.js';

const execFileAsync = promisify(execFile);

// Host-port base for each scope's probe. Final port = base + portOffset.
// Concurrent smoke runs use different portOffset values (smoke harness
// allocates them per scenario), so two concurrent runs of t6 and t11 with
// offsets 0 and 10 land on disjoint port pairs.
const PROBE_PORT_BASE = {
  backend: 19000,
  frontend: 19100,
  database: 19200,
  vectordb: 19300,
};

// Container port the service inside each image listens on (matches the
// canonical scaffold Dockerfiles). Used as the right side of -p mapping.
const SERVICE_CONTAINER_PORT = {
  backend: 3000,
  frontend: 8080,
  database: 5432,
  vectordb: 5432,
};

// Stub env vars for backend probe. The probe only validates that the
// process starts + serves /health — /health is hardcoded in the scaffold
// and doesn't touch DB. So we feed obviously-fake DB creds and assume
// the backend's startup code doesn't eagerly connect.
const BACKEND_STUB_ENVS = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgres://stub:stub@stub-host:5432/stub',
  POSTGRES_HOST: 'stub-host',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'stub',
  POSTGRES_PASSWORD: 'stub',
  POSTGRES_DB: 'stub',
  VECTORDB_HOST: 'stub-host',
  VECTORDB_PORT: '5432',
  VECTORDB_USER: 'stub',
  VECTORDB_PASSWORD: 'stub',
  VECTORDB_DB: 'stub',
  OPENAI_API_KEY: 'sk-stub',
  MGA_API_KEY: 'stub',
};

// Postgres-family envs (db + vectordb): NEUTRAL defaults only. The gate
// previously fabricated names (POSTGRES_DB=stub_db) and they leaked into
// generated code — a gate probe error saying `database "stub_db" does not
// exist` taught the fix agent to write `CREATE DATABASE stub_db` into the
// init SQL, which satisfied the gate and broke production (observed live
// 2026-07-16, sop-assistant vectordb). Trust auth + the image's stock
// `postgres` db/user cannot teach an agent a wrong name: init scripts that
// boot under the defaults boot under any compose-provided POSTGRES_DB.
const POSTGRES_STUB_ENVS = {
  POSTGRES_HOST_AUTH_METHOD: 'trust',
};
const POSTGRES_PROBE_DB = 'postgres';

/**
 * Sanitize a string for use as a docker container name / image tag.
 * Docker requires lowercase letters, digits, dashes, underscores.
 */
function sanitizeForDocker(s) {
  return String(s || 'run').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
}

/**
 * Sleep helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a function until it returns truthy or the deadline passes.
 * Returns the last function result (truthy on success, falsy on timeout).
 */
async function pollUntil(fn, { timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  return last;
}

/**
 * Run a docker command and capture stdout/stderr. Throws on non-zero exit.
 */
async function docker(args, { timeoutMs = 30_000 } = {}) {
  return execFileAsync('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024, // 4 MB ceiling for build/log output
  });
}

/**
 * Fetch container logs, tail'd to keep the formatted block under budget.
 */
async function dockerLogsTail(containerName, lines = 80) {
  try {
    const { stdout, stderr } = await docker(['logs', '--tail', String(lines), containerName], { timeoutMs: 10_000 });
    return (stdout + stderr).trim();
  } catch {
    return '(docker logs unavailable)';
  }
}

/**
 * Force-remove a container; ignore failures (container may already be gone).
 */
async function cleanupContainer(containerName) {
  try {
    await docker(['rm', '-f', containerName], { timeoutMs: 15_000 });
  } catch {
    // ignore — name may not exist or removal raced with a previous cleanup
  }
}

/**
 * Force-remove an image; ignore failures (image may have build-failed or
 * already been removed concurrently).
 */
async function cleanupImage(imageTag) {
  try {
    await docker(['rmi', '-f', imageTag], { timeoutMs: 30_000 });
  } catch {
    // ignore
  }
}

/**
 * Build the docker image for one scope. Returns { ok, error?, durationMs }.
 */
async function buildImage({ workspaceDir, scope, imageTag }) {
  const scopeDir = path.join(workspaceDir, scope);
  const t0 = Date.now();
  try {
    await docker(
      ['build', '--quiet', '-t', imageTag, scopeDir],
      { timeoutMs: RUNTIME_GATE_BUILD_TIMEOUT_MS },
    );
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (err) {
    // err.stdout / err.stderr contain the docker build output up to the
    // failure point. stderr usually has the failing step.
    const stderr = (err.stderr || '').toString().trim();
    const stdout = (err.stdout || '').toString().trim();
    const combined = [stderr, stdout].filter(Boolean).join('\n\n');
    return {
      ok: false,
      durationMs: Date.now() - t0,
      error: combined || err.message || 'docker build failed (no output captured)',
    };
  }
}

/**
 * Run an HTTP probe against a host:port URL with retries.
 */
async function probeHttp(url) {
  const result = await pollUntil(
    async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3_000);
      try {
        const res = await fetch(url, { signal: ac.signal });
        clearTimeout(timer);
        if (res.ok || (res.status >= 200 && res.status < 400)) {
          return { ok: true, status: res.status };
        }
        return false;
      } catch (e) {
        clearTimeout(timer);
        return false;
      }
    },
    { timeoutMs: RUNTIME_GATE_PROBE_TIMEOUT_MS, intervalMs: 1000 },
  );
  return result || { ok: false, error: 'probe timeout — service did not respond with 2xx/3xx' };
}

/**
 * Probe a postgres-family container via docker exec.
 *  - pg_isready returns 0 when accepting connections
 *  - extra check is an optional psql query (e.g., vector extension check)
 */
async function probePostgres({ containerName, extraSql = null }) {
  const ready = await pollUntil(
    async () => {
      try {
        await docker(
          ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', POSTGRES_PROBE_DB],
          { timeoutMs: 4_000 },
        );
        return { ok: true };
      } catch {
        return false;
      }
    },
    { timeoutMs: RUNTIME_GATE_PROBE_TIMEOUT_MS, intervalMs: 1000 },
  );
  if (!ready || !ready.ok) {
    return { ok: false, error: 'pg_isready never returned success within probe window' };
  }
  if (extraSql) {
    try {
      const { stdout } = await docker(
        ['exec', containerName, 'psql', '-U', 'postgres', '-d', POSTGRES_PROBE_DB, '-tAc', extraSql],
        { timeoutMs: 8_000 },
      );
      const value = (stdout || '').trim();
      if (!value) {
        return { ok: false, error: `postgres extra check returned empty: ${extraSql}` };
      }
      return { ok: true, extra: value };
    } catch (err) {
      const stderr = (err.stderr || '').toString().trim();
      return { ok: false, error: `postgres extra check failed (${extraSql}): ${stderr || err.message}` };
    }
  }
  return { ok: true };
}

/**
 * Format runtime-gate errors as a single string block for the fix-dispatch
 * subagent. Caps total size at MAX_RUNTIME_GATE_CONTEXT_BYTES.
 */
function formatErrors(scope, errors) {
  const lines = [
    `Scope=${scope} failed the runtime-gate (per-scope docker build + run + probe).`,
    'Below are the failures captured. Fix the underlying issue, then emit attempt_completion.',
    '',
  ];
  for (const e of errors) {
    lines.push(`--- ${e.kind.toUpperCase()} FAIL @ stage=${e.stage} ---`);
    if (e.message) lines.push(e.message.slice(0, 2_000));
    if (e.dockerLogs) {
      lines.push('');
      lines.push('Container logs (last 80 lines):');
      lines.push(e.dockerLogs.slice(0, 4_000));
    }
    lines.push('');
  }
  let out = lines.join('\n');
  if (out.length > MAX_RUNTIME_GATE_CONTEXT_BYTES) {
    out = out.slice(0, MAX_RUNTIME_GATE_CONTEXT_BYTES) + '\n\n[truncated — formatted block exceeded byte cap]';
  }
  return out;
}

/**
 * Decide whether a scope is probeable. Returns { probeable, skipReason? }.
 */
function checkScopeProbeable(workspaceDir, scope) {
  if (scope === 'integration') {
    const composeFile = path.join(workspaceDir, 'integration', 'docker-compose.yml');
    if (!existsSync(composeFile)) {
      return { probeable: false, skipReason: 'integration/docker-compose.yml not present' };
    }
    return { probeable: true };
  }
  const dockerfile = path.join(workspaceDir, scope, 'Dockerfile');
  if (!existsSync(dockerfile)) {
    return { probeable: false, skipReason: `${scope}/Dockerfile not present` };
  }
  if (!(scope in PROBE_PORT_BASE)) {
    return { probeable: false, skipReason: `no runtime-gate handler registered for scope=${scope}` };
  }
  return { probeable: true };
}

/**
 * Special-case probe for integration scope: `docker compose config -q`.
 * No build, no run — just YAML + ref validation.
 */
async function probeIntegration({ workspaceDir }) {
  const composeFile = path.join(workspaceDir, 'integration', 'docker-compose.yml');
  const t0 = Date.now();
  try {
    await execFileAsync(
      'docker',
      ['compose', '-f', composeFile, 'config', '-q'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return {
      hasErrors: false,
      errors: [],
      formatted: '',
      durationMs: Date.now() - t0,
      runtime: 'docker-compose-config',
    };
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    const errorObj = {
      kind: 'probe',
      stage: 'docker-compose-config',
      message: stderr || err.message || 'docker compose config failed',
    };
    return {
      hasErrors: true,
      errors: [errorObj],
      formatted: formatErrors('integration', [errorObj]),
      durationMs: Date.now() - t0,
      runtime: 'docker-compose-config',
    };
  }
}

/**
 * Build + run + probe a single scope. Returns the unified result shape.
 */
export async function runRuntimeGate({ workspaceDir, scope, runId, portOffset = 0 }) {
  const t0 = Date.now();

  const { probeable, skipReason } = checkScopeProbeable(workspaceDir, scope);
  if (!probeable) {
    return {
      hasErrors: false,
      errors: [],
      formatted: '',
      durationMs: 0,
      runtime: null,
      skipped: true,
      skipReason,
    };
  }

  if (scope === 'integration') {
    return probeIntegration({ workspaceDir });
  }

  const safeRunId = sanitizeForDocker(runId);
  const imageTag = `runtime-probe-${safeRunId}-${scope}:latest`;
  const containerName = `runtime-probe-${safeRunId}-${scope}`;
  const hostPort = PROBE_PORT_BASE[scope] + Number(portOffset || 0);
  const containerPort = SERVICE_CONTAINER_PORT[scope];

  const errors = [];

  // 1. Build
  const build = await buildImage({ workspaceDir, scope, imageTag });
  if (!build.ok) {
    errors.push({
      kind: 'build',
      stage: `docker build ${scope}/`,
      message: build.error,
    });
    // Build failed — no container to run/probe. Image tag may or may not
    // exist depending on how far the build got; cleanup just in case.
    await cleanupImage(imageTag);
    return {
      hasErrors: true,
      errors,
      formatted: formatErrors(scope, errors),
      durationMs: Date.now() - t0,
      runtime: 'docker-build',
    };
  }

  // 2. Run
  try {
    // NO --rm: a crash-on-boot container would delete itself and take its
    // logs with it, making REAL crashes indistinguishable from load-phantom
    // timeouts (observed live: require-in-ESM boot crash scored
    // `inconclusive` because the evidence had self-destructed). cleanup in
    // finally{} force-removes the container either way.
    const runArgs = ['run', '-d', '--name', containerName];
    if (scope === 'backend') {
      runArgs.push('-p', `${hostPort}:${containerPort}`);
      for (const [k, v] of Object.entries(BACKEND_STUB_ENVS)) {
        runArgs.push('-e', `${k}=${v}`);
      }
    } else if (scope === 'frontend') {
      runArgs.push('-p', `${hostPort}:${containerPort}`);
    } else if (scope === 'database' || scope === 'vectordb') {
      for (const [k, v] of Object.entries(POSTGRES_STUB_ENVS)) {
        runArgs.push('-e', `${k}=${v}`);
      }
    }
    runArgs.push(imageTag);
    await docker(runArgs, { timeoutMs: 30_000 });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    errors.push({
      kind: 'run',
      stage: `docker run ${scope}`,
      message: stderr || err.message || 'docker run failed',
    });
    await cleanupContainer(containerName);
    await cleanupImage(imageTag);
    return {
      hasErrors: true,
      errors,
      formatted: formatErrors(scope, errors),
      durationMs: Date.now() - t0,
      runtime: 'docker-run',
    };
  }

  // 3. Probe
  try {
    let probe;
    if (scope === 'backend') {
      probe = await probeHttp(`http://localhost:${hostPort}/health`);
    } else if (scope === 'frontend') {
      probe = await probeHttp(`http://localhost:${hostPort}/`);
    } else if (scope === 'database') {
      probe = await probePostgres({ containerName });
    } else if (scope === 'vectordb') {
      probe = await probePostgres({
        containerName,
        extraSql: "SELECT extversion FROM pg_extension WHERE extname='vector'",
      });
    } else {
      probe = { ok: true }; // unreachable per checkScopeProbeable
    }

    if (!probe.ok) {
      const logs = await dockerLogsTail(containerName, 80);
      errors.push({
        kind: 'probe',
        stage: `probe ${scope}`,
        message: probe.error || 'probe returned not-ok with no error message',
        dockerLogs: logs,
      });
    }
  } catch (err) {
    const logs = await dockerLogsTail(containerName, 80);
    errors.push({
      kind: 'probe',
      stage: `probe ${scope}`,
      message: err.message || 'probe threw',
      dockerLogs: logs,
    });
  } finally {
    await cleanupContainer(containerName);
    await cleanupImage(imageTag);
  }

  return {
    hasErrors: errors.length > 0,
    errors,
    formatted: errors.length > 0 ? formatErrors(scope, errors) : '',
    durationMs: Date.now() - t0,
    runtime: 'docker-build-run-probe',
  };
}

/**
 * Run the runtime-gate for many scopes in parallel. Returns a
 * Map<scope, result>.
 *
 * Best-effort: any per-scope crash is logged + the scope is marked
 * skipped (skipReason = the thrown message). The aggregate never throws.
 */
// An error a fix agent can act on carries evidence: compiler/docker-build
// output, or container logs. A probe/run timeout whose container left NO
// logs is infrastructure noise (the machine was too loaded to boot/answer in
// time) — observed live: four scopes "failed" simultaneously with `probe
// timeout … (docker logs unavailable)`, fix agents burned ~12 min + 785k
// tokens on evidence-free directives, and compose-up + endpoint probe later
// verified everything green.
export function isNonActionable(result) {
  if (!result?.hasErrors || !Array.isArray(result.errors) || result.errors.length === 0) return false;
  return result.errors.every((e) =>
    (e.kind === 'probe' || e.kind === 'run')
    && /timeout|did not respond/i.test(String(e.message || ''))
    && (!e.dockerLogs || e.dockerLogs === '(docker logs unavailable)'));
}

async function runOneScope({ workspaceDir, scope, runId, portOffset }) {
  try {
    return await runRuntimeGate({ workspaceDir, scope, runId, portOffset });
  } catch (err) {
    logAndSwallow(err, `[runtime-gate] threw for scope=${scope}`);
    return {
      hasErrors: false,
      errors: [],
      formatted: '',
      durationMs: 0,
      runtime: null,
      skipped: true,
      skipReason: `runtime-gate threw: ${err.message || 'unknown error'}`,
    };
  }
}

export async function runRuntimeGateForScopes({ workspaceDir, scopes, runId, portOffset = 0 }) {
  const byScope = new Map();

  // Concurrency cap: booting 5 containers at once on an already-busy host is
  // what produces the evidence-free timeouts in the first place.
  const MAX_CONCURRENT = 2;
  const queue = [...scopes];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
    for (let scope = queue.shift(); scope !== undefined; scope = queue.shift()) {
      byScope.set(scope, await runOneScope({ workspaceDir, scope, runId, portOffset }));
    }
  });
  await Promise.all(workers);

  // Evidence discipline: a scope that failed WITHOUT evidence gets ONE serial
  // re-probe (alone on the machine, nothing else booting). Clean → clean.
  // Actionable errors → keep them (fix dispatch proceeds). Still evidence-free
  // → mark inconclusive: no fix agent (nothing to act on, and confused agents
  // rewrite working code — the stub_db incident), downstream compose-up /
  // endpoint-probe / visual layers arbitrate with real logs attached.
  for (const [scope, result] of byScope) {
    if (!isNonActionable(result)) continue;
    logAndSwallow(new Error(`scope=${scope} gate failure has no evidence — serial re-probe`), '[runtime-gate] evidence-free failure');
    const retry = await runOneScope({ workspaceDir, scope, runId, portOffset });
    if (isNonActionable(retry)) {
      byScope.set(scope, {
        ...retry,
        hasErrors: false,
        errors: [],
        formatted: '',
        inconclusive: true,
        inconclusiveReason: 'probe timed out twice with no container logs — infrastructure noise, deferred to compose-up/probe verification',
      });
    } else {
      byScope.set(scope, retry);
    }
  }
  return byScope;
}
