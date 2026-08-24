import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractBackendRoutes } from '../../server/reconciler/extract-backend-routes.js';
import { extractFrontendFetches } from '../../server/reconciler/extract-frontend-fetches.js';
import { extractDbSchema } from '../../server/reconciler/extract-db-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'server', 'reconciler', '__fixtures__');

function makeWorkspaceWith(layout) {
  // layout: { 'backend/src/index.js': '...', ... }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'reconciler-test-'));
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return ws;
}

function copyTreeInto(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyTreeInto(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

// ── extractBackendRoutes ──────────────────────────────────────────────

test('extractBackendRoutes: real Express fixture from t39 RAG run', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-backend-'));
  copyTreeInto(path.join(FIXTURES, 'backend'), path.join(ws, 'backend', 'src'));
  try {
    const routes = extractBackendRoutes(ws);
    const summary = routes.map(r => `${r.method} ${r.path}`);
    // The fixture is t39-time-off lookalike (RAG): documents CRUD + ask.
    assert.ok(summary.includes('GET /health'), `expected GET /health in ${summary.join(', ')}`);
    assert.ok(summary.includes('GET /documents'));
    assert.ok(summary.includes('POST /documents'));
    assert.ok(summary.includes('DELETE /documents/:id'));
    assert.ok(summary.includes('POST /ask'));
    assert.equal(summary.length, 5, `expected exactly 5 routes; got ${summary.join(', ')}`);
    for (const r of routes) {
      assert.ok(r.line > 0, 'line numbers must be set');
      assert.ok(r.file.includes('backend/src'), 'file paths must include scope dir');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractBackendRoutes: multi-route file - body fields scoped per handler (no leak between routes)', () => {
  const ws = makeWorkspaceWith({
    'backend/src/index.js': `
      const express = require('express');
      const app = express();
      app.get('/health', (req, res) => res.json({ ok: true }));
      app.get('/tasks', async (req, res) => {
        const result = await pool.query('SELECT * FROM tasks');
        res.json(result.rows);
      });
      app.post('/tasks', async (req, res) => {
        const { title, notes, due_date } = req.body;
        await pool.query('INSERT INTO tasks ...', [title, notes, due_date]);
        res.status(201).json({ ok: true });
      });
      app.put('/tasks/:id', async (req, res) => {
        const { completed } = req.body;
        await pool.query('UPDATE tasks SET completed = $1 WHERE id = $2', [completed, req.params.id]);
        res.json({ ok: true });
      });
      app.listen(3000);
    `,
  });
  try {
    const routes = extractBackendRoutes(ws);
    const byKey = Object.fromEntries(routes.map(r => [`${r.method} ${r.path}`, r]));
    assert.equal(byKey['GET /health'].requestFields, null, 'GET /health has no req.body');
    assert.equal(byKey['GET /tasks'].requestFields, null, 'GET /tasks has no req.body');
    assert.deepEqual(byKey['POST /tasks'].requestFields, ['title', 'notes', 'due_date']);
    assert.deepEqual(byKey['PUT /tasks/:id'].requestFields, ['completed']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractBackendRoutes: req.body destructure -> requestFields', () => {
  const ws = makeWorkspaceWith({
    'backend/src/index.js': `
      const express = require('express');
      const app = express();
      app.post('/users', (req, res) => {
        const { username, email, password } = req.body;
        res.json({ ok: true });
      });
      app.listen(3000);
    `,
  });
  try {
    const routes = extractBackendRoutes(ws);
    assert.equal(routes.length, 1);
    assert.deepEqual(routes[0].requestFields, ['username', 'email', 'password']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractBackendRoutes: non-Express file (no express import) is skipped', () => {
  const ws = makeWorkspaceWith({
    'backend/src/util.js': `
      // Looks like a route call but isn't on an Express app.
      const obj = { get: () => {} };
      obj.get('/foo');
    `,
  });
  try {
    const routes = extractBackendRoutes(ws);
    assert.equal(routes.length, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractBackendRoutes: Router prefix variant matches', () => {
  const ws = makeWorkspaceWith({
    'backend/src/routes.js': `
      const express = require('express');
      const apiRouter = express.Router();
      apiRouter.get('/items', (req, res) => res.json([]));
      apiRouter.delete('/items/:id', (req, res) => res.sendStatus(204));
      module.exports = apiRouter;
    `,
  });
  try {
    const routes = extractBackendRoutes(ws);
    const summary = routes.map(r => `${r.method} ${r.path}`).sort();
    assert.deepEqual(summary, ['DELETE /items/:id', 'GET /items']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractBackendRoutes: FastAPI decorator + Pydantic body model', () => {
  const ws = makeWorkspaceWith({
    'backend/main.py': `
from fastapi import FastAPI
from pydantic import BaseModel

class CreateRequest(BaseModel):
    employee_id: int
    start_date: str
    end_date: str

app = FastAPI()

@app.post("/requests")
async def create_request(body: CreateRequest):
    return {"ok": True}

@app.get("/requests/{rid}")
async def get_request(rid: int):
    return {}
`,
  });
  try {
    const routes = extractBackendRoutes(ws);
    const summary = routes.map(r => `${r.method} ${r.path}`).sort();
    assert.deepEqual(summary, ['GET /requests/{rid}', 'POST /requests']);
    const post = routes.find(r => r.method === 'POST');
    assert.equal(post.requestModel, 'CreateRequest');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractBackendRoutes: no backend dir -> empty array (not error)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-empty-'));
  try {
    const routes = extractBackendRoutes(ws);
    assert.deepEqual(routes, []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── extractFrontendFetches ────────────────────────────────────────────

test('extractFrontendFetches: real fixture pages from t39 RAG run', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-frontend-'));
  copyTreeInto(path.join(FIXTURES, 'frontend'), path.join(ws, 'frontend', 'src', 'pages'));
  try {
    const fetches = extractFrontendFetches(ws);
    const summary = fetches.map(f => `${f.method} ${f.path}`);
    // /api/ prefix stripped, template-literal expressions normalized.
    assert.ok(summary.includes('POST /ask'), `expected POST /ask; got ${summary.join(', ')}`);
    assert.ok(summary.some(s => s.startsWith('GET /documents')), `expected GET /documents*; got ${summary.join(', ')}`);
    assert.ok(summary.some(s => s.includes('DELETE /documents/:param')), `expected DELETE /documents/:param; got ${summary.join(', ')}`);

    const ask = fetches.find(f => f.path === '/ask');
    assert.deepEqual(ask.requestFields, ['question'], 'JSON.stringify body fields must be parsed');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractFrontendFetches: axios shorthand with body literal', () => {
  const ws = makeWorkspaceWith({
    'frontend/src/api.js': `
      import axios from 'axios';
      export async function createUser(name, email) {
        return axios.post('/api/users', { name, email });
      }
    `,
  });
  try {
    const fetches = extractFrontendFetches(ws);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].method, 'POST');
    assert.equal(fetches[0].path, '/users');
    assert.deepEqual(fetches[0].requestFields, ['name', 'email']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractFrontendFetches: external URL is ignored', () => {
  const ws = makeWorkspaceWith({
    'frontend/src/api.js': `
      fetch('https://example.com/foo');
      fetch('//cdn.example.com/x');
    `,
  });
  try {
    const fetches = extractFrontendFetches(ws);
    assert.equal(fetches.length, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractFrontendFetches: no frontend dir -> empty array', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-empty-'));
  try {
    assert.deepEqual(extractFrontendFetches(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── extractDbSchema ───────────────────────────────────────────────────

test('extractDbSchema: real init SQL fixtures from t39 RAG run', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-db-'));
  copyTreeInto(path.join(FIXTURES, 'database'), path.join(ws, 'database', 'init'));
  try {
    const schema = extractDbSchema(ws);
    const tables = schema.map(t => t.table);
    assert.ok(tables.includes('documents'), `expected documents table; got ${tables.join(', ')}`);
    assert.ok(tables.includes('chunks'), `expected chunks table; got ${tables.join(', ')}`);

    const docs = schema.find(t => t.table === 'documents');
    const docCols = docs.columns.map(c => c.name);
    assert.ok(docCols.includes('id'));
    assert.ok(docCols.includes('filename'));
    assert.ok(docCols.includes('uploaded_by'));
    assert.ok(docCols.includes('status'));
    assert.ok(docCols.includes('chunk_count'));

    const status = docs.columns.find(c => c.name === 'status');
    assert.equal(status.nullable, true, 'status column has DEFAULT but no NOT NULL');
    assert.match(status.type, /VARCHAR/);

    const filename = docs.columns.find(c => c.name === 'filename');
    assert.equal(filename.nullable, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractDbSchema: skips table-level constraints (PRIMARY KEY, FOREIGN KEY blocks)', () => {
  const ws = makeWorkspaceWith({
    'database/init/01_schema.sql': `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (id) REFERENCES other(id),
        UNIQUE (email)
      );
    `,
  });
  try {
    const schema = extractDbSchema(ws);
    assert.equal(schema.length, 1);
    const cols = schema[0].columns.map(c => c.name);
    assert.deepEqual(cols, ['id', 'email', 'created_at']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractDbSchema: top-level init.sql also picked up', () => {
  const ws = makeWorkspaceWith({
    'database/init.sql': 'CREATE TABLE foo (a INT);',
  });
  try {
    const schema = extractDbSchema(ws);
    assert.equal(schema.length, 1);
    assert.equal(schema[0].table, 'foo');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractDbSchema: no database dir -> empty array', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-empty-'));
  try {
    assert.deepEqual(extractDbSchema(ws), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('extractDbSchema: malformed SQL is skipped silently (no throw)', () => {
  const ws = makeWorkspaceWith({
    'database/init/broken.sql': 'CREATE TABLE foo ( a INT, b VARCHAR(', // unclosed paren
  });
  try {
    const schema = extractDbSchema(ws);
    // Either skipped (length 0) or partial - but must not throw.
    assert.ok(Array.isArray(schema));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── Comment-line blanking (phantom-route prevention) ─────────────────────
// The locked mga-client.ts header shows `app.post('/api/chat/stream', ...)`
// as a usage example; the scanner adopted it as a real route. Comment lines
// must never yield routes — line numbers of real routes must be preserved.

import { test as testC } from 'node:test';
import assertC from 'node:assert/strict';
import { extractBackendRoutes as extractForCommentTest } from '../../server/reconciler/extract-backend-routes.js';
import { mkdtempSync as mkdtempC, mkdirSync as mkdirC, writeFileSync as writeC } from 'node:fs';
import { tmpdir as tmpdirC } from 'node:os';
import pathC from 'node:path';

testC('express scanner ignores routes in comments, keeps real ones with correct lines', () => {
  const ws = mkdtempC(pathC.join(tmpdirC(), 'extract-comments-'));
  mkdirC(pathC.join(ws, 'backend', 'src'), { recursive: true });
  writeC(pathC.join(ws, 'backend', 'src', 'index.ts'), [
    "import express from 'express';",
    '/**',
    " *   app.post('/api/chat/stream', streamChat);   // usage example",
    ' */',
    "// app.get('/commented-out', handler);",
    'const app = express();',
    "app.get('/real', handler);",
    'app.listen(3000);',
  ].join('\n'));
  const routes = extractForCommentTest(ws);
  const paths = routes.map((r) => r.path);
  assertC.deepEqual(paths, ['/real']);
  assertC.equal(routes[0].line, 7);
});
