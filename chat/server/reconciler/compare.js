/**
 * Cross-scope comparator.
 *
 * Inputs: structured data from the three extractors + the router's
 * contracts (apiContract, dataModel, uiContract). Output: a list of
 * mismatches (with severity) plus a list of extras the LLM-judge will
 * categorize.
 *
 * Three deterministic checks:
 *   1. Backend <-> Frontend routes (path/method/body).
 *   2. Backend <-> DB column references.
 *   3. Coverage check — contract endpoints/components missing from extracted output.
 *
 * No LLM. No file reads. All inputs are pre-extracted JSON.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pushReconcilerVerdict, flushReconcilerVerdicts } from '../util/telemetry-verdicts.js';

// ── Path normalization (so :id and {id} compare equal across stacks) ──

function normalizeRoutePath(p) {
  if (!p) return '';
  // FastAPI {name} → :p
  let out = p.replace(/\{[^}]+\}/g, ':p');
  // Express :name → :p (also covers our frontend :param normalization)
  out = out.replace(/:[A-Za-z_][\w]*/g, ':p');
  // Strip trailing slash for comparison.
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function keyOf(method, p) {
  return `${method.toUpperCase()} ${normalizeRoutePath(p)}`;
}

// ── Empty-scope detection ─────────────────────────────────────────────
//
// Catches the failure mode where a phase agent emitted attempt_completion
// without writing any files (anti-fabrication trip, false refusal, etc.) and
// the orchestrator nonetheless reported `Status: built`.
//
// We read docker-compose.yml's `services.<name>.build.context: ./<scope>`
// blocks and check that each referenced Dockerfile exists. Missing → hard
// mismatch (compose build will fail anyway; surfacing it as a clear pre-build
// diagnostic is better UX than the eventual "lstat ... no such file" error).

function detectEmptyScopes(workspaceDir) {
  const composePath = path.join(workspaceDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) return [];
  let compose;
  try {
    compose = fs.readFileSync(composePath, 'utf-8');
  } catch {
    return [];
  }

  const out = [];
  // Loose YAML scan — match `<svc>:\n ... build:\n ... context: ./<dir>\n
  // [optional dockerfile: <name>]`. We don't require strict indentation
  // because compose files vary; we just need the (svc, context, dockerfile)
  // triple. Stop the inner scan at the next top-level key (a non-indented
  // alphanumeric line followed by ":").
  const lines = compose.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const svcMatch = lines[i].match(/^  ([A-Za-z_][\w-]*):\s*$/);
    if (!svcMatch) continue;
    const svc = svcMatch[1];
    let context = null;
    let dockerfile = 'Dockerfile';
    for (let j = i + 1; j < lines.length; j++) {
      // End of this service block: either next top-level service or end-of-file.
      if (/^  [A-Za-z_][\w-]*:\s*$/.test(lines[j])) break;
      if (/^[A-Za-z_]/.test(lines[j])) break;
      const cm = lines[j].match(/^\s*context:\s*(\S+)/);
      if (cm) context = cm[1].replace(/^\.\//, '').replace(/^["']|["']$/g, '');
      const dm = lines[j].match(/^\s*dockerfile:\s*(\S+)/);
      if (dm) dockerfile = dm[1].replace(/^["']|["']$/g, '');
    }
    if (!context) continue;
    const dockerfileAbs = path.join(workspaceDir, context, dockerfile);
    if (!fs.existsSync(dockerfileAbs)) {
      out.push({
        scope: context, // ./backend → backend
        service: svc,
        expectedDockerfile: path.join(context, dockerfile),
      });
    }
  }
  return out;
}

// ── Comparator ────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {string} [input.workspaceDir] — for backend column-ref scan; if absent, that check is skipped.
 *   Also used as the destination for W3.TEL's reconciler-verdicts.jsonl
 *   (one line per matched contract item) when `emitOkVerdicts` is true.
 * @param {Array} input.extractedBackend — extractBackendRoutes output
 * @param {?Array} input.extractedBackendRuntime — extractRuntimeRoutes output
 *   (the live router table), or null when introspection was unavailable. When
 *   present it is authoritative for route existence; a missing contract
 *   endpoint is only HARD when this confirms its absence.
 * @param {Array} input.extractedFrontend — extractFrontendFetches output
 * @param {Array} input.extractedDb — extractDbSchema output
 * @param {object} input.routerContracts — { apiContract, dataModel, uiContract, businessLogicContract }
 * @param {boolean} [input.emitOkVerdicts=true] — when true (and workspaceDir
 *   is set), append one `verdict='ok'` line per matched contract item to
 *   `<workspaceDir>/.harness/reconciler-verdicts.jsonl`. Section M item 4
 *   (W3.TEL) — the comparator's "matched-without-judge" path. Defaults to
 *   true so the production caller picks it up automatically; tests opt out by
 *   passing false.
 * @param {(record: object) => void} [input.onVerdict] — optional in-process
 *   sink invoked once per emitted ok-verdict (same record as the jsonl line).
 *   Used by the session-level aggregator to mirror counts without re-parsing.
 * @returns {{ mismatches: Array, extras: Array }}
 */
export function compareScopes({
  workspaceDir = null,
  extractedBackend = [],
  extractedFrontend = [],
  extractedDb = [],
  extractedBackendRuntime = null,
  routerContracts = {},
  emitOkVerdicts = true,
  onVerdict = null,
} = {}) {
  const mismatches = [];
  const extras = [];

  // W3.TEL — emit one `ok` verdict per matched contract item. Local helper so
  // we don't repeat the workspaceDir + sink boilerplate at every match site.
  // Writes to .harness/reconciler-verdicts.jsonl AND calls onVerdict (when
  // present). Both wrapped via the writer's logAndSwallow — safe on any path.
  const emitOk = (scope, contractItem, kind) => {
    if (!emitOkVerdicts || !workspaceDir) {
      if (typeof onVerdict === 'function') {
        try { onVerdict({ scope, contractItem, kind, verdict: 'ok', target: null, reasoning: null }); }
        catch { /* sink errors must not break the comparator */ }
      }
      return;
    }
    const record = { scope, contractItem, kind, verdict: 'ok', target: null, reasoning: null };
    pushReconcilerVerdict(workspaceDir, record);
    if (typeof onVerdict === 'function') {
      try { onVerdict(record); } catch { /* sink errors must not break the comparator */ }
    }
  };

  const apiContract = routerContracts.apiContract || null;
  const dataModel = routerContracts.dataModel || null;
  const uiContract = routerContracts.uiContract || null;

  // 0. Empty-scope guard. Each scope referenced by docker-compose.yml's build
  // contexts must have a Dockerfile. Otherwise the agent declared "complete"
  // but produced nothing, and compose build will fail later anyway. Surfacing
  // this as a hard mismatch lets the re-engage loop try once before the
  // diagnostic; if re-engage exhausts, the user gets a clear message instead
  // of "lstat ... no such file or directory".
  if (workspaceDir) {
    for (const empty of detectEmptyScopes(workspaceDir)) {
      mismatches.push({
        kind: 'empty-scope',
        scope: empty.scope,
        severity: 'hard',
        file: empty.expectedDockerfile,
        line: null,
        contract: `${empty.scope} scope was dispatched (compose service "${empty.service}" references ./${empty.scope}) but produced no Dockerfile`,
        actual: `${empty.expectedDockerfile} does not exist on disk`,
        method: null,
        path: null,
      });
    }
  }

  // 1. Backend <-> Frontend routes.
  const backendKeys = new Map(); // key → route record
  for (const r of extractedBackend) backendKeys.set(keyOf(r.method, r.path), r);

  const frontendKeys = new Map();
  for (const f of extractedFrontend) {
    if (!frontendKeys.has(keyOf(f.method, f.path))) {
      frontendKeys.set(keyOf(f.method, f.path), f);
    }
  }

  // The backend's REAL route table from runtime introspection (the live router
  // table — see extract-routes-runtime.js), or null when introspection was
  // unavailable. This is the authority for whether a route EXISTS: static
  // extraction (regex) missed helper-mounted routes like
  // `mountCsvExport(app, '/p', fn)` and false-blocked correct builds.
  const runtimeAvailable = Array.isArray(extractedBackendRuntime);
  const runtimeKeys = new Set();
  const runtimePaths = new Set();
  for (const r of extractedBackendRuntime || []) {
    runtimeKeys.add(keyOf(r.method, r.path));
    runtimePaths.add(normalizeRoutePath(r.path));
  }
  // A contract/fetch endpoint counts as implemented if EITHER the regex
  // extractor or the live router table shows it. The method-agnostic path
  // check tolerates a mounted sub-router whose prefix we couldn't decode — we
  // always bias away from a false "missing route".
  const backendHasEndpoint = (method, p) => {
    const k = keyOf(method, p);
    if (backendKeys.has(k)) return true;
    if (runtimeAvailable && (runtimeKeys.has(k) || runtimePaths.has(normalizeRoutePath(p)))) return true;
    return false;
  };

  // W3.TEL — matched-without-judge `ok` verdicts: every route that BOTH
  // backend and frontend implement gets one `ok` line. Mirrors compare.js's
  // existing match-detection logic (the loop below skips a frontend key when
  // backendKeys.has(key), so emit here before the skip branch in the loop
  // would suppress it). Per the worker brief: "Append one line per matched
  // contract item there too."
  for (const [key, _f] of frontendKeys) {
    if (!backendHasEndpoint(_f.method, _f.path)) continue;
    emitOk('api_contract', key, 'api_contract');
  }

  // Frontend calls something backend doesn't expose.
  // Layered precedence:
  //   - Equalizer (backend wins) is for SHAPE disagreement on endpoints both
  //     sides have. Cheaper to fix one fetch body than N handler signatures.
  //   - PRESENCE is the router's call — if api_contract says an endpoint
  //     should exist and backend missed it, that's a real feature gap and
  //     the build is functionally incomplete. Re-engage backend, not frontend.
  // Without this layering we'd silently rubber-stamp incomplete backends:
  // observed t39 (2026-05-09) — backend wrote only /health + /export/users
  // out of 7 contract endpoints. Reconciler under flat-equalizer marked the
  // 3 frontend-fetch mismatches as soft (frontend deviates), build passed,
  // app was 80% non-functional. Layered logic catches this.
  for (const [key, f] of frontendKeys) {
    if (backendHasEndpoint(f.method, f.path)) continue;
    const contractHas = apiContract?.endpoints?.some(
      e => keyOf(e.method, e.path) === key,
    );
    if (contractHas) {
      // Contract said this endpoint should exist; backend appears to miss it.
      // HARD only when the live router table authoritatively confirms its
      // absence (frontend's UI flow will 404 — a real feature gap). When
      // introspection was unavailable we can't be sure the route isn't
      // registered via a pattern static extraction missed, so we downgrade to
      // SOFT rather than risk false-blocking a correct build (graceful
      // fallback — the regex check used to false-positive here on JOIN-style
      // helper mounts).
      mismatches.push({
        kind: 'backend-missing-contract-endpoint',
        scope: 'backend',
        severity: runtimeAvailable ? 'hard' : 'soft',
        file: f.file,
        line: f.line,
        method: f.method,
        path: f.path,
        contract: `api_contract endpoint ${key} (frontend uses it; router promised it)`,
        actual: runtimeAvailable
          ? 'no matching route in the live router table'
          : 'backend exposes no matching route (static check — not runtime-confirmed)',
      });
    } else {
      // Frontend invented a path neither backend nor contract has.
      // SOFT under equalizer — frontend should rename to a real backend
      // route or remove the call. App still boots; the action just 404s.
      mismatches.push({
        kind: 'frontend-fetch-no-backend-route',
        scope: 'frontend',
        severity: 'soft',
        file: f.file,
        line: f.line,
        method: f.method,
        path: f.path,
        contract: `backend exposes no route matching ${key} (and contract does not list it)`,
        actual: `frontend fetches ${key}`,
      });
    }
  }

  // Backend routes the CONTRACT doesn't know about. Checked for every
  // backend route regardless of frontend usage — the old `frontendKeys`
  // skip created an invisible class: a route both sides implement but the
  // contract never learned (stale envelope) matched no detector, so it was
  // never judged, never adopted, and never probed. Observed live with
  // GET /admin/export after a simulated contract-knowledge loss.
  // Only meaningful when a contract is present at all — with no contract
  // (legacy/no-router runs) every route would be flagged, which is noise.
  // An EMPTY endpoints array is still a contract: routes are then extras.
  //
  // Scan the UNION of static + runtime routes: helper-mounted routes (e.g.
  // `mountCsvExport(app, '/admin/export', fn)`) only exist in the live
  // router table, and were invisible to contract adoption when this loop
  // read only the regex extraction.
  const contractPresent = Array.isArray(apiContract?.endpoints);
  const allBackendRoutes = new Map(backendKeys);
  if (runtimeAvailable) {
    for (const r of extractedBackendRuntime) {
      if (!r || typeof r.path !== 'string' || !r.path.startsWith('/')) continue;
      const k = keyOf(r.method, r.path);
      if (!allBackendRoutes.has(k)) {
        allBackendRoutes.set(k, { method: r.method, path: r.path, file: '(live router table)', line: 0 });
      }
    }
  }
  for (const [key, r] of allBackendRoutes) {
    if (!contractPresent) break;
    // Skip /health — convention, not a feature.
    if (r.path === '/health') continue;
    const contractHas = apiContract.endpoints.some(e => keyOf(e.method, e.path) === key);
    if (!contractHas) {
      extras.push({
        kind: 'backend-extra-route',
        scope: 'backend',
        method: r.method,
        path: r.path,
        // Frontend usage is strong legitimacy evidence for the judge: a
        // route the UI actively calls is part of the app, not scaffolding.
        calledByFrontend: frontendKeys.has(key),
        evidence: `${r.file}:${r.line}`,
      });
    }
    // contractHas + frontend doesn't call → frontend coverage gap (handled below).
  }

  // Body field mismatch where both sides recorded fields.
  // Backend-as-truth: frontend must send exactly what backend reads. If they
  // differ, frontend deviates regardless of what api_contract said.
  for (const [key, r] of backendKeys) {
    const f = frontendKeys.get(key);
    if (!f) continue;
    if (!r.requestFields || !f.requestFields) continue;
    const bSet = new Set(r.requestFields);
    const fSet = new Set(f.requestFields);
    const missingFromBackend = [...fSet].filter(x => !bSet.has(x));
    const missingFromFrontend = [...bSet].filter(x => !fSet.has(x));
    if (missingFromBackend.length || missingFromFrontend.length) {
      mismatches.push({
        kind: 'body-shape-mismatch',
        scope: 'frontend',
        severity: 'soft',
        file: f.file,
        line: f.line,
        method: r.method,
        path: r.path,
        contract: `backend reads { ${[...bSet].join(', ')} } (source of truth)`,
        actual: `frontend sends { ${[...fSet].join(', ')} }`,
      });
    }
  }

  // 2. Backend <-> DB columns: moved OUT of this regex-based comparator.
  // SQL column validation now lives in the Postgres-PREPARE gate
  // (sql-prepare-gate.js): AST-extract the backend's queries, then PREPARE them
  // against the real schema so Postgres itself (not regex) judges column/table
  // existence — correctly resolving joins, aliases, and string literals. The
  // old regex here false-positived on JOINs (a `messages.content` column in a
  // `FROM feedback` query was mis-blamed as `feedback.content`) and blocked
  // correct builds. `extractedDb`/`dataModel` are still accepted for the other
  // checks and backward-compat.

  // 3. Coverage check — only surface gaps that affect a working feature path.
  //
  //   * !inBackend && inFrontend  → already classified above as HARD
  //                                 (backend-missing-contract-endpoint).
  //   * !inBackend && !inFrontend → router imagined more than got built;
  //                                 nobody depends on it. Extra, not mismatch
  //                                 — the user can re-prompt if they need it,
  //                                 but the build is functional.
  //   *  inBackend && !inFrontend → backend has it, frontend doesn't use it.
  //                                 Extra (probably an admin/worker endpoint
  //                                 the frontend doesn't surface — judge
  //                                 decides legitimacy).
  //   *  inBackend &&  inFrontend → match, no entry.
  if (apiContract?.endpoints) {
    for (const e of apiContract.endpoints) {
      const k = keyOf(e.method, e.path);
      // Skip platform-convention endpoints — never a feature mismatch.
      if (e.path === '/health' || e.path === '/ping') continue;
      const inBackend = backendHasEndpoint(e.method, e.path);
      const inFrontend = frontendKeys.has(k);
      if (!inBackend && !inFrontend) {
        extras.push({
          kind: 'coverage-gap-backend',
          scope: 'backend',
          method: e.method,
          path: e.path,
          contract: `api_contract endpoint ${k} (router promised; nobody implements)`,
        });
      } else if (inBackend && !inFrontend && extractedFrontend.length > 0) {
        extras.push({
          kind: 'coverage-gap-frontend',
          scope: 'frontend',
          method: e.method,
          path: e.path,
          contract: `api_contract endpoint ${k} (backend exposes it; frontend missed the UI)`,
        });
      }
    }
  }

  if (uiContract?.components && extractedFrontend.length > 0) {
    // Coverage of ui_contract.components is harder to measure from fetches.
    // We expose component-level coverage gaps as extras for the judge to
    // categorize; the judge can match component names against extra fetches'
    // patterns to recognize legitimate substitutions.
    for (const c of uiContract.components) {
      extras.push({
        kind: 'coverage-gap-ui-component',
        scope: 'frontend',
        component: c.name,
        contract: `ui_contract.components includes "${c.name}"`,
      });
    }
  }

  // W3.TEL — flush all `ok` verdicts emitted during this comparator pass
  // as a single appendFileSync. Hot-path emitOk pushed to the in-memory
  // buffer only; this is the phase boundary that drains it.
  if (workspaceDir) flushReconcilerVerdicts(workspaceDir);
  return { mismatches, extras };
}

// Parse the api_contract.endpoints[].request shape into a flat object whose
// keys are the field names. The contract format is loose: it can be a string
// like "name: string required" or an object map. We handle both.
function parseContractRequestFields(request) {
  if (!request) return {};
  if (typeof request === 'string') {
    // String: "name: string required, age: int" — split on commas.
    const out = {};
    for (const part of request.split(',')) {
      const m = part.trim().match(/^([A-Za-z_][\w]*)/);
      if (m) out[m[1]] = true;
    }
    return out;
  }
  if (typeof request === 'object') {
    const out = {};
    for (const k of Object.keys(request)) out[k] = true;
    return out;
  }
  return {};
}

// ── Helpers exposed for testing ──

export const _internals = {
  normalizeRoutePath,
  keyOf,
  parseContractRequestFields,
};
