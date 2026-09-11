/**
 * app-client — HTTP driver for the GENERATED app (localhost:8080), with the
 * same synthetic dev-persona identity header the browser sends. The 3-action
 * tests run through this: real requests, real data, real answers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness-client.mjs';

export const APP_URL = process.env.BENCH_APP_URL || 'http://localhost:8080';

export function personaHeader(role) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = { sub: `dev-${role}`, email: `dev+${role}@localhost`, name: `Bench (${role})`, role, dev: true };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

/**
 * Persona warm-up: a real browser session calls GET /whoami on app load,
 * which is where contract-conformant apps run their first-login trigger
 * (create users row, set role from roleClaim). A bench persona whose FIRST
 * request is a role-gated action hits "unknown user" 403s a real user never
 * sees. Warm each persona once per app; reset between scenarios/regressions.
 */
const warmedPersonas = new Set();
export function resetPersonaWarmup() { warmedPersonas.clear(); }

async function warmPersona(role) {
  if (warmedPersonas.has(role)) return;
  warmedPersonas.add(role);
  const p = discover('GET', /whoami|^\/me$|profile/i);
  if (!p) return;
  try {
    await fetch(`${APP_URL}/api${p}`, {
      headers: { 'x-amzn-oidc-data': personaHeader(role) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch { /* warm-up is best-effort — the action itself asserts */ }
}

/**
 * Call the generated app's API. Returns { status, json, text, ms }.
 * Never throws on HTTP errors — assertions decide what's acceptable.
 */
export async function api(method, apiPath, { role = 'admin', body = null, timeoutMs = 90_000 } = {}) {
  await warmPersona(role);
  const t0 = Date.now();
  try {
    const res = await fetch(`${APP_URL}/api${apiPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-amzn-oidc-data': personaHeader(role) },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message || err), ms: Date.now() - t0 };
  }
}

/** The app's contract — used to DISCOVER endpoint naming instead of pinning it. */
export function contractEndpoints() {
  try {
    const env = JSON.parse(fs.readFileSync(path.join(ROOT, '.harness', 'contracts.json'), 'utf-8'));
    return env?.data?.apiContract?.endpoints || env?.data?.api_contract?.endpoints || [];
  } catch { return []; }
}

/**
 * Find a contract endpoint by method + path regex. Returns the path with
 * `:param` placeholders intact, or null. Keeps scenarios naming-agnostic:
 * the agent may call it /equipment or /equipment-items — behavior is what
 * we assert, not the noun.
 */
export function discover(method, pathRe) {
  const ep = contractEndpoints().find((e) => e.method === method.toUpperCase() && pathRe.test(e.path));
  return ep ? ep.path : null;
}

/** Like discover(), but returns the full endpoint object (path + request spec). */
export function discoverEp(method, pathRe) {
  return contractEndpoints().find((e) => e.method === method.toUpperCase() && pathRe.test(e.path)) || null;
}

/** ALL endpoints matching method + path regex — for callers that must
 * disambiguate among sibling routes (e.g. POST /analyses/analyze vs
 * POST /analyses; first-match discovery returned the same endpoint for
 * both the analyze and save roles, silently skipping the save step). */
export function discoverAllEp(method, pathRe) {
  return contractEndpoints().filter((e) => e.method === method.toUpperCase() && pathRe.test(e.path));
}

export const fill = (p, params) => p.replace(/:([A-Za-z_]+)/g, (_, k) => String(params[k] ?? params.id ?? '1'));

/**
 * Build a request body from the CONTRACT's request spec instead of guessing.
 * Spec shape per field: "number required", "string optional (A|B|C)", ...
 * Enum literals in parens win; `overrides` win over everything; optional
 * fields are omitted unless overridden. Marker lands in text-ish fields so
 * downstream assertions (search/CSV) can find the row.
 */
/**
 * Mirror of contract-canonicalizer's flat-spec explosion, for envelopes
 * written before it existed: a request spec of the shape
 * { content_type: "...", fields: "a number required, b string optional" }
 * becomes per-field entries; content_type meta-keys are dropped.
 */
export function explodeSpec(spec = {}) {
  const out = {};
  for (const [field, desc] of Object.entries(spec || {})) {
    if (/^content[_-]?type$/i.test(field)) continue;
    if (typeof desc === 'string' && desc.includes(',')) {
      const clauses = desc.split(',').map((s) => s.trim()).filter(Boolean);
      const parsed = clauses.map((cl) => /^([A-Za-z_][A-Za-z0-9_]*)\s+((?:string|number|int|integer|float|bool|boolean|file|date|datetime|text|json|array|object)\b.*)$/i.exec(cl));
      if (clauses.length > 1 && parsed.every(Boolean)) {
        for (const m of parsed) out[m[1]] = m[2];
        continue;
      }
    }
    out[field] = desc;
  }
  return out;
}

export function payloadFromSpec(spec = {}, { marker = 'bench', overrides = {} } = {}) {
  // Scenarios shotgun naming variants in overrides (duration/minutes/
  // duration_minutes) to survive contract variance — but strict-validating
  // apps (zod .strict()) reject unknown keys, so only variants the CONTRACT
  // declares may reach the wire. With an empty/unknown spec, pass overrides
  // through untouched (nothing to filter against).
  const exploded = explodeSpec(spec);
  const specKeys = Object.keys(exploded);
  const effectiveOverrides = specKeys.length
    ? Object.fromEntries(Object.entries(overrides).filter(([k]) => k in exploded))
    : overrides;
  const body = {};
  for (const [field, desc] of Object.entries(exploded)) {
    if (field in effectiveOverrides) continue;
    const d = String(desc || '');
    if (/optional/i.test(d)) continue;
    // FK-shaped fields (*_id) are only safe to send when the caller provides
    // them or the contract says required — a guessed id into an empty table
    // fails FK validation (or 500s). Specs that mark only required fields
    // ("number" vs "number required") land here too.
    if (/_id$/.test(field) && !/required/i.test(d)) continue;
    if (/file\[?\]?|multipart/i.test(d)) continue;
    const enumMatch = /\(([^)]+\|[^)]+)\)/.exec(d);
    if (enumMatch) { body[field] = enumMatch[1].split('|')[0].trim(); continue; }
    if (/number|integer|\bint\b|float|decimal/i.test(d)) { body[field] = 1; continue; }
    if (/bool/i.test(d)) { body[field] = true; continue; }
    if (/date|timestamp/i.test(d) || /_date$|^date|_at$/i.test(field)) { body[field] = '2026-07-14'; continue; }
    body[field] = /desc|note|text|comment|name|title/i.test(field) ? `Bench ${field} ${marker}` : `bench-${marker}`;
  }
  return { ...body, ...effectiveOverrides };
}

/**
 * Required *_id fields are FK references — satisfy them the way a real user
 * would: create the parent row first (as admin, via the contract's matching
 * POST endpoint) and use its id. `equipment_id` → POST /equipment,
 * `root_cause_category_id` → POST /root-cause-categories (singular/plural,
 * snake/kebab tolerated). Depth-capped: parents may have required FKs too.
 * No endpoint found → leave it to payloadFromSpec's fallback.
 */
async function resolveFkDeps(spec, { marker, overrides, depth }) {
  const resolved = {};
  for (const [field, desc] of Object.entries(explodeSpec(spec))) {
    if (!/_id$/.test(field) || field in overrides) continue;
    if (typeof desc !== 'string' || !/required/i.test(desc)) continue;
    const parts = field.replace(/_id$/, '').split('_');
    parts[parts.length - 1] = parts[parts.length - 1].replace(/y$/, '');
    const ep = discoverEp('POST', new RegExp(parts.join('[-_]?'), 'i'));
    if (!ep) continue;
    const parent = await apiSmart('POST', ep.path, { role: 'admin', spec: ep.request, marker, depth: depth + 1 });
    const id = parent.json?.id ?? Object.values(parent.json || {}).find((v) => v && typeof v === 'object' && v.id != null)?.id;
    // Apps that return string ids still FK-validate numerically — coerce.
    if (id != null) resolved[field] = /^\d+$/.test(String(id)) ? Number(id) : id;
  }
  return resolved;
}

/**
 * api() + one adaptive retry per enum-validation rejection: a well-behaved
 * app's 400 names the expected values ("Invalid enum value. Expected 'Low' |
 * 'Medium'..."). Reading them off the error is behavior-driven — the app is
 * the authority on its own enums. Max 3 field corrections.
 */
export async function apiSmart(method, apiPath, { role, spec = null, marker = 'bench', overrides = {}, timeoutMs, depth = 0 } = {}) {
  const fkDeps = depth < 2 && spec ? await resolveFkDeps(spec, { marker, overrides, depth }) : {};
  let body = payloadFromSpec(spec || {}, { marker, overrides: { ...fkDeps, ...overrides } });
  let res = await api(method, apiPath, { role, body, timeoutMs });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (res.status !== 400 || !res.json?.fields?.fieldErrors) break;
    const entries = Object.entries(res.json.fields.fieldErrors);
    let corrected = false;
    for (const [field, errs] of entries) {
      const s = String(errs);
      // Type-coercion retry: "Expected number, received string" (and the
      // reverse) — the app names the type it wants; send it.
      if (/Expected number.*received string/i.test(s) && /^\d+(\.\d+)?$/.test(String(body[field] ?? ''))) {
        body[field] = Number(body[field]); corrected = true; continue;
      }
      if (/Expected number/i.test(s) && typeof body[field] !== 'number') {
        body[field] = 1; corrected = true; continue;
      }
      if (/Expected string.*received number/i.test(s)) {
        body[field] = String(body[field]); corrected = true; continue;
      }
      // Format-adaptive retry: the app names the exact shape it wants
      // ("Must be YYYY-MM-DD" / ISO 8601). Behavior-driven, same spirit as
      // the enum retry below.
      if (/YYYY-MM-DDTHH|ISO ?8601/i.test(s)) {
        if (body[field] !== '2026-07-14T09:00:00.000Z') { body[field] = '2026-07-14T09:00:00.000Z'; corrected = true; }
        continue;
      }
      if (/YYYY-?MM/i.test(s)) {
        if (body[field] !== '2026-07-14') { body[field] = '2026-07-14'; corrected = true; }
        continue;
      }
      if (!/Expected/i.test(s)) continue;
      // Prefer the named value that MEANS what we sent ('Under Review' →
      // 'under_review') — the first listed value is often the initial state
      // of a workflow, and blindly taking it turns a format mismatch into an
      // invalid transition.
      const candidates = [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((c) => c !== body[field]);
      if (!candidates.length) continue;
      const norm = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const pick = candidates.find((c) => norm(c) === norm(body[field])) ?? candidates[0];
      if (body[field] !== pick) { body[field] = pick; corrected = true; }
    }
    if (!corrected) break;
    res = await api(method, apiPath, { role, body, timeoutMs });
  }
  return { ...res, sentBody: body };
}

/** Multipart upload (RAG document ingestion, photo attachments). */
export async function apiUpload(apiPath, { role = 'admin', fields = {}, file, fileField = 'file', timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  try {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    if (file) fd.append(fileField, new Blob([file.content], { type: file.type || 'text/plain' }), file.name);
    const res = await fetch(`${APP_URL}/api${apiPath}`, {
      method: 'POST',
      headers: { 'x-amzn-oidc-data': personaHeader(role) },
      body: fd,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message || err), ms: Date.now() - t0 };
  }
}
