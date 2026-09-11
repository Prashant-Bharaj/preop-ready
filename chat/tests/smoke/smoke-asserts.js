/**
 * Shared structural assertions for multi-scope smoke scenarios.
 *
 * Each helper checks a specific load-bearing structural rule and throws on
 * failure with a clear, single-line message. They take only `workspace` (the
 * scenario's workspace path) and possibly small extra args (e.g. engine name
 * for the database engine variant).
 *
 * Helpers are gated per-scope by `runStructuralAsserts(workspace, scopes)`,
 * which only runs the checks for scopes the scenario claims.
 *
 * Why these exist: today's multi-scope scenarios PASS as long as `compose up`
 * succeeds. A regression that still compose-builds (backend uses /api/ prefix;
 * init.sql in wrong path; only one nginx config; service-name mismatch) slips
 * through silently. These structural asserts catch those classes.
 *
 * If a helper FAILs, it should fail loud with a precise message so the metrics
 * line ("FAIL: /api/ prefix in backend/src/index.ts") makes the regression
 * obvious without inspecting the workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  assertHasRunSummary,
  assertHasSnippetFetches,
  assertHasReconcilerVerdicts,
  assertHasAutoRecoveryAttempts,
  assertHasInvestigatorRecords,
} from '../util/telemetry-asserts.js';

// ── Backend ──────────────────────────────────────────────────────────────────

function readBackendEntry(workspace) {
  // Canonical Node entry is backend/src/index.ts post-W1.PATHS.CANONICAL.
  // Smoke runs in strict mode for the canonical-entry check — no .js fallback.
  const nodeEntry = path.join(workspace, 'backend/src/index.ts');
  const pyEntry = path.join(workspace, 'backend/main.py');
  if (fs.existsSync(nodeEntry)) return { path: 'backend/src/index.ts', content: fs.readFileSync(nodeEntry, 'utf-8'), runtime: 'node' };
  if (fs.existsSync(pyEntry))   return { path: 'backend/main.py',      content: fs.readFileSync(pyEntry,   'utf-8'), runtime: 'python' };
  return null;
}

export function assertBackendNoApiPrefix(workspace) {
  const entry = readBackendEntry(workspace);
  if (!entry) return; // Backend not present in this scenario's outputs; skip.
  // Match a literal /api/ inside a route-registration string. Catches
  // app.get('/api/users', ...) and router.use("/api"). Allows /api-docs,
  // /api/health (still wrong but rare; surface anyway).
  if (/['"]\/api[\/'"]/.test(entry.content)) {
    throw new Error(`${entry.path} registers routes with literal /api/ prefix — nginx strips /api before reaching backend`);
  }
}

export function assertBackendHealth(workspace) {
  const entry = readBackendEntry(workspace);
  if (!entry) return;
  if (!/['"]\/health['"]/.test(entry.content)) {
    throw new Error(`${entry.path} has no /health route — ECS healthcheck will fail on deploy`);
  }
}

export function assertBackendDockerfile(workspace) {
  const dfPath = path.join(workspace, 'backend/Dockerfile');
  if (!fs.existsSync(dfPath)) {
    throw new Error('backend/Dockerfile missing');
  }
  const content = fs.readFileSync(dfPath, 'utf-8');
  const entry = readBackendEntry(workspace);
  // Sanity: runtime FROM matches the entry-file language. The canonical
  // backend Dockerfiles use `dd-kitchen-sink` (a Debian base with node + pip
  // caches pre-warmed for fast `compose build`s); accept it for either runtime.
  if (entry?.runtime === 'node' && !/FROM\s+(node|dd-kitchen-sink)/i.test(content)) {
    throw new Error('backend/Dockerfile FROM is not a node image despite Node entry file');
  }
  if (entry?.runtime === 'python' && !/FROM\s+(python|dd-kitchen-sink)/i.test(content)) {
    throw new Error('backend/Dockerfile FROM is not python despite Python entry file');
  }
}

export function assertBackendDockerfileCurl(workspace) {
  const dfPath = path.join(workspace, 'backend/Dockerfile');
  if (!fs.existsSync(dfPath)) throw new Error('backend/Dockerfile missing');
  const content = fs.readFileSync(dfPath, 'utf-8');
  // The minimal runtime base (node:22-slim / python:3.12-slim) has no curl by
  // default, so it must be explicitly installed for the `/health` healthcheck
  // (local compose `service_healthy` + ECS Fargate container health check per
  // security.md). Mirrors assertFrontendDockerfileCurl. A textual `curl` is
  // required precisely because the runtime is minimal — a fat base that ships
  // curl implicitly is exactly what we moved away from.
  if (!/\bcurl\b/.test(content)) {
    throw new Error('backend/Dockerfile does not install curl — required for the /health healthcheck (local compose + ECS Fargate) per security.md');
  }
}

// ── Database ─────────────────────────────────────────────────────────────────

function readDatabaseInit(workspace) {
  const canonical = path.join(workspace, 'database/init/init.sql');
  if (fs.existsSync(canonical)) return { path: 'database/init/init.sql', content: fs.readFileSync(canonical, 'utf-8') };
  // Multi-file init: any file under database/init/.
  const initDir = path.join(workspace, 'database/init');
  if (fs.existsSync(initDir)) {
    const files = fs.readdirSync(initDir).filter(f => f.endsWith('.sql')).sort();
    if (files.length > 0) {
      const content = files.map(f => fs.readFileSync(path.join(initDir, f), 'utf-8')).join('\n');
      return { path: `database/init/${files[0]}`, content };
    }
  }
  return null;
}

export function assertDatabaseInit(workspace) {
  const init = readDatabaseInit(workspace);
  if (!init) {
    // Detect common wrong placements to give a useful error.
    const wrongRoot = fs.existsSync(path.join(workspace, 'init.sql'));
    const wrongDb = fs.existsSync(path.join(workspace, 'database/init.sql'));
    const hint = wrongRoot ? ' (found at workspace root — postgres will not auto-run)'
              : wrongDb   ? ' (found at database/init.sql — must be database/init/init.sql)'
                          : '';
    throw new Error(`database/init/init.sql missing${hint}`);
  }
  if (!/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(init.content)) {
    throw new Error(`${init.path} missing CREATE TABLE IF NOT EXISTS — not idempotent on volume re-init`);
  }
}

// ── Frontend ─────────────────────────────────────────────────────────────────

export function assertFrontendNginxBoth(workspace) {
  const prod = path.join(workspace, 'frontend/nginx.conf');
  const local = path.join(workspace, 'frontend/nginx.local.conf');
  if (!fs.existsSync(prod))  throw new Error('frontend/nginx.conf missing (production config)');
  if (!fs.existsSync(local)) throw new Error('frontend/nginx.local.conf missing (local-dev config)');
  const prodContent = fs.readFileSync(prod, 'utf-8');
  const localContent = fs.readFileSync(local, 'utf-8');
  if (/proxy_pass\s+http/i.test(prodContent)) {
    throw new Error('frontend/nginx.conf has proxy_pass — production routes /api via Traefik, not nginx');
  }
  if (!/proxy_pass\s+http:\/\/backend:3000/i.test(localContent)) {
    throw new Error('frontend/nginx.local.conf must proxy_pass to http://backend:3000 for local dev');
  }
}

export function assertFrontendDockerfileCurl(workspace) {
  const dfPath = path.join(workspace, 'frontend/Dockerfile');
  if (!fs.existsSync(dfPath)) throw new Error('frontend/Dockerfile missing');
  const content = fs.readFileSync(dfPath, 'utf-8');
  if (!/\bcurl\b/.test(content)) {
    throw new Error('frontend/Dockerfile does not install curl — required for ECS healthcheck per security.md');
  }
}

// ── Vectordb ─────────────────────────────────────────────────────────────────

export function assertVectordbIndependent(workspace) {
  const vectorDir = path.join(workspace, 'vectordb');
  if (!fs.existsSync(vectorDir)) {
    throw new Error('vectordb/ directory missing — vectordb scope claimed but no artifacts produced');
  }
  const hasDockerfile = fs.existsSync(path.join(vectorDir, 'Dockerfile'));
  const hasInit = fs.existsSync(path.join(vectorDir, 'init', 'init.sql'))
                || fs.existsSync(path.join(vectorDir, 'init.sql'));
  if (!hasDockerfile && !hasInit) {
    throw new Error('vectordb/ has neither Dockerfile nor init.sql — empty scope');
  }
}

// ── Integration / docker-compose ─────────────────────────────────────────────

export function assertComposeShape(workspace, scopes = []) {
  const composePath = path.join(workspace, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) throw new Error('docker-compose.yml missing at workspace root');
  const content = fs.readFileSync(composePath, 'utf-8');
  // Service names match scope folder names (excluding integration itself,
  // which has no service of its own).
  const serviceScopes = scopes.filter(s => s !== 'integration' && s !== 'docs' && s !== 'fullstack');
  for (const s of serviceScopes) {
    const re = new RegExp(`^\\s*${s}\\s*:`, 'm');
    if (!re.test(content)) {
      throw new Error(`docker-compose.yml missing service "${s}" (must match folder name from scope list)`);
    }
  }
  // If backend + database both exist, backend env must reference database by name.
  if (serviceScopes.includes('backend') && serviceScopes.includes('database')) {
    if (!/DATABASE_HOST\s*[:=]\s*['"]?database['"]?/i.test(content)) {
      throw new Error('docker-compose.yml: backend env DATABASE_HOST is not "database" — must equal the service name (Docker DNS)');
    }
  }
  // Postgres data dir is /data per Dockerfile.postgres ENV PGDATA=/data.
  // If a database service exists, expect a named-volume mount at /data
  // (or /data/mysql for MySQL scenarios — checked separately below).
  if (serviceScopes.includes('database')) {
    const hasMysql = /\/data\/mysql\b/.test(content);
    const hasData  = /:\s*\/data\b/.test(content);
    if (!hasMysql && !hasData) {
      throw new Error('docker-compose.yml: database service has no volume at /data (PGDATA) or /data/mysql — persistence will be lost on redeploy');
    }
  }
}

// ── Aggregator ───────────────────────────────────────────────────────────────

const SCOPE_CHECKS = {
  backend:     [assertBackendNoApiPrefix, assertBackendHealth, assertBackendDockerfile, assertBackendDockerfileCurl],
  frontend:    [assertFrontendNginxBoth, assertFrontendDockerfileCurl],
  database:    [assertDatabaseInit],
  vectordb:    [assertVectordbIndependent],
  // integration's checks need the scope list, handled specially below.
};

// ── Router-output assertions (Track A — A4) ─────────────────────────────────

/**
 * Track A (A4): deep-partial-match the router's structured output against a
 * per-scenario `plannerExpect` spec. Throws with a precise multi-line message
 * on miss; returns silently on match.
 *
 * Fired at smoke gate-time, after the `plan_preview` event but before
 * `httpConfirmPlan` — short-circuits a misleading multi-scope build when the
 * router has already comprehended the prompt incorrectly.
 *
 * `payload` is the plan_preview event body (carries tasks[], flags[],
 * dataModel, apiContract, uiContract, businessLogicContract, vectorEngine).
 *
 * `expect` shape (all fields optional; absent = no check on that field):
 *   {
 *     scopes: ['backend','database',...],            // subset; observed must include all
 *     flags: ['has-users',...],                       // subset
 *     data_model: {
 *       tables: [{ name: 'tasks', columns_include: ['id','user_id'] }, ...]
 *     },
 *     api_contract: {
 *       endpoints_include: [{ method:'GET', path:'/tasks' }, ...]
 *     },
 *     ui_contract: {
 *       primary_view: /^task/i || 'list of tasks',    // RegExp or exact string
 *       primary_action: ...,
 *       components_include: ['TaskList', ...]
 *     },
 *     business_logic_contract: {
 *       rules_pattern: [/user|own/i, ...],            // each regex must match SOME rule
 *       triggers_include: ['user_signup', ...]        // each event must appear
 *     },
 *     vector_engine: 'pgvector'                       // exact string
 *   }
 *
 * Match semantics by type:
 *   - Arrays of strings → subset (every expected entry present in observed).
 *   - Arrays ending `_include` of objects → subset by structural key
 *     (`name` for tables/components, `method+path` for endpoints, `event` for triggers).
 *   - String matchers → exact match.
 *   - RegExp matchers → regex test against observed string.
 *
 * Errors are accumulated and reported all at once so a single router emission
 * surfaces every drift point in one round, not one per re-run.
 */
export function assertRouterExpect(payload, expect) {
  if (!expect || typeof expect !== 'object') return;
  const errors = [];

  // scopes: subset check on tasks[].scope
  if (Array.isArray(expect.scopes)) {
    const observed = new Set((payload.tasks || []).map((t) => t.scope));
    for (const s of expect.scopes) {
      if (!observed.has(s)) {
        errors.push(`scopes missing "${s}" (got [${[...observed].join(', ') || 'none'}])`);
      }
    }
  }

  // flags: subset
  if (Array.isArray(expect.flags)) {
    const observed = new Set(payload.flags || []);
    for (const f of expect.flags) {
      if (!observed.has(f)) {
        errors.push(`flags missing "${f}" (got [${[...observed].join(', ') || 'none'}])`);
      }
    }
  }

  // data_model: tables[].name + columns_include
  if (expect.data_model && Array.isArray(expect.data_model.tables)) {
    const observed = (payload.dataModel && payload.dataModel.tables) || [];
    for (const expTable of expect.data_model.tables) {
      const obs = observed.find((t) => t.name === expTable.name);
      if (!obs) {
        errors.push(`data_model: table "${expTable.name}" missing (got [${observed.map((t) => t.name).join(', ') || 'none'}])`);
        continue;
      }
      if (Array.isArray(expTable.columns_include)) {
        const obsCols = new Set((obs.columns || []).map((c) => c.name));
        for (const c of expTable.columns_include) {
          if (!obsCols.has(c)) {
            errors.push(`data_model: ${expTable.name}.${c} missing (got [${[...obsCols].join(', ')}])`);
          }
        }
      }
    }
  }

  // api_contract: endpoints_include match by method+path
  if (expect.api_contract && Array.isArray(expect.api_contract.endpoints_include)) {
    const observed = (payload.apiContract && payload.apiContract.endpoints) || [];
    const observedKeys = new Set(observed.map((e) => `${e.method} ${e.path}`));
    for (const ep of expect.api_contract.endpoints_include) {
      const key = `${ep.method} ${ep.path}`;
      if (!observedKeys.has(key)) {
        errors.push(`api_contract: endpoint "${key}" missing (got [${[...observedKeys].join(', ') || 'none'}])`);
      }
    }
  }

  // ui_contract: primary_view, primary_action, components_include
  if (expect.ui_contract && typeof expect.ui_contract === 'object') {
    const ui = payload.uiContract || {};
    if (expect.ui_contract.primary_view !== undefined) {
      if (!matchStringOrRegex(ui.primary_view, expect.ui_contract.primary_view)) {
        errors.push(`ui_contract.primary_view "${ui.primary_view || ''}" doesn't match ${describeMatcher(expect.ui_contract.primary_view)}`);
      }
    }
    if (expect.ui_contract.primary_action !== undefined) {
      if (!matchStringOrRegex(ui.primary_action, expect.ui_contract.primary_action)) {
        errors.push(`ui_contract.primary_action "${ui.primary_action || ''}" doesn't match ${describeMatcher(expect.ui_contract.primary_action)}`);
      }
    }
    if (Array.isArray(expect.ui_contract.components_include)) {
      const obsNames = new Set((ui.components || []).map((c) => c.name));
      for (const n of expect.ui_contract.components_include) {
        if (!obsNames.has(n)) {
          errors.push(`ui_contract: component "${n}" missing (got [${[...obsNames].join(', ') || 'none'}])`);
        }
      }
    }
  }

  // business_logic_contract: rules_pattern + triggers_include
  if (expect.business_logic_contract && typeof expect.business_logic_contract === 'object') {
    const bl = payload.businessLogicContract || {};
    if (Array.isArray(expect.business_logic_contract.rules_pattern)) {
      const rules = bl.rules || [];
      for (const re of expect.business_logic_contract.rules_pattern) {
        if (!rules.some((r) => typeof r === 'string' && re.test(r))) {
          errors.push(`business_logic_contract.rules: no rule matches ${re} (got [${rules.join(' | ') || 'none'}])`);
        }
      }
    }
    if (Array.isArray(expect.business_logic_contract.triggers_include)) {
      const observed = (bl.triggers || []).map((t) => t.event);
      for (const e of expect.business_logic_contract.triggers_include) {
        if (!observed.includes(e)) {
          errors.push(`business_logic_contract.triggers: event "${e}" missing (got [${observed.join(', ') || 'none'}])`);
        }
      }
    }
  }

  // vector_engine: exact string match
  if (expect.vector_engine !== undefined) {
    if (payload.vectorEngine !== expect.vector_engine) {
      errors.push(`vector_engine: expected "${expect.vector_engine}", got "${payload.vectorEngine || 'none'}"`);
    }
  }

  // mga_assistants: array presence assertions on the TOP-LEVEL field.
  //   { mga_assistants_min: 1 } — array must have ≥ N entries
  //   { mga_assistants_forbidden: true } — array must be empty (CRUD app)
  if (typeof expect.mga_assistants_min === 'number') {
    const arr = Array.isArray(payload.mgaAssistants) ? payload.mgaAssistants : [];
    if (arr.length < expect.mga_assistants_min) {
      errors.push(`mga_assistants_min: ${expect.mga_assistants_min} required, got ${arr.length}`);
    } else {
      // Validate the first entry has the required shape.
      const m = arr[0];
      if (typeof m.name !== 'string' || m.name.length < 3) errors.push(`mga_assistants[0]: name missing/too short`);
      // `instructions` is intentionally OPTIONAL in the contract-agent prompt
      // (chat/prompts/contract-agent.md §6 "Optional instructions field can
      // be a 1-line stub or omitted entirely"). The runtime prompt-writer
      // flow (routes.js:1951 → writeAssistantInstructions) fills in the
      // final instructions text from intent + tool list + contracts before
      // MGA assistant creation — the planner-emitted value is just a hint.
      // If present, require >=10 chars to catch obvious stubs that aren't
      // even one-line; if absent or empty, that's fine.
      if (m.instructions != null
          && (typeof m.instructions !== 'string' || (m.instructions.length > 0 && m.instructions.length < 10))) {
        errors.push(`mga_assistants[0]: instructions present but too short (<10 chars); either omit or expand`);
      }
      if (typeof m.model !== 'string') errors.push(`mga_assistants[0]: model missing`);
    }
  }
  if (expect.mga_assistants_forbidden) {
    const arr = Array.isArray(payload.mgaAssistants) ? payload.mgaAssistants : [];
    if (arr.length > 0) {
      errors.push(`mga_assistants_forbidden: ${arr.length} emitted (CRUD app should not trigger AI)`);
    }
  }

  if (errors.length) {
    throw new Error('plannerExpect mismatch:\n  - ' + errors.join('\n  - '));
  }
}

function matchStringOrRegex(observed, matcher) {
  if (matcher instanceof RegExp) return typeof observed === 'string' && matcher.test(observed);
  if (typeof matcher === 'string') return observed === matcher;
  return false;
}

function describeMatcher(m) {
  if (m instanceof RegExp) return m.toString();
  return JSON.stringify(m);
}

// ── Structural asserts dispatcher ────────────────────────────────────────────

/**
 * Run all structural asserts relevant to `scopes`. Returns an array of
 * `{ scope, error }` objects for failures (empty array = all clean).
 * Caller decides whether failures downgrade scenario status.
 */
export function runStructuralAsserts(workspace, scopes = []) {
  const failures = [];
  for (const scope of scopes) {
    const checks = SCOPE_CHECKS[scope] || [];
    for (const check of checks) {
      try { check(workspace); }
      catch (err) { failures.push({ scope, check: check.name, error: err.message }); }
    }
  }
  if (scopes.includes('integration')) {
    try { assertComposeShape(workspace, scopes); }
    catch (err) { failures.push({ scope: 'integration', check: 'assertComposeShape', error: err.message }); }
  }
  return failures;
}

// ── Telemetry assertions (Dispatch 4 Part F.2) ──────────────────────────────

/**
 * Run telemetry assertions against the scenario's workspace dir. Wraps
 * tests/util/telemetry-asserts.js helpers so the smoke tier and integration
 * tier share one implementation. Returns an array of `{ check, error }`
 * objects for failures (empty = all clean). Universal-by-default helpers
 * always run; opt-in helpers gate on scenario flags so they don't fail
 * scenarios that genuinely don't exercise the corresponding path.
 *
 * Opt-in flags (set on the scenario object):
 *   - scenario.expectAutoRecovery = true → require autoRecoveryAttempts
 *     records in the run-summary. Use for scenarios that exercise the
 *     recovery loop (e.g., t-deploy-fail-recovery, t11 under failure).
 *   - scenario.expectInvestigator = true → require investigator-records.
 *     Use for diagnose-path scenarios (t-diagnose-known-bug,
 *     t-multi-turn-flow turn 3).
 *
 * Universal-by-default helpers:
 *   - assertHasRunSummary: every scenario produces a run-summary.
 *   - assertHasSnippetFetches: every scenario that invokes subagents
 *     produces snippet-fetch records. Soft-skipped if the file doesn't
 *     exist (e.g., scenarios that don't reach subagent dispatch).
 *   - assertHasReconcilerVerdicts: most multi-scope scenarios produce
 *     reconciler-verdicts; soft-skipped on file-not-found for scenarios
 *     that error out before reconciler runs.
 */
export function runTelemetryAsserts(workspace, scenario = {}, opts = {}) {
  const failures = [];
  const { sessionId } = opts;

  // run-summary is universal. If this fails, the scenario got far enough
  // to have produced telemetry — required for every other assertion.
  try {
    assertHasRunSummary(workspace, sessionId ? { sessionId } : {});
  } catch (err) {
    failures.push({ check: 'assertHasRunSummary', error: err.message });
    // If run-summary is missing, the other helpers will all fail. Return
    // early so the failure list isn't dominated by downstream noise.
    return failures;
  }

  // snippet-fetches: soft assert (skip if file absent — scenario may not
  // have reached subagent dispatch).
  const snippetFetchesPath = path.join(workspace, '.harness', 'snippet-fetches.jsonl');
  if (fs.existsSync(snippetFetchesPath)) {
    try {
      assertHasSnippetFetches(workspace, sessionId ? { sessionId } : {});
    } catch (err) {
      failures.push({ check: 'assertHasSnippetFetches', error: err.message });
    }
  }

  // reconciler-verdicts: soft assert (skip if file absent — scenario may
  // not have produced verdicts, e.g., single-scope or pre-reconciler error).
  const reconcilerVerdictsPath = path.join(workspace, '.harness', 'reconciler-verdicts.jsonl');
  if (fs.existsSync(reconcilerVerdictsPath)) {
    try {
      assertHasReconcilerVerdicts(workspace, { minCount: 1 });
    } catch (err) {
      failures.push({ check: 'assertHasReconcilerVerdicts', error: err.message });
    }
  }

  // auto-recovery: opt-in per scenario.
  if (scenario.expectAutoRecovery) {
    try {
      assertHasAutoRecoveryAttempts(workspace, sessionId ? { sessionId } : {});
    } catch (err) {
      failures.push({ check: 'assertHasAutoRecoveryAttempts', error: err.message });
    }
  }

  // investigator-records: opt-in per scenario (diagnose-path).
  if (scenario.expectInvestigator) {
    try {
      assertHasInvestigatorRecords(workspace, sessionId ? { sessionId } : {});
    } catch (err) {
      failures.push({ check: 'assertHasInvestigatorRecords', error: err.message });
    }
  }

  return failures;
}
