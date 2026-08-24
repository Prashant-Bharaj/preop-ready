/**
 * `read_container_logs` tool — read-only log fetch for the investigator agent
 * (W3.LOGS — HARNESS_EVOLUTION.md §B + §N).
 *
 * Surface (XML params parsed by the agent loop):
 *
 *   <read_container_logs>
 *     <service>backend</service>
 *     <tail>100</tail>          (optional, default 100)
 *     <since>5m</since>          (optional — docker-compose `--since` arg)
 *     <until>1m</until>          (optional — docker-compose `--until` arg)
 *     <scope>backend</scope>     (optional — telemetry hint, NOT behaviour)
 *   </read_container_logs>
 *
 * Returns (JSON-serialized string for the model):
 *
 *   Happy path:
 *     {
 *       status: 'ok',
 *       service: '<service>',
 *       logs: '<post-stripAnsi text>',
 *       returnedBytes: <int>,
 *       truncated: <bool>,
 *       totalBytesEstimate?: <int>   // only when truncated
 *     }
 *
 *   Container never started / docker compose can't resolve the service:
 *     {
 *       status: 'no_container',
 *       service: '<service>',
 *       stderr: '<docker error string>'
 *     }
 *
 *   Timeout (docker compose blew past COMPOSE_LOGS_MS):
 *     { status: 'timeout', service, stderr }
 *
 *   Anything else:
 *     { status: 'error', service, stderr }
 *
 * The investigator needs the structured `no_container` case (NOT empty string)
 * to distinguish "container ran but logged nothing" from "container never
 * started"; the orchestrator brief from W3.LOGS makes this an explicit
 * requirement.
 *
 * Output cap: post-stripAnsi payload is truncated at MAX_LOG_FETCH_BYTES
 * (defaults.js — 50 KB). Truncation is HEAD-side (drop the oldest bytes),
 * so the investigator always sees the most-recent lines — which is also
 * what `docker compose logs --tail=N` already biases toward.
 *
 * Failure policy: read-only. checkPermissions always allows (similar to
 * read_file). Phase-whitelist gating (who can call it) is the investigator
 * agent's PHASES whitelist, wired separately by W3.INVEST.
 */
import { runCompose } from '../../session/docker-orchestration.js';
import { stripAnsi } from '../../util/redact.js';
import { tlog } from '../../util/timestamped-log.js';
import { COMPOSE_LOGS_MS, MAX_LOG_FETCH_BYTES } from '../../config/defaults.js';
import { makeToolEventPayload } from './core.js';

const DEFAULT_TAIL = 100;

// Service name validation — keep it strict so we don't smuggle shell
// metacharacters into the compose invocation. Docker-compose service names
// are lower-kebab-case identifiers (alphanumerics + dashes/underscores).
const SERVICE_RE = /^[a-zA-Z0-9_-]+$/;
// `--since` / `--until` accept docker's relative-duration or RFC3339 forms
// (e.g. "5m", "1h30m", "2026-05-16T19:30:00Z"). Accept the safe character
// set; reject anything that could break out of the argument.
const TIME_ARG_RE = /^[a-zA-Z0-9:.+\-]+$/;

function classifyError(stderr) {
  // `docker compose logs <service>` against a service that isn't in the
  // compose file emits "no such service: <name>" (compose v2) or
  // "ERROR: No such service: <name>" (v1). Against a defined service whose
  // container hasn't been created yet, it emits "No containers to log" or
  // similar. Both map to `no_container` — the investigator cares about the
  // semantic ("we have nothing to show") not the precise docker phrasing.
  if (/no such service|no containers? to log|service .* is not running|error response from daemon: no such container/i.test(stderr)) {
    return 'no_container';
  }
  if (/timeout|timed out|etimedout/i.test(stderr)) return 'timeout';
  return 'error';
}

export async function toolReadContainerLogs(params, { emit } = {}) {
  const service = (params.service || '').trim();
  if (!service) {
    return JSON.stringify({
      status: 'error',
      service: '',
      stderr: 'read_container_logs: <service> param is required',
    }, null, 2);
  }
  if (!SERVICE_RE.test(service)) {
    return JSON.stringify({
      status: 'error',
      service,
      stderr: `read_container_logs: invalid service name "${service}" — expected [a-zA-Z0-9_-]+`,
    }, null, 2);
  }

  // tail: default 100. Accept either a number or a numeric string.
  let tail = DEFAULT_TAIL;
  if (params.tail != null && params.tail !== '') {
    const n = parseInt(params.tail, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return JSON.stringify({
        status: 'error',
        service,
        stderr: `read_container_logs: invalid tail "${params.tail}" — expected positive integer`,
      }, null, 2);
    }
    tail = n;
  }

  const since = params.since ? String(params.since).trim() : null;
  const until = params.until ? String(params.until).trim() : null;
  if (since && !TIME_ARG_RE.test(since)) {
    return JSON.stringify({
      status: 'error',
      service,
      stderr: `read_container_logs: invalid since "${since}" — expected docker duration / RFC3339`,
    }, null, 2);
  }
  if (until && !TIME_ARG_RE.test(until)) {
    return JSON.stringify({
      status: 'error',
      service,
      stderr: `read_container_logs: invalid until "${until}" — expected docker duration / RFC3339`,
    }, null, 2);
  }

  // Telemetry hint — recorded in our console.log, never affects behaviour.
  const scopeHint = params.scope ? String(params.scope) : null;

  // Build the compose invocation. `--no-color` reduces but does not eliminate
  // ANSI; stripAnsi on the captured stdout is still required.
  const args = [`logs ${service} --tail=${tail} --no-color`];
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  const cmd = args.join(' ');

  const result = runCompose(cmd, { captureStdout: true, timeout: COMPOSE_LOGS_MS });

  // Non-ok return from runCompose: the docker invocation itself failed.
  // Classify into `no_container` (the expected "service never ran" case the
  // investigator needs to distinguish) vs `timeout` vs generic `error`.
  if (!result.ok) {
    const stderr = result.stderr || 'docker compose logs failed without stderr';
    const status = classifyError(stderr);
    tlog('[read-container-logs] service=%s tail=%d status=%s scope=%s stderrLen=%d',
      service, tail, status, scopeHint || '-', stderr.length);
    if (typeof emit === 'function') {
      emit(makeToolEventPayload('readContainerLogs', {
        service,
        tail,
        status,
        scope: scopeHint,
      }));
    }
    return JSON.stringify({
      status,
      service,
      stderr,
    }, null, 2);
  }

  // ok + stdout in hand. Strip ANSI, then cap at MAX_LOG_FETCH_BYTES (head-
  // truncate so the most recent lines survive).
  const rawStdout = result.stdout || '';
  const cleaned = stripAnsi(rawStdout);
  const cleanedBytes = Buffer.byteLength(cleaned, 'utf8');

  let payload = cleaned;
  let truncated = false;
  let totalBytesEstimate;
  if (cleanedBytes > MAX_LOG_FETCH_BYTES) {
    // Head-truncate: keep the LAST MAX_LOG_FETCH_BYTES of the byte stream.
    // We slice on the Buffer then decode back to UTF-8; if we cut mid-codepoint
    // Node's lossy decode just drops the broken byte — acceptable for log text.
    const buf = Buffer.from(cleaned, 'utf8');
    payload = buf.subarray(buf.length - MAX_LOG_FETCH_BYTES).toString('utf8');
    // Drop any partial leading line (everything up to the first newline) so
    // the investigator never sees a mid-line fragment as the first entry.
    const firstNewline = payload.indexOf('\n');
    if (firstNewline > 0 && firstNewline < payload.length - 1) {
      payload = payload.slice(firstNewline + 1);
    }
    truncated = true;
    totalBytesEstimate = cleanedBytes;
  }

  const returnedBytes = Buffer.byteLength(payload, 'utf8');

  tlog('[read-container-logs] service=%s tail=%d returnedBytes=%d truncated=%s status=ok scope=%s',
    service, tail, returnedBytes, truncated, scopeHint || '-');

  if (typeof emit === 'function') {
    emit(makeToolEventPayload('readContainerLogs', {
      service,
      tail,
      status: 'ok',
      returnedBytes,
      truncated,
      scope: scopeHint,
    }));
  }

  const out = {
    status: 'ok',
    service,
    logs: payload,
    returnedBytes,
    truncated,
  };
  if (truncated) out.totalBytesEstimate = totalBytesEstimate;
  return JSON.stringify(out, null, 2);
}

/**
 * Read-only tool: always allow. Phase-whitelisting (i.e. only the
 * investigator agent can call this in its PHASES allowlist) is W3.INVEST's
 * job; checkPermissions is the per-call hard gate and there's no per-call
 * reason to deny a log read.
 */
toolReadContainerLogs.checkPermissions = function () {
  return { verdict: 'allow', reason: 'read-only' };
};
