/**
 * Unit tests for the locked OIDC identity parser generator and its
 * stop-hook enforcement.
 *
 * Modules under test:
 *   chat/server/agent/coordinator/oidc-identity-generator.js
 *   chat/server/agent/stop-hooks/stop-hooks.js (whoami-contract extension)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { generateOidcIdentity } from '../../server/agent/coordinator/oidc-identity-generator.js';
import { runStopHooks } from '../../server/agent/stop-hooks/stop-hooks.js';

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-identity-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const NODE_CONTRACT = { tasks: [{ scope: 'backend', dockerfile: 'Dockerfile.node' }] };

test('node parser: dev-claim semantics, role claim, no-header fallback', () => {
  const out = generateOidcIdentity(NODE_CONTRACT);
  assert.equal(out.relPath, 'backend/src/lib/oidc-identity.ts');
  assert.match(out.source, /devMode: payload\.dev === true/);
  assert.match(out.source, /roleClaim: typeof payload\.role === 'string'/);
  assert.match(out.source, /present: false, verified: false, devMode: true/);
  assert.match(out.source, /export async function parseOidcIdentity/);
  assert.match(out.source, /PLATFORM_ALB_ARN/);
  assert.match(out.source, /ALB_EXPECTED_ISSUER/);
  assert.match(out.source, /header\.alg !== 'ES256'/);
  // Malformed token: present but NOT devMode (fail closed).
  assert.match(out.source, /present: true, verified: false, devMode: false/);
});

test('python parser variant', () => {
  const out = generateOidcIdentity({ tasks: [{ scope: 'backend', dockerfile: 'Dockerfile.python' }] });
  assert.equal(out.relPath, 'backend/src/oidc_identity.py');
  assert.match(out.source, /payload\.get\("dev"\) is True/);
  assert.match(out.source, /role_claim/);
  assert.match(out.source, /PLATFORM_ALB_ARN/);
  assert.match(out.source, /ALB_EXPECTED_ISSUER/);
  assert.match(out.source, /cryptography/);
});

test('no backend scope emits nothing', () => {
  assert.equal(generateOidcIdentity({ tasks: [{ scope: 'frontend' }] }), null);
});

// ── stop-hook: staged parser must be the only OIDC reader ──

const REPORT = '--- PHASE AGENT REPORT ---\n**Scope:** backend\n**Status:** complete\n';
const GUARDS = [
  "app.use((err, _req, res, _next) => { res.status(500).json({}); });",
  "process.on('unhandledRejection', (reason) => console.error(reason));",
].join('\n');
const baseFiles = (routes) => ({
  'backend/package.json': '{"name":"backend","scripts":{"build":"tsc","start":"node dist/index.js"}}',
  'backend/src/index.ts': GUARDS,
  'backend/src/lib/oidc-identity.ts': "export function parseOidcIdentity(req) { /* x-amzn-oidc-data */ }",
  'backend/src/routes.ts': routes,
});
const ctx = (workspaceDir) => ({ toolErrors: [], scope: 'backend', workspaceDir, writtenPaths: new Set(), phaseMachine: null });

test('manual OIDC parsing outside the staged parser blocks', () => {
  const ws = makeWorkspace(baseFiles([
    "const raw = req.headers['x-amzn-oidc-data']; // hand-rolled",
    "app.get('/whoami', (req, res) => res.json({ devMode: true, availableRoles: ['a','b'] }));",
    "if (user.role !== 'qa_lead') {}",
  ].join('\n')));
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, true);
  assert.match(r.message, /pre-staged parser/);
});

test('identity via the staged parser passes', () => {
  const ws = makeWorkspace(baseFiles([
    "import { parseOidcIdentity } from './lib/oidc-identity.js';",
    "app.get('/whoami', (req, res) => { const id = parseOidcIdentity(req); res.json({ devMode: id.devMode, availableRoles: ['a','b'] }); });",
    "if (user.role !== 'qa_lead') {}",
  ].join('\n')));
  const r = runStopHooks(REPORT, ctx(ws));
  assert.equal(r.blocking, false, r.message);
});
