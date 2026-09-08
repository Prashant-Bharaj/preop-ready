/**
 * endpoint-probe.js — post-compose runtime verification of the apiContract.
 *
 * After `compose up`, every contracted endpoint gets one real HTTP request
 * through the frontend nginx proxy (the path real traffic takes — a crashed
 * backend shows up as the same 502 the user would see). Sample payloads are
 * derived from the contract's request field types.
 *
 * Pass/fail semantics are deliberately app-type-agnostic:
 *   fail — connection errors and any 5xx (handler crashed / container dead /
 *          env missing). These are never legitimate for a fresh build.
 *   pass — 2xx/3xx and all 4xx (401/403 = auth middleware working; 404 on a
 *          parameterized GET = handler exists, row doesn't; 400/422 = the
 *          sample payload was rejected by validation, which still proves the
 *          handler ran without crashing).
 *   fail (reference-data) — the one 404 that is never legitimate: a mutation
 *          (POST/PUT/PATCH) on a `:id` route whose collection the contract
 *          never creates (`POST /lines/:id/status`, no `POST /lines`) and
 *          whose collection GET returned no ids. The table is empty and the
 *          API offers no way to fill it — every real user hits the same 404.
 *          Only prefixes the caller names in `referencePrefixes` (the tables
 *          the reference-data generator seeds) are held to this.
 *
 * Pure functions except probeApiEndpoints (network via injectable fetchImpl)
 * and checkComposeHealthAfterProbe (docker via injectable runComposeImpl).
 */

import {
  ENDPOINT_PROBE_REQUEST_MS,
  ENDPOINT_PROBE_AI_REQUEST_MS,
  ENDPOINT_PROBE_TOTAL_MS,
} from '../config/defaults.js';

// Endpoints likely to do an LLM round-trip get the long timeout.
const AI_PATH_RE = /(chat|ask|generate|summar|analy|recommend|suggest|embed|assist|ai)/i;

const METHOD_RANK = { POST: 0, GET: 1, PUT: 2, PATCH: 2, DELETE: 3 };
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
// Non-global twin for boolean tests: a /g regex's `.test()` resumes from
// `lastIndex`, so two consecutive parameterized paths made the second one
// read as parameter-free.
const PARAM_TEST_RE = new RegExp(PARAM_RE.source);

// Stub ALB identity header — a base64url JWT-shaped payload so identity
// middleware has something to parse. Apps that verify the signature will
// 401, which counts as pass (the handler ran).
const STUB_OIDC_HEADER = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'endpoint-probe', email: 'probe@example.com', name: 'Endpoint Probe' })).toString('base64url'),
  '',
].join('.');

/**
 * Order the contract's endpoints for probing: POST first (creates rows and
 * captures ids), then GETs (collection before :id), then PUT/PATCH, DELETE
 * last. Within a rank, non-parameterized before parameterized, shorter
 * paths first. A parameterized POST (`POST /lines/:id/status`) mutates an
 * existing row rather than creating one, so it ranks with PUT/PATCH — after
 * the collection GET that supplies a real id.
 *
 * @param {object} apiContract - { endpoints: [{ method, path, request?, response? }] }
 * @param {(step) => boolean} [filter] - optional subset (re-probe failed only)
 */
export function buildProbePlan(apiContract, filter = null) {
  const endpoints = Array.isArray(apiContract?.endpoints) ? apiContract.endpoints : [];
  const steps = endpoints
    .filter((e) => e && typeof e.method === 'string' && typeof e.path === 'string')
    .map((e) => ({
      method: e.method.toUpperCase(),
      path: e.path,
      request: e.request || null,
      hasParams: PARAM_TEST_RE.test(e.path),
    }))
    .filter((s) => METHOD_RANK[s.method] !== undefined)
    .filter((s) => (filter ? filter(s) : true));
  const rank = (s) => (s.method === 'POST' && s.hasParams ? METHOD_RANK.PUT : METHOD_RANK[s.method]);
  steps.sort((a, b) =>
    (rank(a) - rank(b))
    || (Number(a.hasParams) - Number(b.hasParams))
    || (a.path.length - b.path.length));
  return steps;
}

/**
 * Minimal valid body from a contract request spec. Field shapes tolerated:
 * `"string"`, `"string required"` / `"string optional"`, and
 * `{ type, optional }`. Optional fields are omitted (probes the
 * required-field happy path). Strings are field-name-aware so common
 * validators (email/url/date) accept them.
 */
/**
 * Mirror of contract-canonicalizer's flat-spec explosion, for envelopes
 * written before it existed ({ content_type, fields: "a number required,
 * b string optional" } → per-field entries, meta-keys dropped).
 */
function explodeFlatSpec(requestSpec) {
  const out = {};
  for (const [name, spec] of Object.entries(requestSpec)) {
    if (/^content[_-]?type$/i.test(name)) continue;
    if (typeof spec === 'string' && spec.includes(',')) {
      const clauses = spec.split(',').map((s) => s.trim()).filter(Boolean);
      const parsed = clauses.map((cl) => /^([A-Za-z_][A-Za-z0-9_]*)\s+((?:string|number|int|integer|float|bool|boolean|file|date|datetime|text|json|array|object)\b.*)$/i.exec(cl));
      if (clauses.length > 1 && parsed.every(Boolean)) {
        for (const m of parsed) out[m[1]] = m[2];
        continue;
      }
    }
    out[name] = spec;
  }
  return out;
}

export function deriveSamplePayload(requestSpec) {
  if (!requestSpec || typeof requestSpec !== 'object' || Array.isArray(requestSpec)) return {};
  const body = {};
  for (const [name, spec] of Object.entries(explodeFlatSpec(requestSpec))) {
    let type = 'string';
    let optional = false;
    if (typeof spec === 'string') {
      const tokens = spec.trim().split(/\s+/);
      type = (tokens[0] || 'string').toLowerCase();
      optional = tokens.includes('optional');
    } else if (spec && typeof spec === 'object') {
      type = String(spec.type || 'string').toLowerCase();
      optional = spec.optional === true || /optional/i.test(String(spec.required ?? ''));
    }
    if (optional) continue;
    // Bare string-spec *_id fields (no explicit required) are FK references —
    // a guessed id into an empty table fails FK validation. Contracts written
    // after the canonicalizer carry explicit markers; this covers older
    // envelopes. Object-dialect specs are already explicit via `optional`.
    if (typeof spec === 'string' && /_id$/.test(name) && !/required/i.test(spec)) continue;
    body[name] = sampleValue(name, type);
  }
  return body;
}

function sampleValue(name, type) {
  if (/^(int|integer|number|float|double|decimal)/.test(type)) return 1;
  if (/^bool/.test(type)) return true;
  if (/^(array|\[)/.test(type)) return [];
  if (/^(object|json|record|\{)/.test(type)) return {};
  const n = name.toLowerCase();
  if (n.includes('email')) return 'probe@example.com';
  if (n.includes('url') || n.includes('link')) return 'https://example.com';
  if (n.includes('date') || n.endsWith('_at') || n.endsWith('at')) return '2026-01-01';
  if (n === 'id' || n.endsWith('_id') || n.endsWith('id')) return '1';
  return 'probe-sample';
}

/** @returns {'pass'|'fail'} per the module-header semantics. */
export function classifyProbeOutcome({ status, error }) {
  if (error) return 'fail';
  if (typeof status === 'number' && status >= 500) return 'fail';
  return 'pass';
}

/**
 * Probe every step sequentially (POST-first ordering lets :id substitution
 * use freshly created row ids). One retry after 2s on connection errors —
 * containers may still be warming.
 *
 * @param {object} opts
 * @param {string}   opts.baseUrl  - frontend origin, e.g. http://localhost:8080
 * @param {object}   opts.apiContract
 * @param {boolean}  [opts.isAiApp] - stretch POST timeouts (MGA round-trips run 10-30s)
 * @param {function} [opts.fetchImpl] - injectable for tests
 * @param {function} [opts.filter] - probe a subset (re-probe failed only)
 * @param {object}   [opts.timeouts] - { requestMs, aiRequestMs, totalMs } overrides
 * @param {string[]} [opts.referencePrefixes] - collection prefixes ('/lines') of
 *   tables the API never creates; a mutation 404 on a guessed id there fails
 * @returns {Promise<{ probed, passed, failed: Array<{method, path, status, error, bodySnippet, responseMs}>, skipped: string[], durationMs }>}
 */
export async function probeApiEndpoints({
  baseUrl,
  apiContract,
  isAiApp = false,
  fetchImpl = fetch,
  filter = null,
  timeouts = {},
  referencePrefixes = [],
} = {}) {
  const requestMs = timeouts.requestMs ?? ENDPOINT_PROBE_REQUEST_MS;
  const aiRequestMs = timeouts.aiRequestMs ?? ENDPOINT_PROBE_AI_REQUEST_MS;
  const totalMs = timeouts.totalMs ?? ENDPOINT_PROBE_TOTAL_MS;

  const plan = buildProbePlan(apiContract, filter);
  const started = Date.now();
  const failed = [];
  const skipped = [];
  let passed = 0;
  const idByPrefix = new Map();
  const createdByPost = new Set();
  const referenceSet = new Set(referencePrefixes);

  for (const step of plan) {
    if (Date.now() - started > totalMs) {
      skipped.push(`${step.method} ${step.path}`);
      continue;
    }
    const prefix = collectionPrefix(step.path);
    const guessedId = step.hasParams && !idByPrefix.has(prefix);
    const concretePath = substituteParams(step.path, idByPrefix);
    const url = joinUrl(baseUrl, concretePath);
    const isAiStep = AI_PATH_RE.test(step.path) || (isAiApp && step.method === 'POST');
    const timeoutMs = isAiStep ? aiRequestMs : requestMs;
    const init = {
      method: step.method,
      headers: {
        'Content-Type': 'application/json',
        'x-amzn-oidc-data': STUB_OIDC_HEADER,
      },
    };
    if (step.method !== 'GET' && step.method !== 'DELETE') {
      init.body = JSON.stringify(deriveSamplePayload(step.request));
    }

    let outcome = await requestOnce(fetchImpl, url, init, timeoutMs);
    if (outcome.error) {
      // One retry for ANY transport-level failure — connection refused OR
      // timeout. Timeouts were previously excluded, so one transient slow
      // MGA round-trip on an AI endpoint went straight to a fix dispatch
      // (~8 min of agent time for a failure that had already healed).
      await sleep(2000);
      outcome = await requestOnce(fetchImpl, url, init, timeoutMs);
    }

    if (classifyProbeOutcome(outcome) === 'pass') {
      // Reference-data: see module header. The id was a guess because
      // neither a POST nor the collection GET produced one — the table is
      // empty and nothing in the API can fill it.
      if (guessedId && outcome.status === 404 && MUTATION_METHODS.has(step.method) && referenceSet.has(prefix)) {
        failed.push({
          method: step.method,
          path: step.path,
          status: outcome.status,
          error: `reference-data: ${prefix} has no rows (GET ${prefix} returned no ids) and the contract has no route that creates them, so this ${step.method} can never succeed — seed starter rows`,
          bodySnippet: (outcome.bodyText || '').slice(0, 300),
          responseMs: outcome.responseMs,
        });
        continue;
      }
      // Persistence round-trip: a collection GET that follows a successful
      // POST on the same path must contain the created row. HTTP 200 with
      // the row missing means the write never landed (observed live: AI
      // analyses returned 201 but the history list stayed empty — every
      // gate green, app broken for the user). Only plain collection GETs
      // are checked; :id paths already prove existence by returning 200.
      const createdId = step.method === 'GET' && !step.hasParams && createdByPost.has(prefix)
        ? idByPrefix.get(prefix) : undefined;
      if (createdId !== undefined && outcome.status === 200 && !bodyContainsId(outcome.bodyJson, createdId)) {
        failed.push({
          method: step.method,
          path: step.path,
          status: outcome.status,
          error: `persistence: created id ${createdId} missing from collection response — the matching POST returned it but this GET does not include it`,
          bodySnippet: (outcome.bodyText || '').slice(0, 300),
          responseMs: outcome.responseMs,
        });
        continue;
      }
      passed++;
      if (step.method === 'POST' && !step.hasParams && outcome.status >= 200 && outcome.status < 300 && outcome.bodyJson) {
        // Only a collection POST creates a row of ITS collection — a nested
        // POST (/projects/:id/tasks) returns the child's id, which must not
        // overwrite the parent's.
        const id = extractId(outcome.bodyJson);
        if (id !== null) { idByPrefix.set(prefix, String(id)); createdByPost.add(prefix); }
      } else if (step.method === 'GET' && !step.hasParams && outcome.status === 200 && !idByPrefix.has(prefix)) {
        // A collection GET is the only id source for tables the API never
        // creates (seeded reference tables) — take the first row's id so the
        // :id routes that follow hit a real row instead of the guess '1'.
        const id = extractFirstId(outcome.bodyJson);
        if (id !== null) idByPrefix.set(prefix, String(id));
      }
    } else {
      failed.push({
        method: step.method,
        path: step.path,
        status: outcome.status ?? null,
        error: outcome.error ?? null,
        bodySnippet: (outcome.bodyText || '').slice(0, 300),
        responseMs: outcome.responseMs,
      });
    }
  }

  return { probed: plan.length - skipped.length, passed, failed, skipped, durationMs: Date.now() - started };
}

async function requestOnce(fetchImpl, url, init, timeoutMs) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const bodyText = await res.text().catch(() => '');
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch { /* non-JSON body */ }
    return { status: res.status, bodyText, bodyJson, responseMs: Date.now() - t0 };
  } catch (err) {
    const message = err?.cause?.code || err?.code || (err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message || err));
    return { error: message, connectionError: err?.name !== 'AbortError', responseMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function substituteParams(p, idByPrefix) {
  return p.replace(PARAM_RE, () => idByPrefix.get(collectionPrefix(p)) ?? '1');
}

function collectionPrefix(p) {
  const paramIdx = p.search(PARAM_RE);
  const head = paramIdx === -1 ? p : p.slice(0, paramIdx);
  return head.replace(/\/+$/, '');
}

/** True when any object in the (arbitrarily nested) body has id == wanted. */
export function bodyContainsId(body, wanted) {
  if (body == null) return false;
  if (Array.isArray(body)) return body.some((v) => bodyContainsId(v, wanted));
  if (typeof body !== 'object') return false;
  if (body.id !== undefined && String(body.id) === String(wanted)) return true;
  return Object.values(body).some((v) => v && typeof v === 'object' && bodyContainsId(v, wanted));
}

function extractId(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.id !== undefined) return body.id;
  if (body.data && typeof body.data === 'object' && body.data.id !== undefined) return body.data.id;
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.id !== undefined) return v.id;
  }
  return null;
}

/** First id found in a collection body: `[{id}]`, `{ data: [{id}] }`, `{ items: [...] }`. */
export function extractFirstId(body) {
  if (body == null || typeof body !== 'object') return null;
  if (Array.isArray(body)) {
    for (const v of body) { const id = extractFirstId(v); if (id !== null) return id; }
    return null;
  }
  if (body.id !== undefined && body.id !== null) return body.id;
  for (const v of Object.values(body)) {
    if (v && typeof v === 'object') { const id = extractFirstId(v); if (id !== null) return id; }
  }
  return null;
}

function joinUrl(baseUrl, apiPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return `${base}/api${p}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Post-probe container health: an unhandled rejection between probes can
 * kill a container even when later probes weren't reached. Parses
 * `compose ps` (v2 JSON-lines format, plain-text fallback).
 *
 * @param {function} runComposeImpl - (cmd, opts) => { ok, stdout }
 * @returns {{ crashed: Array<{ service, state }> }}
 */
export function checkComposeHealthAfterProbe(runComposeImpl) {
  const crashed = [];
  try {
    const res = runComposeImpl('ps --all --format json', { captureStdout: true });
    if (res?.ok && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const svc = JSON.parse(trimmed);
          const state = String(svc.State || svc.status || '').toLowerCase();
          if (state && state !== 'running') {
            crashed.push({ service: svc.Service || svc.Name || 'unknown', state });
          }
        } catch { /* non-JSON line */ }
      }
    }
  } catch { /* compose unavailable — nothing to report */ }
  return { crashed };
}

/**
 * Render probe failures as a fix-directive block (consumed verbatim by
 * buildFixDirective's endpoint-probe fast-path). Byte-capped.
 */
export function formatProbeFailures(failures, { logsTail = '', crashed = [], maxBytes = 6000 } = {}) {
  const lines = [
    `${failures.length} contracted endpoint(s) failed live probing after compose up:`,
    '',
  ];
  for (const f of failures) {
    const why = f.status !== null && f.status !== undefined ? `HTTP ${f.status}` : f.error;
    lines.push(`  ${f.method} ${f.path} — ${why}${f.bodySnippet ? ` — ${f.bodySnippet.slice(0, 160)}` : ''}`);
  }
  if (crashed.length) {
    lines.push('');
    lines.push(`Container(s) not running after the probe pass: ${crashed.map((c) => `${c.service} (${c.state})`).join(', ')}.`);
  }
  lines.push('');
  lines.push('These requests went through the frontend proxy exactly like real traffic.');
  lines.push('A 5xx or connection failure on a fresh build means the handler crashed, an env var is missing, or the process died — fix the root cause; do not change the contract.');
  if (failures.some((f) => String(f.error || '').startsWith('reference-data:'))) {
    lines.push('');
    lines.push('A reference-data failure means the table behind that route is empty and the API has no route to create rows in it. Seed 3 placeholder rows with a guarded block (`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM <table>) THEN INSERT INTO <table> (...) VALUES (...); END IF; END $$;`): in `database/init/02_reference_data.sql` when the table was created this build (the harness re-applies that file to the running database), or in the next `backend/migrations/NNN_*.sql` when the table came from a migration (init never re-runs on an initialized volume). Placeholder values only — never real data. Do not change the contract.');
  }
  if (logsTail) {
    lines.push('');
    lines.push('Backend container log tail:');
    lines.push('```');
    lines.push(logsTail);
    lines.push('```');
  }
  let out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf-8') > maxBytes) {
    out = out.slice(0, maxBytes) + '\n…(truncated)';
  }
  return out;
}
