// AUTO-GENERATED — DO NOT EDIT — regenerated from .harness/contracts.json
// Source contracts version: 1, generated 2026-05-25T18:06:30.046Z
// Scope: backend

// ── data_model ────────────────────────────────────────────────────────

/** Row type for table `users` */
export interface User {
  id: number;
  oidc_sub: string;
  email: string;
  /** ISO-8601 timestamp */
  created_at: string;
}

/** Row type for table `tasks` */
export interface Task {
  id: number;
  /** @see users */
  user_id: number;
  title: string;
  completed: boolean;
  /** ISO-8601 timestamp */
  created_at: string;
}

// ── api_contract ──────────────────────────────────────────────────────

// GET /whoami
export interface GETWhoamiResponse {
  id?: unknown;
  email?: unknown;
}

// GET /tasks
export interface GETTasksRequest {
  query: unknown;
}
export interface GETTasksResponse {
  tasks?: unknown;
  total?: unknown;
}

// POST /tasks
export interface POSTTasksRequest {
  title: unknown;
}
export interface POSTTasksResponse {
  id?: unknown;
  title?: unknown;
  completed?: unknown;
  created_at?: unknown;
}

// PUT /tasks/:id
export interface PUTTasksIdRequest {
  title: unknown;
  completed: unknown;
}
export interface PUTTasksIdResponse {
  id?: unknown;
  title?: unknown;
  completed?: unknown;
  created_at?: unknown;
}

// DELETE /tasks/:id
export interface DELETETasksIdResponse {
}
