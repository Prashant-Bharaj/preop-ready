/**
 * Local type definitions to supplement generated contracts.
 * The generated contracts use `unknown` for flexibility; these provide
 * stricter typing for our implementation.
 */

export interface WhoamiResponse {
  id: number;
  email: string;
}

export interface TaskResponse {
  id: number;
  title: string;
  completed: boolean;
  created_at: string;
}

export interface GetTasksResponse {
  tasks: TaskResponse[];
  total: number;
}

export interface CreateTaskRequest {
  title: string;
}

export interface UpdateTaskRequest {
  title?: string;
  completed?: boolean;
}