import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAssistant,
  attachTools,
  deleteAssistant,
  listHarnessAssistants,
  PLACEHOLDER_LOGO_PNG,
} from '../../server/agent/llm/mga-assistant.js';

const SECRETS = {
  baseUrl: 'https://example.test/api/v2',
  apiKey: 'mga-test-key',
};

const VALID_SPEC = {
  name: 'Product FAQ Bot',
  description: 'Answers product questions',
  instructions: 'You are a helpful assistant.',
  model: 'claude-opus-4.7',
  sessionId: 'sess-abc-123',
};

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function errorResponse(status, txt) {
  return { ok: false, status, json: async () => ({}), text: async () => txt };
}

test('PLACEHOLDER_LOGO_PNG is the canonical 68-byte 1x1 transparent PNG', () => {
  // Regression catch: if the base64 constant gets mangled (line break inserted,
  // padding lost), the byte count drifts. 68 = exact length of the constant
  // copied from chat/scripts/create-orchestrator-assistants.js.
  assert.equal(PLACEHOLDER_LOGO_PNG.length, 68);
});

test('createAssistant: posts multipart FormData with all required fields, returns id', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ id: 'asst-uuid-1' });
  };
  const id = await createAssistant(VALID_SPEC, SECRETS, { fetchImpl });
  assert.equal(id, 'asst-uuid-1');
  assert.equal(captured.url, 'https://example.test/api/v2/assistants');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer mga-test-key');
  assert.ok(captured.init.body instanceof FormData, 'body must be FormData');

  const fd = captured.init.body;
  assert.equal(fd.get('description'), 'Answers product questions');
  assert.equal(fd.get('model'), 'claude-opus-4.7');
  assert.equal(fd.get('access'), 'private');
  assert.equal(fd.get('reasoning_effort'), 'low');
  assert.equal(fd.get('instructions'), 'You are a helpful assistant.');
  // Name tagged with " - harness-<sessionId>" suffix for orphan cleanup.
  // MGA's POST /assistants validator restricts name to A-Z a-z 0-9 _ space - / &
  // — no brackets, no colons. Hence this format (regression catch).
  assert.match(fd.get('name'), / - harness-sess-abc-123$/);
  assert.doesNotMatch(fd.get('name'), /\[|\]|:/, 'name must not contain brackets or colons');
  // Logo must be present as a Blob.
  assert.ok(fd.get('assistant_logo'));
});

test('createAssistant: omits sessionId tag when not provided', async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = init.body; return jsonResponse({ id: 'asst-no-tag' }); };
  await createAssistant({ ...VALID_SPEC, sessionId: undefined }, SECRETS, { fetchImpl });
  assert.equal(captured.get('name'), 'Product FAQ Bot');
});

test('createAssistant: throws on non-2xx response with status + body excerpt', async () => {
  const fetchImpl = async () => errorResponse(400, 'name already exists');
  await assert.rejects(
    () => createAssistant(VALID_SPEC, SECRETS, { fetchImpl }),
    /HTTP 400.*name already exists/,
  );
});

test('createAssistant: throws on missing id in response', async () => {
  const fetchImpl = async () => jsonResponse({ name: 'x' }); // no id
  await assert.rejects(
    () => createAssistant(VALID_SPEC, SECRETS, { fetchImpl }),
    /returned no id/,
  );
});

test('attachTools: empty array returns immediately, no fetch call', async () => {
  let called = 0;
  const fetchImpl = async () => { called++; return jsonResponse([]); };
  const r = await attachTools('asst-1', [], SECRETS, { fetchImpl });
  assert.equal(called, 0);
  assert.deepEqual(r, { attached: [], failed: [] });
});

test('attachTools: filters out chat-agent default tools (not attachable)', async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = init; return jsonResponse([{ key: 'websearch' }]); };
  const r = await attachTools(
    'asst-1',
    ['websearch', 'document_question_answering', 'uploaded_docs'],
    SECRETS,
    { fetchImpl },
  );
  const body = JSON.parse(captured.body);
  assert.deepEqual(body.tool_keys, ['websearch']);
  assert.deepEqual(r.attached, ['websearch']);
});

test('attachTools: HTTP failure logged + returned as failed, does not throw', async () => {
  const fetchImpl = async () => errorResponse(403, 'no permission');
  const r = await attachTools('asst-1', ['websearch'], SECRETS, { fetchImpl });
  assert.deepEqual(r, { attached: [], failed: ['websearch'] });
});

test('attachTools: thrown error caught + returned as failed', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const r = await attachTools('asst-1', ['websearch'], SECRETS, { fetchImpl });
  assert.deepEqual(r, { attached: [], failed: ['websearch'] });
});

test('deleteAssistant: 204 success', async () => {
  const fetchImpl = async () => ({ ok: true, status: 204, text: async () => '' });
  const r = await deleteAssistant('asst-1', SECRETS, { fetchImpl });
  assert.equal(r.deleted, true);
  assert.equal(r.status, 204);
});

test('deleteAssistant: 404 treated as success (idempotent)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  const r = await deleteAssistant('asst-1', SECRETS, { fetchImpl });
  assert.equal(r.deleted, true);
});

test('deleteAssistant: 500 throws', async () => {
  const fetchImpl = async () => errorResponse(500, 'boom');
  await assert.rejects(
    () => deleteAssistant('asst-1', SECRETS, { fetchImpl }),
    /HTTP 500.*boom/,
  );
});

test('listHarnessAssistants: filters to those with " - harness-<id>" suffix, extracts sessionId', async () => {
  const fetchImpl = async () => jsonResponse([
    { id: 'a1', name: 'My Bot - harness-sess-1' },
    { id: 'a2', name: 'Hand-Created Bot' },
    { id: 'a3', name: 'Other - harness-sess-2' },
  ]);
  const out = await listHarnessAssistants(SECRETS, { fetchImpl });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a1');
  assert.equal(out[0].sessionId, 'sess-1');
  assert.equal(out[1].id, 'a3');
  assert.equal(out[1].sessionId, 'sess-2');
});

test('listHarnessAssistants: handles wrapped response (data field)', async () => {
  const fetchImpl = async () => jsonResponse({ data: [{ id: 'a1', name: 'X - harness-s' }] });
  const out = await listHarnessAssistants(SECRETS, { fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 's');
});
