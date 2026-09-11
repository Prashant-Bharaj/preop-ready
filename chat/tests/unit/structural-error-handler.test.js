/**
 * Unit tests for the backend crash-guard structural check.
 *
 * Module under test:
 *   chat/server/reconciler/structural-checks.js (checkBackendErrorHandler)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  checkBackendErrorHandler,
  runStructuralChecks,
} from '../../server/reconciler/structural-checks.js';

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structural-eh-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const GUARDED = [
  "app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {",
  "  res.status(500).json({ error: 'InternalServerError' });",
  '});',
  "process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));",
].join('\n');

test('template-shaped index.ts with both guards passes', () => {
  const ws = makeWorkspace({ 'backend/src/index.ts': GUARDED });
  const r = checkBackendErrorHandler(ws);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('missing 4-arg middleware → error-middleware-present violation', () => {
  const ws = makeWorkspace({
    'backend/src/index.ts': "process.on('unhandledRejection', (r) => console.error(r));",
  });
  const r = checkBackendErrorHandler(ws);
  assert.ok(r.violations.some(v => v.rule === 'error-middleware-present'));
  assert.ok(!r.violations.some(v => v.rule === 'unhandled-rejection-guard'));
});

test('missing rejection guard → unhandled-rejection-guard violation', () => {
  const ws = makeWorkspace({
    'backend/src/index.ts': 'app.use((err, _req, res, _next) => { res.status(500).json({}); });',
  });
  const r = checkBackendErrorHandler(ws);
  assert.ok(r.violations.some(v => v.rule === 'unhandled-rejection-guard'));
  assert.ok(!r.violations.some(v => v.rule === 'error-middleware-present'));
});

test('guards may live in separate files', () => {
  const ws = makeWorkspace({
    'backend/src/index.ts': "process.on('unhandledRejection', (r) => console.error(r));",
    'backend/src/middleware/errors.ts': 'app.use((err, _req, res, _next) => { res.status(500).json({}); });',
  });
  const r = checkBackendErrorHandler(ws);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('python backend (no ts/js under src) is skipped', () => {
  const ws = makeWorkspace({ 'backend/src/main.py': 'app = FastAPI()' });
  const r = checkBackendErrorHandler(ws);
  assert.equal(r.ok, true);
});

test('runStructuralChecks surfaces the violations under the backend scope', () => {
  const ws = makeWorkspace({
    'backend/src/index.ts': 'const app = 1;',
    'backend/Dockerfile': 'FROM node:22-slim\nWORKDIR /app\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  });
  const r = runStructuralChecks(ws, ['backend']);
  assert.ok(r.violations.some(v => v.scope === 'backend' && v.rule === 'error-middleware-present'));
  assert.ok(r.violations.some(v => v.scope === 'backend' && v.rule === 'unhandled-rejection-guard'));
});
