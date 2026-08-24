/**
 * route-stub-generator.js — emits a deterministic Express route registration
 * module from the planner's `api_contract.endpoints[]` slice.
 *
 * Purpose: kill the router-mount and path-param-naming failure patterns by
 * construction. The subagent never writes route registrations; it only fills
 * in handler bodies. The generated file's paths + param names match the
 * contract LITERALLY, so the reconciler's literal-string comparator passes.
 *
 * Output shape:
 *
 *   // AUTO-GENERATED — DO NOT EDIT — emitted from api_contract
 *   import type { Express, Request, Response } from 'express';
 *   import type {
 *     PostTasksRequest, PostTasksResponse, GetTasksResponse,
 *     PatchTasksPRequest, PatchTasksPResponse, ...
 *   } from './contracts.js';
 *
 *   export function registerRoutes(app: Express): void {
 *     // GET /tasks — "List all tasks, newest first"
 *     app.get('/tasks', async (req: Request, res: Response<GetTasksResponse>) => {
 *       // TODO: implement handler
 *       res.status(501).json({} as GetTasksResponse);
 *     });
 *
 *     // PATCH /tasks/:p — "Update a task (completion status or title)"
 *     app.patch<{ p: string }>('/tasks/:p', async (req, res) => {
 *       // TODO: implement handler
 *       res.status(501).send();
 *     });
 *     ...
 *   }
 *
 * Pure JS — input contract object, output source string. Mirrors the shape +
 * defensive posture of `chat/server/agent/contract-types-generator.js`. No
 * runtime dependencies on the spike codebase.
 */

// IMPORTANT — visual framing of this header has measurable behavioral
// impact on the subagent. Earlier headers (`// SCAFFOLDED — fill in
// handler bodies; preserve signatures — emitted from api_contract` +
// `// Generated <ISO timestamp>`) pattern-matched in the LLM's training
// data to AUTO-GENERATED-DO-NOT-EDIT conventions, so the subagent left
// every handler body as the `res.status(501)` placeholder and still
// claimed `complete`. The harness's downstream gates (type-gate,
// reconciler, compose build, /health) all green-lit those runs because
// they validate code STRUCTURE, not handler-body content — net result:
// fake PASS where every endpoint returned 501.
//
// New header below leans hard on directive verbs and visible markers
// to make "this is editable" the first signal the model sees. No
// `// Generated <timestamp>` line — that was the strongest auto-
// generated signal. Reconciler still verifies route paths + methods
// match the contract; handler bodies are the subagent's job.
const HEADER_BLOCK = [
  '// =====================================================================',
  '// THIS FILE IS A SCAFFOLD — YOU MUST EDIT IT.',
  '// =====================================================================',
  '// Every handler body below is a `res.status(501).json(...)` placeholder.',
  '// REPLACE every one with a real implementation per the api_contract and',
  '// business_logic_contract you received in your spawn message.',
  '//',
  '// Editable: handler bodies (everything between `{` and `}`).',
  '// Locked:   route paths, HTTP methods, handler signature generics — the',
  '//           cross-scope reconciler reads those literally and rejects',
  '//           drift. Leave them byte-identical.',
  '//',
  '// This file is NOT in the `generated/` directory and is NOT auto-',
  '// regenerated. Once you edit it, your changes stick. There is no',
  '// other route file — register every endpoint here.',
  '// =====================================================================',
].join('\n');

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Generate the routes.ts source string for a contract.
 *
 * @param {{ endpoints: Array<object> }} apiContract
 * @returns {{ source: string, importedTypes: string[], routes: Array<{method, path, params, ident}> }}
 */
export function generateRouteStubs(apiContract) {
  const endpoints = Array.isArray(apiContract?.endpoints) ? apiContract.endpoints : [];

  const routes = endpoints.map(parseEndpoint).filter(Boolean);
  const importedTypes = collectTypeImports(routes);

  const lines = [];
  lines.push(HEADER_BLOCK);
  lines.push('');
  lines.push(`import type { Express, Request, Response } from 'express';`);
  if (importedTypes.length > 0) {
    lines.push(`import type {`);
    for (const t of importedTypes) lines.push(`  ${t},`);
    lines.push(`} from './generated/contracts.js';`);
  }
  lines.push('');
  lines.push(`export function registerRoutes(app: Express): void {`);

  for (const route of routes) {
    const purposeLine = route.purpose ? ` — "${route.purpose}"` : '';
    lines.push('');
    lines.push(`  // ${route.method.toUpperCase()} ${route.path}${purposeLine}`);
    lines.push(`  ${emitRouteCall(route)};`);
  }

  lines.push('}');
  lines.push('');

  return { source: lines.join('\n'), importedTypes, routes };
}

/**
 * Parse one endpoint contract entry into normalized form:
 *   { method, path, params: [{name}], requestType, responseType, ident, purpose }
 */
function parseEndpoint(ep) {
  if (!ep || typeof ep !== 'object') return null;
  if (typeof ep.method !== 'string' || typeof ep.path !== 'string') return null;

  const method = ep.method.toLowerCase(); // used for `app.<method>('<path>', ...)`
  const path = ep.path;
  const params = [];
  let m;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(path)) !== null) params.push({ name: m[1] });

  // Use the ORIGINAL method case for the type identifier so the imports
  // match what the spike's contract-types-generator emits (e.g. 'POST' →
  // 'POSTTasksRequest'). If we lowercase first, toPascal produces 'Post'
  // and the LLM ends up aliasing every import.
  const ident = endpointIdent(ep.method, path);
  const purpose = (typeof ep.purpose === 'string' ? ep.purpose : (ep.summary || '')).trim();

  const requestType = ep.request ? `${ident}Request` : null;
  const responseType = ep.response ? `${ident}Response` : null;

  return { method, path, params, ident, purpose, requestType, responseType };
}

/**
 * Build the per-route `app.<method>(...)` call. Type-safe params via
 * generic Request<{ ... }>, type-safe response via Response<TypeName>.
 */
function emitRouteCall(route) {
  const { method, path, params, requestType, responseType } = route;

  let reqGeneric;
  if (params.length > 0 && requestType) {
    const paramShape = '{ ' + params.map(p => `${p.name}: string`).join('; ') + ' }';
    reqGeneric = `Request<${paramShape}, ${responseType || 'unknown'}, ${requestType}>`;
  } else if (params.length > 0) {
    const paramShape = '{ ' + params.map(p => `${p.name}: string`).join('; ') + ' }';
    reqGeneric = `Request<${paramShape}>`;
  } else if (requestType) {
    reqGeneric = `Request<{}, ${responseType || 'unknown'}, ${requestType}>`;
  } else {
    reqGeneric = 'Request';
  }
  const resGeneric = responseType ? `Response<${responseType}>` : 'Response';

  const fallbackBody = responseType
    ? `res.status(501).json({} as ${responseType})`
    : 'res.status(501).send()';

  const body = [
    `app.${method}('${path}', async (req: ${reqGeneric}, res: ${resGeneric}) => {`,
    `    // REPLACE-ME — implement this handler. The line below is a placeholder.`,
    `    ${fallbackBody};`,
    `  })`,
  ].join('\n  ');

  return body;
}

/**
 * Convert (METHOD, /tasks/:p) → 'PatchTasksP'. Mirrors the same identifier
 * helper used by chat/server/agent/contract-types-generator.js:endpointIdent
 * so the Request/Response types we import line up with what the contract
 * types generator produces.
 */
export function endpointIdent(method, urlPath) {
  const cleaned = String(urlPath || '')
    .replace(/^\//, '')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '$1')
    .replace(/\{[^}]+\}/g, '')
    .replace(/\//g, '_')
    .replace(/[^A-Za-z0-9_]+/g, '_');
  return `${toPascal(method)}${toPascal(cleaned)}`;
}

function toPascal(s) {
  const raw = String(s || '');
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw)) {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return raw
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .split(/[_-]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'Anonymous';
}

function collectTypeImports(routes) {
  const set = new Set();
  for (const r of routes) {
    if (r.requestType) set.add(r.requestType);
    if (r.responseType) set.add(r.responseType);
  }
  return [...set].sort();
}