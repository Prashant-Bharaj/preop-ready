import type { Express, Request, Response } from 'express';
import { pool } from './db.js';
import type { User, Task } from './generated/contracts.js';
import type {
  WhoamiResponse,
  TaskResponse,
  GetTasksResponse,
  CreateTaskRequest,
  UpdateTaskRequest,
} from './types.js';

/**
 * Get or create user from OIDC identity.
 * Auto-creates user row on first login if not exists.
 */
async function getOrCreateUser(oidcSub: string, email: string): Promise<User> {
  // Try to find existing user
  const existing = await pool.query<User>(
    'SELECT id, oidc_sub, email, created_at FROM users WHERE oidc_sub = $1',
    [oidcSub]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  // Create new user on first login
  const inserted = await pool.query<User>(
    'INSERT INTO users (oidc_sub, email) VALUES ($1, $2) RETURNING id, oidc_sub, email, created_at',
    [oidcSub, email]
  );

  return inserted.rows[0];
}

/**
 * Validate that title is a non-empty string.
 */
function validateTitle(title: unknown): string | null {
  if (typeof title !== 'string') {
    return null;
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

export function registerRoutes(app: Express): void {
  // GET /health - Health check endpoint for probes
  app.get('/health', (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  });

  // GET /whoami - Return current user info
  app.get('/whoami', async (req: Request, res: Response<WhoamiResponse | { error: string; message: string; statusCode: number }>): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User identity not found', statusCode: 401 });
      return;
    }

    const user = await getOrCreateUser(
      req.user.userId,
      req.user.email || 'unknown@example.com'
    );

    res.json({ id: user.id, email: user.email });
  });

  // GET /tasks - List tasks for current user with pagination
  app.get('/tasks', async (req: Request, res: Response<GetTasksResponse | { error: string; message: string; statusCode: number }>): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User identity not found', statusCode: 401 });
      return;
    }

    const user = await getOrCreateUser(
      req.user.userId,
      req.user.email || 'unknown@example.com'
    );

    // Parse pagination params
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;

    let limit = 50;
    let offset = 0;

    if (typeof limitParam === 'string') {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 100); // Cap at 100
      }
    }

    if (typeof offsetParam === 'string') {
      const parsed = parseInt(offsetParam, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
    }

    // Get total count for user
    const countResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM tasks WHERE user_id = $1',
      [user.id]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated tasks, newest first
    const tasksResult = await pool.query<Task>(
      'SELECT id, user_id, title, completed, created_at FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [user.id, limit, offset]
    );

    const tasks: TaskResponse[] = tasksResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      completed: row.completed,
      created_at: row.created_at,
    }));

    res.json({ tasks, total });
  });

  // POST /tasks - Create a new task
  app.post('/tasks', async (req: Request, res: Response<TaskResponse | { error: string; message: string; statusCode: number }>): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User identity not found', statusCode: 401 });
      return;
    }

    const user = await getOrCreateUser(
      req.user.userId,
      req.user.email || 'unknown@example.com'
    );

    const body = req.body as CreateTaskRequest;
    const title = validateTitle(body.title);

    if (title === null) {
      res.status(400).json({ error: 'BadRequest', message: 'Title must be a non-empty string', statusCode: 400 });
      return;
    }

    const result = await pool.query<Task>(
      'INSERT INTO tasks (user_id, title, completed) VALUES ($1, $2, $3) RETURNING id, user_id, title, completed, created_at',
      [user.id, title, false]
    );

    const task = result.rows[0];
    res.status(201).json({
      id: task.id,
      title: task.title,
      completed: task.completed,
      created_at: task.created_at,
    });
  });

  // PUT /tasks/:id - Update a task
  app.put('/tasks/:id', async (req: Request, res: Response<TaskResponse | { error: string; message: string; statusCode: number }>): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User identity not found', statusCode: 401 });
      return;
    }

    const user = await getOrCreateUser(
      req.user.userId,
      req.user.email || 'unknown@example.com'
    );

    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      res.status(400).json({ error: 'BadRequest', message: 'Invalid task ID', statusCode: 400 });
      return;
    }

    // Check task exists and belongs to user
    const existing = await pool.query<Task>(
      'SELECT id, user_id, title, completed, created_at FROM tasks WHERE id = $1',
      [taskId]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Task not found', statusCode: 404 });
      return;
    }

    if (existing.rows[0].user_id !== user.id) {
      res.status(404).json({ error: 'NotFound', message: 'Task not found', statusCode: 404 });
      return;
    }

    const body = req.body as UpdateTaskRequest;
    const currentTask = existing.rows[0];

    // Build update fields
    let newTitle = currentTask.title;
    let newCompleted = currentTask.completed;

    if (body.title !== undefined) {
      const validatedTitle = validateTitle(body.title);
      if (validatedTitle === null) {
        res.status(400).json({ error: 'BadRequest', message: 'Title must be a non-empty string', statusCode: 400 });
        return;
      }
      newTitle = validatedTitle;
    }

    if (body.completed !== undefined) {
      if (typeof body.completed !== 'boolean') {
        res.status(400).json({ error: 'BadRequest', message: 'Completed must be a boolean', statusCode: 400 });
        return;
      }
      newCompleted = body.completed;
    }

    const result = await pool.query<Task>(
      'UPDATE tasks SET title = $1, completed = $2 WHERE id = $3 RETURNING id, user_id, title, completed, created_at',
      [newTitle, newCompleted, taskId]
    );

    const task = result.rows[0];
    res.json({
      id: task.id,
      title: task.title,
      completed: task.completed,
      created_at: task.created_at,
    });
  });

  // DELETE /tasks/:id - Delete a task
  app.delete('/tasks/:id', async (req: Request, res: Response<{ error: string; message: string; statusCode: number } | void>): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', message: 'User identity not found', statusCode: 401 });
      return;
    }

    const user = await getOrCreateUser(
      req.user.userId,
      req.user.email || 'unknown@example.com'
    );

    const taskId = parseInt(req.params.id, 10);
    if (isNaN(taskId)) {
      res.status(400).json({ error: 'BadRequest', message: 'Invalid task ID', statusCode: 400 });
      return;
    }

    // Check task exists and belongs to user
    const existing = await pool.query<Task>(
      'SELECT id, user_id FROM tasks WHERE id = $1',
      [taskId]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Task not found', statusCode: 404 });
      return;
    }

    if (existing.rows[0].user_id !== user.id) {
      res.status(404).json({ error: 'NotFound', message: 'Task not found', statusCode: 404 });
      return;
    }

    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);

    res.status(204).send();
  });
}