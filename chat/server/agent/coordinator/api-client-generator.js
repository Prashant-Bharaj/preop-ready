/**
 * api-client-generator.js — emits `frontend/src/generated/api-client.ts`,
 * a typed fetch wrapper per `api_contract.endpoint`.
 *
 * Each endpoint becomes a single exported async function with the request
 * + response types from `contracts.ts`. The URL path includes the `/api/`
 * prefix (Traefik convention — backend sees stripped paths, frontend
 * calls always include `/api/`). Path params are typed function args.
 *
 * Locks down what the LLM previously hand-wrote and got wrong:
 *   - URL paths (no /api/ drift)
 *   - HTTP method per endpoint
 *   - Request body type (the LLM can't pass a wrong shape — tsc catches it)
 *   - Response type (no manual re-shaping)
 *
 * Frontend code calls e.g. `await postTasks({ title: 'foo' })` instead of
 * writing `fetch('/api/tasks', { method: 'POST', body: JSON.stringify(...) })`.
 */

import { endpointIdent } from './route-stub-generator.js';

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;
// Same heuristic as endpoint-probe.js — endpoints that hit MGA at runtime.
const AI_PATH_RE = /(chat|ask|question|generate|summar|analy|recommend|suggest|embed|assist|ai)/i;

export function generateApiClient(apiContract) {
  const endpoints = Array.isArray(apiContract?.endpoints) ? apiContract.endpoints : [];
  if (endpoints.length === 0) return null;

  const fns = endpoints.map(parseEndpoint).filter(Boolean);
  const importedTypes = new Set();
  for (const fn of fns) {
    // Only import the request type when the function signature will actually
    // use it (POST/PUT/PATCH have a body arg; GET/DELETE/HEAD don't). Otherwise
    // tsc's `noUnusedLocals` flags the import as an error and the subagent
    // can't fix it — the file is harness-managed (writes are blocked).
    const hasBody = fn.requestType && ['POST', 'PUT', 'PATCH'].includes(fn.method);
    if (hasBody) importedTypes.add(fn.requestType);
    if (fn.responseType) importedTypes.add(fn.responseType);
  }

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — emitted from api_contract`);
  lines.push(`// Generated ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Typed fetch wrappers for every api_contract endpoint. Import and call`);
  lines.push(` * these from your component event handlers and effects. Do NOT write`);
  lines.push(` * raw fetch calls against the same paths; the URL paths, methods, and`);
  lines.push(` * types are locked to the contract here so any drift surfaces at`);
  lines.push(` * compile time.`);
  lines.push(` */`);
  if (importedTypes.size > 0) {
    lines.push(`import type {`);
    for (const t of [...importedTypes].sort()) lines.push(`  ${t},`);
    lines.push(`} from './contracts.js';`);
    lines.push('');
  }

  lines.push(`export interface ApiClientError extends Error {`);
  lines.push(`  status: number;`);
  lines.push(`  body: unknown;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`// Local-dev persona: DevRoleSwitcher stores a role in localStorage and every`);
  lines.push(`// request carries a synthetic x-amzn-oidc-data token for it — the SAME header`);
  lines.push(`// production identity uses. Safe in production by construction: the ALB`);
  lines.push(`// overwrites all x-amzn-oidc-* headers, so synthetic tokens never reach a`);
  lines.push(`// deployed app (reference/user-identity.md).`);
  lines.push(`export function devPersonaHeaders(): Record<string, string> {`);
  lines.push(`  const role = typeof localStorage !== 'undefined' ? localStorage.getItem('dev-role') : null;`);
  lines.push(`  if (!role) return {};`);
  lines.push(`  const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');`);
  lines.push(`  const payload = { sub: \`dev-\${role}\`, email: \`dev+\${role}@localhost\`, name: \`Dev (\${role})\`, role, dev: true };`);
  lines.push(`  return { 'x-amzn-oidc-data': \`\${b64url({ alg: 'none', typ: 'JWT' })}.\${b64url(payload)}.\` };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`// Every call carries a timeout so a dead backend surfaces as a catchable`);
  lines.push(`// error instead of an infinite spinner. AI endpoints get a longer budget.`);
  lines.push(`const API_TIMEOUT_MS = 15000;`);
  lines.push(`const API_AI_TIMEOUT_MS = 60000;`);
  lines.push('');
  lines.push(`async function callApi<TRes>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<TRes> {`);
  lines.push(`  const { timeoutMs, ...rest } = init;`);
  lines.push(`  let res: Response;`);
  lines.push(`  try {`);
  lines.push(`    res = await fetch(url, {`);
  lines.push(`      ...rest,`);
  lines.push(`      headers: { 'Content-Type': 'application/json', ...devPersonaHeaders(), ...(rest.headers || {}) },`);
  lines.push(`      signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? API_TIMEOUT_MS),`);
  lines.push(`    });`);
  lines.push(`  } catch (cause) {`);
  lines.push(`    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';`);
  lines.push(`    const err = new Error(timedOut`);
  lines.push(`      ? \`API \${rest.method || 'GET'} \${url} timed out — the server may be down or overloaded\``);
  lines.push(`      : \`API \${rest.method || 'GET'} \${url} unreachable — is the backend running?\`) as ApiClientError;`);
  lines.push(`    err.status = 0;`);
  lines.push(`    err.body = null;`);
  lines.push(`    throw err;`);
  lines.push(`  }`);
  lines.push(`  let body: unknown = null;`);
  lines.push(`  const text = await res.text();`);
  lines.push(`  if (text) {`);
  lines.push(`    try { body = JSON.parse(text); } catch { body = text; }`);
  lines.push(`  }`);
  lines.push(`  if (!res.ok) {`);
  lines.push(`    const err = new Error(\`API \${init.method || 'GET'} \${url} failed: HTTP \${res.status}\`) as ApiClientError;`);
  lines.push(`    err.status = res.status;`);
  lines.push(`    err.body = body;`);
  lines.push(`    throw err;`);
  lines.push(`  }`);
  lines.push(`  return body as TRes;`);
  lines.push(`}`);
  lines.push('');

  for (const fn of fns) {
    emitFunction(fn, lines);
  }

  return { source: lines.join('\n'), functions: fns.map(f => f.fnName) };
}

function parseEndpoint(ep) {
  if (!ep || typeof ep.method !== 'string' || typeof ep.path !== 'string') return null;

  const method = ep.method.toUpperCase();
  const path = ep.path;
  const ident = endpointIdent(ep.method, ep.path); // matches contracts.ts naming
  const fnName = lowerFirst(ident); // POSTTasks → pOSTTasks; use `${method.toLowerCase()}${Path}` instead
  // Better: methodNameCamel + path-pascal
  const fnNameClean = ep.method.toLowerCase() + ident.slice(method.length);

  const params = [];
  PARAM_RE.lastIndex = 0;
  let m;
  while ((m = PARAM_RE.exec(path)) !== null) params.push(m[1]);

  const requestType = ep.request ? `${ident}Request` : null;
  const responseType = ep.response ? `${ident}Response` : null;

  const purpose = (typeof ep.purpose === 'string' ? ep.purpose : '').trim();

  return { method, path, params, ident, fnName: fnNameClean, requestType, responseType, purpose };
}

function emitFunction(fn, lines) {
  const { method, path, params, requestType, responseType, fnName, purpose } = fn;

  // Build the function args:
  //   - one param per path-param (typed string)
  //   - one `body: <ReqType>` when method is POST/PUT/PATCH and request is shaped
  //   - one `query?: Record<string, string | number>` (always optional) for query-string apps
  const args = [];
  for (const p of params) args.push(`${p}: string`);
  const hasBody = requestType && ['POST', 'PUT', 'PATCH'].includes(method);
  if (hasBody) args.push(`body: ${requestType}`);
  args.push(`query?: Record<string, string | number>`);

  const resType = responseType || 'void';
  const purposeLine = purpose ? `  // ${method} ${path} — "${purpose}"` : `  // ${method} ${path}`;

  lines.push(purposeLine);
  lines.push(`export async function ${fnName}(${args.join(', ')}): Promise<${resType}> {`);

  // Build URL: interpolate path params, then append /api prefix, then query.
  let urlBuilder = `'/api${escapePathLiteral(path)}'`;
  if (params.length > 0) {
    // template-string interpolation
    let tpl = '`/api';
    let cur = 0;
    PARAM_RE.lastIndex = 0;
    let m;
    while ((m = PARAM_RE.exec(path)) !== null) {
      tpl += path.slice(cur, m.index);
      tpl += '${encodeURIComponent(' + m[1] + ')}';
      cur = m.index + m[0].length;
    }
    tpl += path.slice(cur);
    tpl += '`';
    urlBuilder = tpl;
  }

  lines.push(`  let url = ${urlBuilder};`);
  lines.push(`  if (query) {`);
  lines.push(`    const qs = new URLSearchParams();`);
  lines.push(`    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));`);
  lines.push(`    const str = qs.toString();`);
  lines.push(`    if (str) url += (url.includes('?') ? '&' : '?') + str;`);
  lines.push(`  }`);

  const initParts = [`method: '${method}'`];
  if (hasBody) initParts.push(`body: JSON.stringify(body)`);
  // AI-backed endpoints (same heuristic as the endpoint probe) wait on an
  // MGA round-trip — give them the longer timeout budget.
  if (AI_PATH_RE.test(path)) initParts.push(`timeoutMs: API_AI_TIMEOUT_MS`);
  lines.push(`  return callApi<${resType}>(url, { ${initParts.join(', ')} });`);
  lines.push(`}`);
  lines.push('');
}

function lowerFirst(s) {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function escapePathLiteral(p) {
  return String(p || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}