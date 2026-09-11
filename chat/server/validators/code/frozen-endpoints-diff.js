/**
 * Track A (A3): router-output-only diff for frozen API endpoints.
 *
 * Detects when a continuation router emission silently changes the shape
 * of an endpoint that previously existed. Pure JSON diff — no AST, no HTTP
 * probes, no language coupling. Runs at router-parse time in router.js,
 * before phase agents are dispatched.
 *
 * Shape-change semantics (chosen to avoid false positives on additive evolution):
 *   - removed top-level response/request key → BREAKING
 *   - removed endpoint entirely             → BREAKING
 *   - added top-level key                    → SAFE (frontend ignores unknowns)
 *
 * Endpoints are keyed by `method path` (two endpoints can share a path with
 * different methods, e.g., GET /reports vs POST /reports).
 *
 * Response body keys are extracted from the `response.body` string sketch
 * (e.g., `"{ id, name, created_at }"` or `"{ id: integer, name: string }"`).
 * Both prose-sketch and typed-key forms are supported.
 */

function endpointKey(e) {
  return `${e.method} ${e.path}`;
}

function indexEndpoints(apiContract) {
  if (!apiContract || !Array.isArray(apiContract.endpoints)) return new Map();
  const map = new Map();
  for (const e of apiContract.endpoints) {
    if (!e || typeof e.method !== 'string' || typeof e.path !== 'string') continue;
    map.set(endpointKey(e), e);
  }
  return map;
}

/**
 * Extract the top-level key set from a response.body string sketch.
 * Supports:
 *   "{ id, name, created_at }"        → Set{id, name, created_at}
 *   "{ id: integer, name: string }"   → Set{id, name}
 *   "{ Request }"                     → Set{Request}      (typeref placeholder)
 *   ""                                → Set{}
 *   non-string                        → null (caller skips)
 *
 * Nested object shapes are NOT walked — only top-level keys.
 */
function extractBodyKeys(bodyStr) {
  if (typeof bodyStr !== 'string') return null;
  const inner = bodyStr.replace(/^\s*\{?\s*/, '').replace(/\s*\}?\s*$/, '');
  if (!inner) return new Set();
  // Split top-level by commas (cheap; doesn't handle nested {} commas — intentional, router sketches are flat).
  const keys = inner
    .split(',')
    .map((s) => s.trim().split(/[:\s]/)[0])
    .filter(Boolean);
  return new Set(keys);
}

/**
 * Diff a new api_contract against the prior turn's contract for paths
 * listed in `frozen_endpoints`.
 *
 * @param {object|null} newApiContract  - the router's just-emitted contract; may include `frozen_endpoints: [{method, path}]`
 * @param {object|null} priorApiContract - the prior turn's persisted contract from disk
 * @returns {{ ok: boolean, breaking: Array<{endpoint: string, kind: string, key?: string}> }}
 */
export function diffFrozenEndpoints(newApiContract, priorApiContract) {
  if (!priorApiContract || !Array.isArray(priorApiContract.endpoints) || priorApiContract.endpoints.length === 0) {
    return { ok: true, breaking: [] };
  }
  if (!newApiContract || typeof newApiContract !== 'object') {
    return { ok: true, breaking: [] };
  }
  const frozen = Array.isArray(newApiContract.frozen_endpoints) ? newApiContract.frozen_endpoints : [];
  if (frozen.length === 0) return { ok: true, breaking: [] };

  const priorIdx = indexEndpoints(priorApiContract);
  const newIdx = indexEndpoints(newApiContract);
  const breaking = [];

  for (const f of frozen) {
    if (!f || typeof f.method !== 'string' || typeof f.path !== 'string') continue;
    const key = `${f.method} ${f.path}`;
    const prior = priorIdx.get(key);
    if (!prior) continue; // Router claimed a non-existent endpoint as frozen; ignore.
    const next = newIdx.get(key);
    if (!next) {
      breaking.push({ endpoint: key, kind: 'removed' });
      continue;
    }

    // Response shape: removed keys are breaking.
    const priorBodyKeys = extractBodyKeys(prior.response?.body);
    const nextBodyKeys = extractBodyKeys(next.response?.body);
    if (priorBodyKeys && nextBodyKeys) {
      for (const k of priorBodyKeys) {
        if (!nextBodyKeys.has(k)) {
          breaking.push({ endpoint: key, kind: 'response_key_removed', key: k });
        }
      }
    }

    // Request shape: removed keys are breaking.
    const priorReqKeys = prior.request && typeof prior.request === 'object' ? new Set(Object.keys(prior.request)) : null;
    const nextReqKeys = next.request && typeof next.request === 'object' ? new Set(Object.keys(next.request)) : null;
    if (priorReqKeys && nextReqKeys) {
      for (const k of priorReqKeys) {
        if (!nextReqKeys.has(k)) {
          breaking.push({ endpoint: key, kind: 'request_key_removed', key: k });
        }
      }
    }
  }

  return { ok: breaking.length === 0, breaking };
}

/**
 * Format a breaking-changes array into a human-readable string for log output
 * or error messages back to the router.
 */
export function formatBreakingChanges(breaking) {
  if (!Array.isArray(breaking) || breaking.length === 0) return '';
  return breaking
    .map((b) => {
      if (b.kind === 'removed') return `  - ${b.endpoint} was removed entirely`;
      if (b.kind === 'response_key_removed') return `  - ${b.endpoint} response lost field \`${b.key}\``;
      if (b.kind === 'request_key_removed') return `  - ${b.endpoint} request lost field \`${b.key}\``;
      return `  - ${b.endpoint} ${b.kind} ${b.key || ''}`.trim();
    })
    .join('\n');
}
