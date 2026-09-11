// AUTO-GENERATED — DO NOT EDIT — regenerated from .harness/contracts.json
// Source contracts version: 1, generated 2026-05-25T18:06:33.594Z
// Scope: frontend

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

// ── ui_contract ───────────────────────────────────────────────────────

/** Props for component `TaskList` — displays all tasks for the current user with completion status */
export interface TaskListProps {
  // (no props declared in ui_contract — extend as needed)
}

/** Props for component `TaskItem` — single task row with toggle complete and delete actions */
export interface TaskItemProps {
  // (no props declared in ui_contract — extend as needed)
}

/** Props for component `AddTaskForm` — input field and button to create a new task */
export interface AddTaskFormProps {
  // (no props declared in ui_contract — extend as needed)
}
