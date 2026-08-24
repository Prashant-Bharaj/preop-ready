/**
 * contract-canonicalizer.js — write-time canonicalization of the contracts
 * envelope. Runs inside writeContracts so EVERY writer (execute disk-back,
 * iterate merge, agent tool, migration) produces the same canonical shape and
 * every reader (subagent spawn messages, endpoint probe, type generator,
 * bench) can trust it. Pure + idempotent.
 *
 * Why: bench matrix pass 4 (deviation-tracker). The contract agent marked
 * only REQUIRED request fields ("plant_area_id": "number required") and left
 * optionals bare ("equipment_id": "number"). Payload builders (probe, bench)
 * only skip explicit "optional", so they guessed FK ids into an empty
 * database → POST /deviations failed 500/400 in every run and the probe's
 * 3 repair rounds couldn't converge. Same run: first-login trigger said
 * "default role 'operator'" with no mention of the token roleClaim, so every
 * persona was least-privileged forever and all role-gated flows 403'd.
 * Non-technical users cannot debug either failure — canonicalize instead of
 * validate-and-fail.
 *
 * Rules:
 *   1. Request-spec markers — every string field description carries an
 *      explicit `required` or `optional`:
 *        - already marked → untouched
 *        - bare `*_id` field → `optional` (a guessed FK into an empty table
 *          can only fail; senders that need it pass it explicitly)
 *        - bare otherwise → `required` (matches what backends generate for
 *          unmarked fields in practice — validators reject omissions)
 *   2. Flat-spec explosion — a request written as one clause string
 *      (`"fields": "plant_area_id number required, severity string required"`)
 *      becomes a per-field map. Payload builders iterate fields; a clause
 *      string reads as ONE field whose description contains "optional" and
 *      gets skipped wholesale (observed live: bench sent no severity → 400).
 *      `content_type` meta-keys are dropped — they describe the envelope,
 *      not a body field.
 *   3. Role provenance — a `*first_login*` trigger whose action never
 *      mentions the role claim gets the scaffold's contract appended: use
 *      the token roleClaim when present, else the least-privileged default.
 *      (The oidc identity scaffold already exposes `roleClaim`; this keeps
 *      the business-logic contract from contradicting it.)
 */

import { PLATFORM_EMBEDDING_MODEL, PLATFORM_EMBEDDING_DIMENSION } from '../config/defaults.js';

const MARKER_RE = /\b(required|optional)\b/i;
const FK_FIELD_RE = /_id$/;
const FIRST_LOGIN_RE = /first[_-]?login/i;
const ROLE_CLAIM_RE = /role[_ -]?claim/i;
const ROLE_CLAIM_CLAUSE = "; set role from the token's roleClaim when present, else the least-privileged default role";
const TYPE_WORD_RE = /^(string|number|int|integer|float|double|decimal|bool|boolean|file|date|datetime|text|json|array|object)\b/i;
const CLAUSE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/;

/**
 * Split a flat clause string ("a number required, b string optional") into
 * { a: "number required", b: "string optional" }. Returns null unless EVERY
 * comma-separated clause is `ident type...` — enum lists and prose stay put.
 */
function explodeClauseString(value) {
  const clauses = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (clauses.length < 2) return null;
  const out = {};
  for (const clause of clauses) {
    const m = CLAUSE_RE.exec(clause);
    if (!m || !TYPE_WORD_RE.test(m[2])) return null;
    out[m[1]] = m[2];
  }
  return out;
}

function canonicalizeRequestSpec(request, changes, epLabel) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  let out = null;
  for (const [field, desc] of Object.entries(request)) {
    if (typeof desc !== 'string' || !desc.trim()) continue;
    if (/^content[_-]?type$/i.test(field)) {
      out = out || { ...request };
      delete out[field];
      changes.push(`${epLabel}: -${field} (meta-key)`);
      continue;
    }
    const exploded = explodeClauseString(desc);
    if (exploded) {
      out = out || { ...request };
      delete out[field];
      Object.assign(out, exploded);
      changes.push(`${epLabel}.${field}: exploded to ${Object.keys(exploded).length} fields`);
      continue;
    }
    if (MARKER_RE.test(desc)) continue;
    const marker = FK_FIELD_RE.test(field) ? 'optional' : 'required';
    out = out || { ...request };
    out[field] = `${desc.trim()} ${marker}`;
    changes.push(`${epLabel}.${field}: +${marker}`);
  }
  // Exploded fields may themselves lack markers — one more pass settles them.
  if (out && changes.some((c) => c.includes('exploded'))) {
    return canonicalizeRequestSpec(out, changes, epLabel);
  }
  return out || request;
}

function canonicalizeApiContract(apiContract, changes) {
  if (!apiContract || typeof apiContract !== 'object') return apiContract;
  const endpoints = apiContract.endpoints;
  if (!Array.isArray(endpoints)) return apiContract;
  let touched = false;
  const next = endpoints.map((ep) => {
    if (!ep || typeof ep !== 'object' || !ep.request) return ep;
    const request = canonicalizeRequestSpec(ep.request, changes, `${ep.method} ${ep.path}`);
    if (request === ep.request) return ep;
    touched = true;
    return { ...ep, request };
  });
  return touched ? { ...apiContract, endpoints: next } : apiContract;
}

function canonicalizeBusinessLogic(blc, changes) {
  if (!blc || typeof blc !== 'object' || !Array.isArray(blc.triggers)) return blc;
  let touched = false;
  const triggers = blc.triggers.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const event = String(t.event || '');
    const action = String(t.action || '');
    if (!FIRST_LOGIN_RE.test(event) || !action || ROLE_CLAIM_RE.test(action)) return t;
    touched = true;
    changes.push(`trigger ${event}: +roleClaim clause`);
    return { ...t, action: `${action.replace(/[.;\s]+$/, '')}${ROLE_CLAIM_CLAUSE}` };
  });
  return touched ? { ...blc, triggers } : blc;
}

// Embedding identity — the runtime embed helper always produces
// PLATFORM_EMBEDDING_DIMENSION-dim vectors (MGA_EMBEDDING_MODEL is not
// wired by compose generation), so any other VECTOR/HALFVEC dimension in
// the data model guarantees an insert failure, and any other
// embedding_model value is a fiction the runtime ignores.
const VECTOR_DIM_RE = /\b(VECTOR|HALFVEC)\s*\(\s*(\d+)\s*\)/i;

function canonicalizeVectorDims(dataModel, changes) {
  const tables = dataModel?.tables;
  if (!Array.isArray(tables)) return dataModel;
  let touched = false;
  const nextTables = tables.map((t) => {
    if (!t || !Array.isArray(t.columns)) return t;
    let colTouched = false;
    const columns = t.columns.map((col) => {
      const type = String(col?.type || '');
      const m = VECTOR_DIM_RE.exec(type);
      if (!m || Number(m[2]) === PLATFORM_EMBEDDING_DIMENSION) return col;
      colTouched = true;
      changes.push(`${t.name}.${col.name}: ${m[1].toUpperCase()}(${m[2]}) → VECTOR(${PLATFORM_EMBEDDING_DIMENSION})`);
      return { ...col, type: type.replace(VECTOR_DIM_RE, `VECTOR(${PLATFORM_EMBEDDING_DIMENSION})`) };
    });
    if (!colTouched) return t;
    touched = true;
    return { ...t, columns };
  });
  return touched ? { ...dataModel, tables: nextTables } : dataModel;
}

function canonicalizeEmbeddingModels(node, changes, path) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    let touched = false;
    const next = node.map((v, i) => {
      const r = canonicalizeEmbeddingModels(v, changes, `${path}[${i}]`);
      if (r !== v) touched = true;
      return r;
    });
    return touched ? next : node;
  }
  let out = node;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'embedding_model' && typeof v === 'string' && /^text-embedding/.test(v) && v !== PLATFORM_EMBEDDING_MODEL) {
      out = out === node ? { ...node } : out;
      out[k] = PLATFORM_EMBEDDING_MODEL;
      changes.push(`${path}.${k}: ${v} → ${PLATFORM_EMBEDDING_MODEL}`);
      continue;
    }
    if (v && typeof v === 'object') {
      const r = canonicalizeEmbeddingModels(v, changes, `${path}.${k}`);
      if (r !== v) {
        out = out === node ? { ...node } : out;
        out[k] = r;
      }
    }
  }
  return out;
}

/**
 * Canonicalize a contracts payload (the object stored under `.data`).
 * Handles both key dialects (apiContract / api_contract). Returns
 * `{ data, changes }` — `data` is a new object only when something changed.
 */
export function canonicalizeContracts(data) {
  const changes = [];
  if (!data || typeof data !== 'object') return { data, changes };
  let out = data;
  for (const key of ['apiContract', 'api_contract']) {
    const next = canonicalizeApiContract(out[key], changes);
    if (next !== out[key]) out = { ...out, [key]: next };
  }
  for (const key of ['businessLogicContract', 'business_logic_contract']) {
    const next = canonicalizeBusinessLogic(out[key], changes);
    if (next !== out[key]) out = { ...out, [key]: next };
  }
  for (const key of ['dataModel', 'data_model']) {
    const next = canonicalizeVectorDims(out[key], changes);
    if (next !== out[key]) out = { ...out, [key]: next };
  }
  {
    const next = canonicalizeEmbeddingModels(out, changes, 'contract');
    if (next !== out) out = next;
  }
  if (process.env.AUTHZ_STAMP_DISABLED === 'true') {
    // Test/debug: strip explicit allowed_roles so the backend agent must infer
    // gates from prose (the pre-explicit-field behavior + what old envelopes
    // hit). Exercises the detect→repair backstop; the verifier still detects
    // via rule-parse. NOT for production use.
    const stripped = stripAllowedRoles(out, changes);
    if (stripped !== out) out = stripped;
  } else {
    const next = backfillAllowedRoles(out, changes);
    if (next !== out) out = next;
  }
  return { data: out, changes };
}

function stripAllowedRoles(data, changes) {
  const apiKey = data.apiContract !== undefined ? 'apiContract' : (data.api_contract !== undefined ? 'api_contract' : null);
  const endpoints = apiKey && data[apiKey]?.endpoints;
  if (!Array.isArray(endpoints)) return data;
  let touched = false;
  const next = endpoints.map((ep) => {
    if (!ep || !Array.isArray(ep.allowed_roles)) return ep;
    touched = true;
    const { allowed_roles, ...rest } = ep;
    return rest;
  });
  if (touched) changes.push('AUTHZ_STAMP_DISABLED: stripped allowed_roles (prose-only mode)');
  return touched ? { ...data, [apiKey]: { ...data[apiKey], endpoints: next } } : data;
}

// ── Per-endpoint allowed_roles backfill ─────────────────────────────────────
// Authz was expressed ONLY in prose business_logic rules, so the backend
// agent had to INFER which routes each rule covered and implement the gate on
// all of them — and it dropped routes (observed: a technician could POST /sops
// though the rules said quality_team only; the multipart upload handler was
// ungated). Stamping an explicit `allowed_roles` onto each restricted endpoint
// turns "infer routes from prose" into a mechanical "gate this route to these
// roles". The contract agent emits allowed_roles when it can; this is the
// deterministic backfill for the reliably-parseable "only <role(s)> can
// <METHODS> <path>" rules. Endpoints with an explicit allowed_roles are left
// as-is; only-owned/visibility rules and open ("all users") endpoints are not
// stamped (absent = unrestricted).
const ONLY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function backfillAllowedRoles(data, changes) {
  const apiKey = data.apiContract !== undefined ? 'apiContract' : (data.api_contract !== undefined ? 'api_contract' : null);
  if (!apiKey) return data;
  const apiContract = data[apiKey];
  const endpoints = apiContract?.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.length) return data;
  const blc = data.businessLogicContract || data.business_logic_contract;
  const rules = Array.isArray(blc?.rules) ? blc.rules.map(String) : [];
  if (!rules.length) return data;

  // Role vocabulary: every role named as role='X' anywhere in the rules.
  const vocab = new Set();
  for (const r of rules) for (const m of r.matchAll(/role\s*=?\s*['"]?([a-z][a-z0-9_]+)['"]?/gi)) vocab.add(m[1].toLowerCase());

  // Build METHOD path → allowed-role set from the restrictive ("only") rules.
  const gate = new Map();
  for (const rule of rules) {
    // Ownership rules ("… their own …") are row-level scoping, not role gates —
    // never stamp allowed_roles from them (see authz-matrix deriveExpectedRoles).
    if (/\b(their|his|her|its)\s+own\b|\bthemselves\b/i.test(rule)) continue;
    // Role EXCLUSION only: "only <clause> can/access" — "only" before the role
    // and verb, not "<role> can only <verb>".
    const only = rule.match(/\bonly\s+(.+?)\s+(?:can|may|are allowed to|is allowed to|access)\b/i);
    if (!only) continue;
    const clause = only[1];
    const methods = ONLY_METHODS.filter((m) => new RegExp(`\\b${m}\\b`, 'i').test(rule));
    const pathHint = [...rule.matchAll(/\/([a-z0-9_-]+)/gi)].map((m) => m[1].toLowerCase()).find((w) => !ONLY_METHODS.includes(w.toUpperCase())) || '';
    if (!pathHint) continue;
    const named = new Set();
    for (const m of clause.matchAll(/role\s*=?\s*['"]?([a-z][a-z0-9_]+)['"]?/gi)) named.add(m[1].toLowerCase());
    for (const v of vocab) if (new RegExp(`\\b${v.replace(/_/g, '[_\\s]?')}s?\\b`, 'i').test(clause)) named.add(v);
    if (!named.size) continue;
    for (const ep of endpoints) {
      if (!ep || !ep.method || !ep.path) continue;
      if (methods.length && !methods.includes(String(ep.method).toUpperCase())) continue;
      if (!String(ep.path).toLowerCase().includes(pathHint)) continue;
      const key = `${String(ep.method).toUpperCase()} ${ep.path}`;
      const prev = gate.get(key) || new Set();
      for (const n of named) prev.add(n);
      gate.set(key, prev);
    }
  }
  if (!gate.size) return data;

  let touched = false;
  const next = endpoints.map((ep) => {
    if (!ep || !ep.method || !ep.path || Array.isArray(ep.allowed_roles)) return ep;
    const set = gate.get(`${String(ep.method).toUpperCase()} ${ep.path}`);
    if (!set || !set.size) return ep;
    touched = true;
    changes.push(`${ep.method} ${ep.path}: +allowed_roles [${[...set].join(', ')}]`);
    return { ...ep, allowed_roles: [...set] };
  });
  return touched ? { ...data, [apiKey]: { ...apiContract, endpoints: next } } : data;
}
