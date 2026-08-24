/**
 * Tasks API Backend
 * 
 * CRUD endpoints for tasks with PostgreSQL persistence.
 * Routes defined WITHOUT /api prefix (nginx/Traefik strips it).
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME || 'tasks',
  user: process.env.DATABASE_USER || 'tasks_user',
  password: process.env.DATABASE_PASSWORD || 'localdev123',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Health check (REQUIRED)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Validation helpers
function validateTitle(title) {
  if (!title || typeof title !== 'string') {
    return { valid: false, error: 'Title is required and must be a string' };
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Title cannot be empty' };
  }
  if (trimmed.length > 500) {
    return { valid: false, error: 'Title must be 500 characters or less' };
  }
  return { valid: true, value: trimmed };
}

function validateCompleted(completed) {
  if (completed === undefined || completed === null) {
    return { valid: true, value: false };
  }
  if (typeof completed !== 'boolean') {
    return { valid: false, error: 'Completed must be a boolean' };
  }
  return { valid: true, value: completed };
}

function validatePositiveInt(value, name) {
  const num = parseInt(value);
  if (isNaN(num) || num < 0) {
    return { valid: false, error: `${name} must be a non-negative integer` };
  }
  return { valid: true, value: num };
}

// GET /tasks?limit=50&offset=0
app.get('/tasks', async (req, res) => {
  try {
    const limitValidation = validatePositiveInt(req.query.limit || '50', 'limit');
    const offsetValidation = validatePositiveInt(req.query.offset || '0', 'offset');
    
    if (!limitValidation.valid) {
      return res.status(400).json({ error: 'INVALID_LIMIT', message: limitValidation.error, statusCode: 400 });
    }
    if (!offsetValidation.valid) {
      return res.status(400).json({ error: 'INVALID_OFFSET', message: offsetValidation.error, statusCode: 400 });
    }

    const limit = limitValidation.value;
    const offset = offsetValidation.value;

    const result = await pool.query(
      'SELECT id, title, completed, created_at FROM tasks ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    res.json({ tasks: result.rows });
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to fetch tasks', statusCode: 500 });
  }
});

// GET /tasks/:id
app.get('/tasks/:id', async (req, res) => {
  try {
    const idValidation = validatePositiveInt(req.params.id, 'id');
    if (!idValidation.valid) {
      return res.status(400).json({ error: 'INVALID_ID', message: idValidation.error, statusCode: 400 });
    }

    const result = await pool.query(
      'SELECT id, title, completed, created_at FROM tasks WHERE id = $1',
      [idValidation.value]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Task ${idValidation.value} not found`, statusCode: 404 });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching task:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to fetch task', statusCode: 500 });
  }
});

// POST /tasks
app.post('/tasks', async (req, res) => {
  try {
    const titleValidation = validateTitle(req.body.title);
    if (!titleValidation.valid) {
      return res.status(400).json({ error: 'INVALID_TITLE', message: titleValidation.error, statusCode: 400 });
    }

    const completedValidation = validateCompleted(req.body.completed);
    if (!completedValidation.valid) {
      return res.status(400).json({ error: 'INVALID_COMPLETED', message: completedValidation.error, statusCode: 400 });
    }

    const result = await pool.query(
      'INSERT INTO tasks (title, completed) VALUES ($1, $2) RETURNING id, title, completed, created_at',
      [titleValidation.value, completedValidation.value]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to create task', statusCode: 500 });
  }
});

// PUT /tasks/:id
app.put('/tasks/:id', async (req, res) => {
  try {
    const idValidation = validatePositiveInt(req.params.id, 'id');
    if (!idValidation.valid) {
      return res.status(400).json({ error: 'INVALID_ID', message: idValidation.error, statusCode: 400 });
    }

    // Check if task exists
    const existsResult = await pool.query('SELECT id FROM tasks WHERE id = $1', [idValidation.value]);
    if (existsResult.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Task ${idValidation.value} not found`, statusCode: 404 });
    }

    // Build update query dynamically for partial updates
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (req.body.title !== undefined) {
      const titleValidation = validateTitle(req.body.title);
      if (!titleValidation.valid) {
        return res.status(400).json({ error: 'INVALID_TITLE', message: titleValidation.error, statusCode: 400 });
      }
      updates.push(`title = $${paramIndex++}`);
      values.push(titleValidation.value);
    }

    if (req.body.completed !== undefined) {
      const completedValidation = validateCompleted(req.body.completed);
      if (!completedValidation.valid) {
        return res.status(400).json({ error: 'INVALID_COMPLETED', message: completedValidation.error, statusCode: 400 });
      }
      updates.push(`completed = $${paramIndex++}`);
      values.push(completedValidation.value);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'NO_UPDATES', message: 'No valid fields to update', statusCode: 400 });
    }

    values.push(idValidation.value);
    const result = await pool.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, title, completed, created_at`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to update task', statusCode: 500 });
  }
});

// DELETE /tasks/:id
app.delete('/tasks/:id', async (req, res) => {
  try {
    const idValidation = validatePositiveInt(req.params.id, 'id');
    if (!idValidation.valid) {
      return res.status(400).json({ error: 'INVALID_ID', message: idValidation.error, statusCode: 400 });
    }

    const result = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [idValidation.value]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Task ${idValidation.value} not found`, statusCode: 404 });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'DATABASE_ERROR', message: 'Failed to delete task', statusCode: 500 });
  }
});

// Global error handler (catches any unhandled errors)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    statusCode: 500
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tasks API listening on port ${PORT}`));