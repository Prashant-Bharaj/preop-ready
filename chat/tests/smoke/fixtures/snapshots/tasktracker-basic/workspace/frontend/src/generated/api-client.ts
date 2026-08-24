// AUTO-GENERATED — DO NOT EDIT — emitted from api_contract
// Generated 2026-05-25T18:05:13.360Z

/**
 * Typed fetch wrappers for every api_contract endpoint. Import and call
 * these from your component event handlers and effects. Do NOT write
 * raw fetch calls against the same paths; the URL paths, methods, and
 * types are locked to the contract here so any drift surfaces at
 * compile time.
 */
import type {
  DELETETasksIdResponse,
  GETTasksResponse,
  GETWhoamiResponse,
  POSTTasksRequest,
  POSTTasksResponse,
  PUTTasksIdRequest,
  PUTTasksIdResponse,
} from './contracts.js';

export interface ApiClientError extends Error {
  status: number;
  body: unknown;
}

async function callApi<TRes>(url: string, init: RequestInit): Promise<TRes> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const err = new Error(`API ${init.method || 'GET'} ${url} failed: HTTP ${res.status}`) as ApiClientError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as TRes;
}

  // GET /whoami
export async function getWhoami(query?: Record<string, string | number>): Promise<GETWhoamiResponse> {
  let url = '/api/whoami';
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    const str = qs.toString();
    if (str) url += (url.includes('?') ? '&' : '?') + str;
  }
  return callApi<GETWhoamiResponse>(url, { method: 'GET' });
}

  // GET /tasks
export async function getTasks(query?: Record<string, string | number>): Promise<GETTasksResponse> {
  let url = '/api/tasks';
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    const str = qs.toString();
    if (str) url += (url.includes('?') ? '&' : '?') + str;
  }
  return callApi<GETTasksResponse>(url, { method: 'GET' });
}

  // POST /tasks
export async function postTasks(body: POSTTasksRequest, query?: Record<string, string | number>): Promise<POSTTasksResponse> {
  let url = '/api/tasks';
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    const str = qs.toString();
    if (str) url += (url.includes('?') ? '&' : '?') + str;
  }
  return callApi<POSTTasksResponse>(url, { method: 'POST', body: JSON.stringify(body) });
}

  // PUT /tasks/:id
export async function putTasksId(id: string, body: PUTTasksIdRequest, query?: Record<string, string | number>): Promise<PUTTasksIdResponse> {
  let url = `/api/tasks/${encodeURIComponent(id)}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    const str = qs.toString();
    if (str) url += (url.includes('?') ? '&' : '?') + str;
  }
  return callApi<PUTTasksIdResponse>(url, { method: 'PUT', body: JSON.stringify(body) });
}

  // DELETE /tasks/:id
export async function deleteTasksId(id: string, query?: Record<string, string | number>): Promise<DELETETasksIdResponse> {
  let url = `/api/tasks/${encodeURIComponent(id)}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    const str = qs.toString();
    if (str) url += (url.includes('?') ? '&' : '?') + str;
  }
  return callApi<DELETETasksIdResponse>(url, { method: 'DELETE' });
}
