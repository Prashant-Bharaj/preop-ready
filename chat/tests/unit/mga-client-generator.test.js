/**
 * Unit tests for the pre-staged MGA client generator.
 *
 * Module under test:
 *   chat/server/agent/coordinator/mga-client-generator.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldEmitMgaClient,
  generateMgaClient,
} from '../../server/agent/coordinator/mga-client-generator.js';

function nodeContract(overrides = {}) {
  return {
    flags: ['ai-chat'],
    mgaAssistants: [],
    tasks: [
      { scope: 'backend', dockerfile: 'Dockerfile.node' },
      { scope: 'frontend', dockerfile: 'Dockerfile.react' },
    ],
    ...overrides,
  };
}

test('shouldEmitMgaClient: ai-chat flag emits', () => {
  assert.equal(shouldEmitMgaClient(nodeContract()), true);
});

test('shouldEmitMgaClient: mgaAssistants without flag emits', () => {
  assert.equal(shouldEmitMgaClient(nodeContract({ flags: [], mgaAssistants: [{ key: 'default' }] })), true);
});

test('shouldEmitMgaClient: no AI signal does not emit', () => {
  assert.equal(shouldEmitMgaClient(nodeContract({ flags: ['has-users'] })), false);
  assert.equal(generateMgaClient(nodeContract({ flags: ['has-users'] })), null);
});

test('node backend: emits lib/mga-client.ts with Bearer auth and canonical base URL', () => {
  const out = generateMgaClient(nodeContract());
  assert.equal(out.relPath, 'backend/src/lib/mga-client.ts');
  assert.match(out.source, /Authorization: `Bearer \$\{env\.apiKey\}`/);
  assert.match(out.source, /chat\.int\.bayer\.com\/api\/v2/);
  assert.match(out.source, /process\.env\.MGA_API_KEY/);
  assert.match(out.source, /process\.env\.MGA_ASSISTANT_ID/);
  assert.match(out.source, /export async function chatWithAssistant/);
  assert.match(out.source, /export const streamChat/);
});

test('node backend: env validated lazily, not at module load', () => {
  const out = generateMgaClient(nodeContract());
  // The throw lives inside mgaEnv(); nothing throws at import time.
  const beforeFirstFunction = out.source.slice(0, out.source.indexOf('function mgaEnv'));
  assert.ok(!/throw new Error/.test(beforeFirstFunction), 'no module-level throw before mgaEnv()');
  assert.match(out.source, /function mgaEnv\(\)/);
});

test('python backend: emits src/mga_client.py with httpx and Bearer auth', () => {
  const out = generateMgaClient(nodeContract({
    tasks: [{ scope: 'backend', dockerfile: 'Dockerfile.python' }],
  }));
  assert.equal(out.relPath, 'backend/src/mga_client.py');
  assert.match(out.source, /import httpx/);
  assert.match(out.source, /Bearer \{env\['api_key'\]\}/);
  assert.match(out.source, /os\.getenv\("MGA_API_KEY"\)/);
  assert.match(out.source, /async def chat_with_assistant/);
});

test('no hardcoded non-MGA hosts or model names in either variant', () => {
  const banned = /api\.openai\.com|api\.anthropic\.com|mga\.platform\.|gpt-4/;
  const ts = generateMgaClient(nodeContract());
  const py = generateMgaClient(nodeContract({ tasks: [{ scope: 'backend', dockerfile: 'Dockerfile.python' }] }));
  assert.ok(!banned.test(ts.source));
  assert.ok(!banned.test(py.source));
});
