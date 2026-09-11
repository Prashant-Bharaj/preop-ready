/**
 * Unit tests for the backend-error-handler and mga-client-usage stop-hook
 * validators.
 *
 * Module under test:
 *   chat/server/agent/stop-hooks/stop-hooks.js (runStopHooks cascade)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runStopHooks } from '../../server/agent/stop-hooks/stop-hooks.js';

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hooks-mga-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// A report whose claimed paths exist keeps the ghost-file validator quiet;
// earlier validators need clean inputs so the new ones are what fires.
const REPORT = '--- PHASE AGENT REPORT ---\n**Scope:** backend\n**Status:** complete\n';

const GUARDED_INDEX = [
  "import express from 'express';",
  'const app = express();',
  "app.use((err, _req, res, _next) => { res.status(500).json({ error: 'InternalServerError' }); });",
  "process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));",
  'app.listen(3000);',
].join('\n');

// Node backend needs package.json + src/index.ts for the language detector
// and the scope-required-files validator.
function nodeBackendFiles(indexContent) {
  return {
    'backend/package.json': '{"name":"backend","scripts":{"build":"tsc","start":"node dist/index.js"}}',
    'backend/src/index.ts': indexContent,
  };
}

function ctx(workspaceDir) {
  return {
    toolErrors: [],
    scope: 'backend',
    workspaceDir,
    writtenPaths: new Set(),
    phaseMachine: null,
  };
}

test('node backend with both crash guards passes', () => {
  const ws = makeWorkspace(nodeBackendFiles(GUARDED_INDEX));
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false);
});

test('node backend missing unhandledRejection guard blocks', () => {
  const ws = makeWorkspace(nodeBackendFiles(GUARDED_INDEX.replace(/process\.on.*\n/, '')));
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, true);
  assert.match(r.message, /unhandledRejection/);
});

test('node backend missing 4-arg error middleware blocks', () => {
  const ws = makeWorkspace(nodeBackendFiles(GUARDED_INDEX.replace(/app\.use\(\(err.*\n/, '')));
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, true);
  assert.match(r.message, /4-arg Express error middleware/);
});

test('python backend skips the error-handler validator', () => {
  const ws = makeWorkspace({
    'backend/requirements.txt': 'fastapi\n',
    'backend/main.py': [
      'from fastapi import FastAPI',
      'app = FastAPI()',
      '@app.get("/health")',
      'def health():',
      '    return {"ok": True}',
    ].join('\n'),
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false, r.message);
});

test('pre-staged MGA client unused blocks with import hint', () => {
  const ws = makeWorkspace({
    ...nodeBackendFiles(GUARDED_INDEX),
    'backend/src/lib/mga-client.ts': 'export async function chatWithAssistant() {}',
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, true);
  assert.match(r.message, /never imported/);
  assert.match(r.message, /lib\/mga-client\.js/);
});

test('pre-staged MGA client imported passes', () => {
  const ws = makeWorkspace({
    ...nodeBackendFiles(GUARDED_INDEX),
    'backend/src/lib/mga-client.ts': 'export async function chatWithAssistant() {}',
    'backend/src/routes.ts': "import { chatWithAssistant } from './lib/mga-client.js';",
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false);
});

test('banned LLM reference blocks with file:line detail', () => {
  const ws = makeWorkspace({
    ...nodeBackendFiles(GUARDED_INDEX),
    'backend/src/lib/mga-client.ts': 'export async function chatWithAssistant() {}',
    'backend/src/routes.ts': [
      "import { chatWithAssistant } from './lib/mga-client.js';",
      "const fallbackModel = 'gpt-4o';",
    ].join('\n'),
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, true);
  assert.match(r.message, /routes\.ts:2/);
  assert.match(r.message, /OpenAI model name/);
});

test('no pre-staged client → mga-client-usage validator stays quiet', () => {
  const ws = makeWorkspace(nodeBackendFiles(GUARDED_INDEX));
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false);
});


// ── whoami-contract validator ──

const WHOAMI_OK = [
  "app.get('/whoami', (req, res) => res.json({ id: 1, role: u.role, devMode: dev, availableRoles: ['operator', 'qa_lead'] }));",
  "if (user.role !== 'qa_lead') { res.status(403).json({}); }",
].join('\n');

test('role-gated app with complete whoami passes', () => {
  const ws = makeWorkspace({
    ...nodeBackendFiles(GUARDED_INDEX),
    'backend/src/routes.ts': WHOAMI_OK,
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false, r.message);
});

test('role-gated app with shapeless whoami blocks', () => {
  const ws = makeWorkspace({
    ...nodeBackendFiles(GUARDED_INDEX),
    'backend/src/routes.ts': [
      "app.get('/whoami', (req, res) => res.json({ id: 1, email: u.email, role: u.role }));",
      "if (user.role !== 'qa_lead') { res.status(403).json({}); }",
    ].join('\n'),
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, true);
  assert.match(r.message, /devMode/);
  assert.match(r.message, /availableRoles/);
});

test('whoami without role gating is not required to carry the dev fields', () => {
  const ws = makeWorkspace({
    ...nodeBackendFiles(GUARDED_INDEX),
    'backend/src/routes.ts': "app.get('/whoami', (req, res) => res.json({ id: 1 }));",
  });
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false, r.message);
});
