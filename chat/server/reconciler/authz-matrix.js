/**
 * authz-matrix — behavioral security-posture fingerprint of the running app.
 *
 * For every contracted endpoint × every role the app itself advertises
 * (whoami.availableRoles, the same source the dev-role-switcher uses), record
 * whether the role is DENIED (401/403) or can REACH the endpoint (any other
 * non-5xx). Persisted per build; diffed across iterates.
 *
 * Why: an ordinary add-feature iterate was observed to silently REMOVE a
 * role gate (operator POST on an admin surface went 403 → 201) and nothing
 * in the pipeline noticed — the endpoint probe treats both as "pass". The
 * matrix makes every posture change knowable:
 *   denied→reachable  = privilege EXPANSION (the dangerous direction)
 *   reachable→denied  = tightening / possibly broken flow
 *   added/removed     = new surface arrives with an explicit posture
 *
 * Deliberately warn-only (v1): an auto-revert would be wrong whenever the
 * user ASKED for the relaxation. The consumer decides how loud to be.
 */

import { deriveSamplePayload } from './endpoint-probe.js';

const DEFAULT_TIMEOUT_MS = 6_000;

function personaHeader(role) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = { sub: `dev-${role}`, email: `dev+${role}@localhost`, name: `AuthzProbe (${role})`, role, dev: true };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

function classify(status, { hasParams = false } = {}) {
  if (status === 401 || status === 403) return 'denied';
  if (status >= 500 || status === 0) return 'error';
  // 404 on a PARAMETERLESS path means the route itself is gone (observed:
  // a removal iterate deleted /equipment routes wholesale; classifying that
  // as 'reachable' turned route-deletion into a phantom privilege
  // expansion). On :id paths 404 keeps row-not-found semantics.
  if (status === 404 && !hasParams) return 'absent';
  return 'reachable';
}

async function request(fetchImpl, url, { method, role, body, timeoutMs }) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-amzn-oidc-data': personaHeader(role) },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    return 0;
  }
}

/** The app's advertised roles, from its own whoami (behavioral source). */
export async function discoverRoles({ baseUrl, apiContract, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const whoami = (apiContract?.endpoints || []).find(
    (e) => String(e.method).toUpperCase() === 'GET' && /whoami|^\/me$/i.test(String(e.path || '')));
  if (!whoami) return null;
  try {
    const res = await fetchImpl(`${baseUrl}/api${whoami.path}`, {
      headers: { 'x-amzn-oidc-data': personaHeader('authz-probe') },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (Array.isArray(json?.availableRoles) && json.availableRoles.length >= 2) return json.availableRoles;
    return json?.role ? [String(json.role)] : null;
  } catch {
    return null;
  }
}

/**
 * Probe every contracted endpoint with every role. Returns
 * { roles, entries: { "METHOD path": { [role]: 'denied'|'reachable'|'error' } } }
 * or null when roles can't be discovered (no whoami / app down).
 */
export async function buildAuthzMatrix({ baseUrl, apiContract, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const endpoints = apiContract?.endpoints || [];
  const roles = await discoverRoles({ baseUrl, apiContract, fetchImpl, timeoutMs });
  if (!roles || roles.length === 0) return null;

  const entries = {};
  for (const ep of endpoints) {
    const method = String(ep.method || '').toUpperCase();
    const path = String(ep.path || '');
    if (!method || !path || /whoami|^\/me$|health/i.test(path)) continue;
    const hasParams = /:[A-Za-z_]+/.test(path);
    const concrete = path.replace(/:[A-Za-z_]+/g, '1');
    const body = (method !== 'GET' && method !== 'DELETE') ? deriveSamplePayload(ep.request) : null;
    const key = `${method} ${path}`;
    entries[key] = {};
    for (const role of roles) {
      const status = await request(fetchImpl, `${baseUrl}/api${concrete}`, { method, role, body, timeoutMs });
      entries[key][role] = classify(status, { hasParams });
    }
  }
  return { roles, entries };
}

/**
 * Derive each endpoint's EXPECTED allowed-role set from the business_logic
 * rules — the ground truth the observed posture is checked against. Only
 * rules matching a confident, structured pattern contribute; anything vague
 * is left unconstrained (no expected set → the verifier skips that endpoint,
 * so a mis-parse can never produce a false "you should have gated this").
 *
 * Recognized rule shapes (case-insensitive), where the role clause names one
 * or more roles ("role='qa'", "admins", "quality_team and admins"):
 *   "Only <role-clause> can <METHODS?> <path…>"     → allowed = those roles
 *   "All authenticated users can <METHODS?> <path>" → allowed = every role
 *   "Everyone / any user can <path>"                → allowed = every role
 *
 * @returns Map<"METHOD path", Set<role>>  — only endpoints a rule constrained
 */
export function deriveExpectedRoles({ apiContract, businessLogic, roles }) {
  const rules = Array.isArray(businessLogic?.rules) ? businessLogic.rules : [];
  const allRoles = new Set(roles || []);
  const endpoints = (apiContract?.endpoints || [])
    .filter((e) => e && e.method && e.path)
    .map((e) => ({ method: String(e.method).toUpperCase(), path: String(e.path), allowed_roles: e.allowed_roles }));
  const expected = new Map();

  // Explicit per-endpoint allowed_roles (stamped by the canonicalizer or
  // emitted by the contract agent) is authoritative — it removed the prose→
  // route inference that dropped gates. Rule-parsing below only fills the gaps.
  const explicitKeys = new Set();
  for (const ep of endpoints) {
    if (Array.isArray(ep.allowed_roles) && ep.allowed_roles.length) {
      const key = `${ep.method} ${ep.path}`;
      expected.set(key, new Set(ep.allowed_roles.map((r) => String(r).toLowerCase())));
      explicitKeys.add(key);
    }
  }

  const rolesFromClause = (clause) => {
    const named = new Set();
    for (const m of clause.matchAll(/role\s*=?\s*['"]?([a-z][a-z0-9_]+)['"]?/gi)) named.add(m[1].toLowerCase());
    // Bare role words present in the app's role enum (e.g. "admins", "quality team").
    for (const r of allRoles) {
      const re = new RegExp(`\\b${r.replace(/[_\s]+/g, '[_\\s]?')}s?\\b`, 'i');
      if (re.test(clause)) named.add(r);
    }
    return named;
  };

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const applyToMatching = (methodsInRule, pathHint, allowSet) => {
    for (const ep of endpoints) {
      if (methodsInRule.length && !methodsInRule.includes(ep.method)) continue;
      if (pathHint && !ep.path.toLowerCase().includes(pathHint)) continue;
      const key = `${ep.method} ${ep.path}`;
      if (explicitKeys.has(key)) continue; // explicit allowed_roles is authoritative — never widen it
      const prev = expected.get(key) || new Set();
      for (const r of allowSet) prev.add(r);
      expected.set(key, prev);
    }
  };

  for (const raw of rules) {
    const rule = String(raw || '');
    const methodsInRule = METHODS.filter((m) => new RegExp(`\\b${m}\\b`, 'i').test(rule));
    // Extract the RESOURCE path, skipping slash-joined method tokens
    // ("POST/PUT/DELETE /sops" yields /PUT, /DELETE, /sops — only /sops is a path).
    const pathHint = [...rule.matchAll(/\/([a-z0-9_-]+)/gi)]
      .map((m) => m[1].toLowerCase())
      .find((w) => !METHODS.includes(w.toUpperCase())) || '';
    if (!pathHint && !methodsInRule.length) continue; // not endpoint-specific

    // OPEN access wins first: "all authenticated users can <METHOD> <path>" —
    // even when the rule ALSO mentions a trailing ownership clause ("… and GET
    // their own history"), the open clause is what gates the endpoint.
    if (/\b(all authenticated users|all users|everyone|any (authenticated )?user)\b/i.test(rule)) {
      applyToMatching(methodsInRule, pathHint, allRoles);
      continue;
    }
    // OWNERSHIP/visibility rules ("… their own …") are row-level scoping, NOT
    // role gates — "operators can only view their own deviations" does NOT
    // forbid qa_lead/admin. Mis-reading them restricts every endpoint the
    // rule's path touches and fires false repair dispatches (observed live on
    // deviation-tracker: 6 phantom violations + 2 wasted backend fixes).
    if (/\b(their|his|her|its)\s+own\b|\bthemselves\b/i.test(rule)) continue;
    // Role EXCLUSION only: "only <role-clause> can/may/access …" — "only" must
    // precede the role and the verb (a gate), never "<role> can only <verb>"
    // (a scope limit, which the ownership guard above also catches).
    const only = rule.match(/\bonly\s+(.+?)\s+(?:can|may|are allowed to|is allowed to|access)\b/i);
    if (!only) continue;
    const named = rolesFromClause(only[1]);
    if (named.size) applyToMatching(methodsInRule, pathHint, named);
  }
  return expected;
}

/**
 * Verify OBSERVED posture against the EXPECTED allowed-role sets. A role that
 * can REACH an endpoint it isn't allowed on is a gate MISS (privilege
 * violation — the class that let a technician upload an SOP). Denials of an
 * allowed role are reported separately (over-restriction, lower severity).
 * Only endpoints with a derived expectation are judged.
 *
 * @returns { violations: [{endpoint, role}], overRestrictions: [{endpoint, role}] }
 */
export function verifyAuthzAgainstRules(matrix, expected) {
  const out = { violations: [], overRestrictions: [] };
  if (!matrix || !expected || expected.size === 0) return out;
  for (const [key, allowed] of expected) {
    const posture = matrix.entries[key];
    if (!posture) continue;
    for (const role of matrix.roles) {
      const p = posture[role];
      if (p === 'error' || p === 'absent') continue;
      const isAllowed = allowed.has(String(role).toLowerCase()) || allowed.has(role);
      if (p === 'reachable' && !isAllowed) out.violations.push({ endpoint: key, role });
      if (p === 'denied' && isAllowed) out.overRestrictions.push({ endpoint: key, role });
    }
  }
  return out;
}

/** Human summary of a rules-verification result — empty when clean. */
export function formatAuthzViolations(v) {
  const lines = [];
  for (const x of v.violations) {
    lines.push(`- GATE MISSING: role \`${x.role}\` can reach \`${x.endpoint}\` but the business rules forbid it`);
  }
  for (const x of v.overRestrictions) {
    lines.push(`- over-restricted: role \`${x.role}\` is denied \`${x.endpoint}\` but the rules allow it`);
  }
  return lines.join('\n');
}

/**
 * Posture diff between two matrices. Transitions involving 'error' are
 * excluded (unknown, not a posture claim). Roles compared are the
 * intersection — a renamed role set shows up via added/removed instead.
 */
export function diffAuthzMatrix(prev, next) {
  const out = { expansions: [], tightenings: [], added: [], removed: [], unserved: [] };
  if (!prev || !next) return out;
  const prevKeys = new Set(Object.keys(prev.entries || {}));
  const nextKeys = new Set(Object.keys(next.entries || {}));
  const roles = (next.roles || []).filter((r) => (prev.roles || []).includes(r));
  const served = (m, key) => (m.roles || []).some((r) => m.entries[key]?.[r] === 'denied' || m.entries[key]?.[r] === 'reachable');
  const reachableBy = (m, key) => (m.roles || []).filter((r) => m.entries[key]?.[r] === 'reachable');

  for (const key of nextKeys) {
    if (!prevKeys.has(key)) {
      out.added.push({ endpoint: key, reachableBy: reachableBy(next, key) });
      continue;
    }
    // Route-level serving state first: a deleted route 404s for EVERY role,
    // which is contract drift, not a per-role posture change (observed: a
    // removal iterate deleted /equipment wholesale and the per-role diff
    // misread it as a privilege expansion).
    const wasServed = served(prev, key);
    const isServed = served(next, key);
    if (wasServed && !isServed) { out.unserved.push({ endpoint: key }); continue; }
    if (!wasServed && isServed) { out.added.push({ endpoint: key, reachableBy: reachableBy(next, key), restored: true }); continue; }
    for (const role of roles) {
      const before = prev.entries[key]?.[role];
      const after = next.entries[key]?.[role];
      if (!before || !after || before === after) continue;
      if (before === 'error' || after === 'error' || before === 'absent' || after === 'absent') continue;
      if (before === 'denied' && after === 'reachable') out.expansions.push({ endpoint: key, role });
      if (before === 'reachable' && after === 'denied') out.tightenings.push({ endpoint: key, role });
    }
  }
  for (const key of prevKeys) {
    if (!nextKeys.has(key)) out.removed.push({ endpoint: key });
  }
  return out;
}

/** Human summary of a diff — empty string when nothing changed. */
export function formatAuthzDiff(diff) {
  const lines = [];
  for (const e of diff.expansions) {
    lines.push(`- PRIVILEGE EXPANSION: \`${e.endpoint}\` is now reachable by role \`${e.role}\` (was denied before this change)`);
  }
  for (const t of diff.tightenings) {
    lines.push(`- tightened: \`${t.endpoint}\` now denies role \`${t.role}\` (was reachable)`);
  }
  for (const a of diff.added) {
    lines.push(`- new endpoint: \`${a.endpoint}\` — reachable by: ${a.reachableBy.length ? a.reachableBy.map((r) => `\`${r}\``).join(', ') : 'no probed role'}`);
  }
  for (const r of diff.removed) {
    lines.push(`- removed endpoint: \`${r.endpoint}\``);
  }
  for (const u of diff.unserved || []) {
    lines.push(`- no longer served: \`${u.endpoint}\` — the app 404s it for every role but the contract still lists it (an intended removal should be declared via remove_endpoints in the iterate diff)`);
  }
  return lines.join('\n');
}