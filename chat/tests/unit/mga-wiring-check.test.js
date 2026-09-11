/**
 * Unit tests for the deterministic MGA wiring gate.
 *
 * Module under test:
 *   chat/server/reconciler/mga-wiring-check.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  runMgaWiringChecks,
  isMgaApp,
  BANNED_LLM_PATTERNS,
} from '../../server/reconciler/mga-wiring-check.js';

const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function makeWorkspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mga-wiring-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const MGA_ENV = 'MGA_API_KEY=k\nMGA_BASE_URL=https://chat.int.bayer.com/api/v2\nMGA_ASSISTANT_ID=a\n';
const CLIENT_TS = '// pre-staged client\nexport async function chatWithAssistant() {}\n';
const GOOD_COMPOSE = `services:
  backend:
    build: ./backend
    env_file:
      - .env
    environment:
      - MGA_API_KEY=\${MGA_API_KEY}
`;
const BARE_COMPOSE = `services:
  backend:
    build: ./backend
    environment:
      - PORT=3000
  frontend:
    build: ./frontend
`;

test('non-MGA app (no .env) → skipped, no violations', () => {
  const ws = makeWorkspace({ 'backend/src/index.ts': 'const x = 1;' });
  const r = runMgaWiringChecks(ws, ['backend', 'integration']);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'not-an-mga-app');
  assert.equal(isMgaApp(ws), false);
});

test('.env without MGA vars → skipped', () => {
  const ws = makeWorkspace({ '.env': 'POSTGRES_PASSWORD=x\n' });
  assert.equal(isMgaApp(ws), false);
});

test('clean MGA app passes all checks', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/mga-client.ts': CLIENT_TS,
    'backend/src/routes.ts': "import { chatWithAssistant } from './lib/mga-client.js';\n",
    'docker-compose.yml': GOOD_COMPOSE,
  });
  const r = runMgaWiringChecks(ws, ['backend', 'integration']);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('pre-staged client never imported → mga-client-unused', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/mga-client.ts': CLIENT_TS,
    'backend/src/routes.ts': 'const noAi = true;\n',
    'docker-compose.yml': GOOD_COMPOSE,
  });
  const r = runMgaWiringChecks(ws, ['backend', 'integration']);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => v.rule === 'mga-client-unused' && v.scope === 'backend'));
});

test('hand-rolled client without pre-stage: hallucinated host + model + no Bearer → violations with file:line', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/llm.ts': [
      "const URL = 'https://mga.platform.bayer.com';",
      "const model = 'gpt-4o';",
      'export async function call() { return fetch(URL); }',
    ].join('\n'),
    'docker-compose.yml': GOOD_COMPOSE,
  });
  const r = runMgaWiringChecks(ws, ['backend']);
  assert.equal(r.ok, false);
  const banned = r.violations.filter(v => v.rule === 'banned-llm-reference');
  assert.equal(banned.length, 2);
  assert.ok(banned.some(v => v.file === 'backend/src/lib/llm.ts:1'));
  assert.ok(banned.some(v => v.file === 'backend/src/lib/llm.ts:2'));
  assert.ok(r.violations.some(v => v.rule === 'mga-env-bearer-missing'));
});

test('legacy path with env read + Bearer passes usage check', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/llm.ts': [
      'const key = process.env.MGA_API_KEY;',
      "const h = { Authorization: `Bearer ${key}` };",
    ].join('\n'),
  });
  const r = runMgaWiringChecks(ws, ['backend']);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('compose without MGA wiring → compose-mga-env-missing (integration scope)', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'docker-compose.yml': BARE_COMPOSE,
  });
  const r = runMgaWiringChecks(ws, ['integration']);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => v.rule === 'compose-mga-env-missing' && v.scope === 'integration'));
});

test('compose with env_file .env but no explicit MGA vars passes', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'docker-compose.yml': 'services:\n  backend:\n    env_file:\n      - .env\n',
  });
  const r = runMgaWiringChecks(ws, ['integration']);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('scopes gate which rules run', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/mga-client.ts': CLIENT_TS,
    'backend/src/routes.ts': 'const noAi = true;\n',
    'docker-compose.yml': BARE_COMPOSE,
  });
  const backendOnly = runMgaWiringChecks(ws, ['backend']);
  assert.ok(backendOnly.violations.every(v => v.scope === 'backend'));
  const integrationOnly = runMgaWiringChecks(ws, ['integration']);
  assert.ok(integrationOnly.violations.every(v => v.scope === 'integration'));
});

test('node_modules and generated dirs are not scanned', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/llm.ts': "const key = process.env.MGA_API_KEY; const h = { Authorization: 'Bearer x' };",
    'backend/node_modules/openai/index.js': "const host = 'https://api.openai.com';",
    'backend/src/generated/contracts.ts': "// gpt-4o mentioned in a type comment",
  });
  const r = runMgaWiringChecks(ws, ['backend']);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('vectordb provisioned but backend never reads VECTORDB_* → vectordb-unused', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'vectordb/Dockerfile': 'FROM pgvector/pgvector:pg16\n',
    'backend/src/lib/mga-client.ts': CLIENT_TS,
    'backend/src/routes.ts': "import { chatWithAssistant } from './lib/mga-client.js';\nconst mainPool = process.env.DATABASE_HOST;\n",
  });
  const r = runMgaWiringChecks(ws, ['backend']);
  assert.ok(r.violations.some(v => v.rule === 'vectordb-unused' && v.scope === 'backend'));
});

test('vectordb used via VECTORDB_ env passes', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'vectordb/Dockerfile': 'FROM pgvector/pgvector:pg16\n',
    'backend/src/lib/mga-client.ts': CLIENT_TS,
    'backend/src/routes.ts': "import { chatWithAssistant } from './lib/mga-client.js';\nconst host = process.env.VECTORDB_HOST;\n",
  });
  const r = runMgaWiringChecks(ws, ['backend']);
  assert.ok(!r.violations.some(v => v.rule === 'vectordb-unused'), JSON.stringify(r.violations));
});

test('no vectordb service → vectordb check skipped', () => {
  const ws = makeWorkspace({
    '.env': MGA_ENV,
    'backend/src/lib/mga-client.ts': CLIENT_TS,
    'backend/src/routes.ts': "import { chatWithAssistant } from './lib/mga-client.js';\n",
  });
  const r = runMgaWiringChecks(ws, ['backend']);
  assert.ok(!r.violations.some(v => v.rule === 'vectordb-unused'));
});

test('BANNED_LLM_PATTERNS matches known-bad and passes known-good strings', () => {
  const bad = ['https://api.openai.com/v1', 'model: "gpt-4o"', 'mga.platform.bayer.com', 'api.anthropic.com'];
  const good = ['https://chat.int.bayer.com/api/v2', 'text-embedding-3-small', 'claude-opus-4.5'];
  for (const s of bad) {
    assert.ok(BANNED_LLM_PATTERNS.some(p => p.re.test(s)), `should flag: ${s}`);
  }
  for (const s of good) {
    assert.ok(!BANNED_LLM_PATTERNS.some(p => p.re.test(s)), `should NOT flag: ${s}`);
  }
});
