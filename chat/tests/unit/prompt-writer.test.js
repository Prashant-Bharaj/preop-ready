import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeAssistantInstructions, __test } from '../../server/agent/planner/prompt-writer.js';

const VALID_SPEC = {
  key: 'default',
  name: 'HR Policy FAQ Bot',
  description: 'Answers HR policy questions',
  model: 'claude-opus-4.7',
  tool_keys: ['uploaded_docs', 'document_question_answering'],
};

const VALID_CONTRACTS = {
  apiContract: { endpoints: [
    { method: 'POST', path: '/chat' },
    { method: 'POST', path: '/documents' },
  ] },
  dataModel: { tables: [
    { name: 'documents', columns: [{ name: 'id' }, { name: 'filename' }] },
    { name: 'chunks', columns: [{ name: 'id' }, { name: 'embedding' }] },
  ] },
  businessLogicContract: { rules: ['users see only their own uploaded docs'] },
  uiContract: { primary_view: 'chat' },
};

const USER_PROMPT = 'Build me an FAQ bot for HR policy. Employees upload PDFs and ask questions.';

const STUB_INSTRUCTIONS_RESPONSE =
  'You are an HR policy assistant for company employees. Answer questions concisely from uploaded documents. ' +
  'Use uploaded_docs to surface the relevant policy. Cite the document filename when you cite. If the answer is not in the policies, say so plainly. ' +
  'Stay strictly within HR policy scope.';

function makeMockCall(content) {
  return async ({ message, assistantId }) => ({ content, _captured: { message, assistantId } });
}

// ── buildWriterInput ──────────────────────────────────────────────────

test('buildWriterInput: includes all five labeled blocks', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  assert.match(out, /=== USER INTENT ===/);
  assert.match(out, /=== ASSISTANT METADATA ===/);
  assert.match(out, /=== ASSISTANT TOOLS ===/);
  assert.match(out, /=== APP CONTRACTS ===/);
  assert.match(out, /=== INTENT STUB ===/);
});

test('buildWriterInput: USER INTENT block contains the original user prompt verbatim', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  assert.match(out, /Build me an FAQ bot for HR policy/);
});

test('buildWriterInput: ASSISTANT TOOLS block resolves descriptions from TOOL_DESCRIPTIONS', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  assert.match(out, /uploaded_docs:/);
  assert.match(out, /Surface uploaded documents in the chat context/);
  assert.match(out, /document_question_answering:/);
  assert.match(out, /Answer questions about documents the user has uploaded/);
});

test('buildWriterInput: empty tool_keys produces "no tools attached" placeholder', () => {
  const spec = { ...VALID_SPEC, tool_keys: [] };
  const out = __test.buildWriterInput({ spec, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  assert.match(out, /no tools attached/);
});

test('buildWriterInput: APP CONTRACTS lists endpoints + tables + rules + primary_view', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  assert.match(out, /POST \/chat/);
  assert.match(out, /POST \/documents/);
  assert.match(out, /documents\(id, filename\)/);
  assert.match(out, /chunks\(id, embedding\)/);
  assert.match(out, /users see only their own uploaded docs/);
  assert.match(out, /Primary UI view: chat/);
});

test('buildWriterInput: missing contracts produces a "no contracts" placeholder', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: {} });
  assert.match(out, /no contracts available/);
});

test('buildWriterInput: router-emitted instructions surface as INTENT STUB', () => {
  const spec = { ...VALID_SPEC, instructions: 'A bot for answering HR questions.' };
  const out = __test.buildWriterInput({ spec, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  // INTENT STUB block contains the router's stub
  const stubBlock = out.split('=== INTENT STUB ===')[1] || '';
  assert.match(stubBlock, /A bot for answering HR questions/);
});

test('buildWriterInput: missing user prompt produces a fallback marker', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: '', contracts: VALID_CONTRACTS });
  assert.match(out, /no original user prompt available/);
});

test('buildWriterInput: ASSISTANT METADATA serializes key+name+description+model', () => {
  const out = __test.buildWriterInput({ spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS });
  // Pull the metadata section
  const meta = out.split('=== ASSISTANT METADATA ===')[1].split('===')[0];
  const parsed = JSON.parse(meta.match(/\{[\s\S]*?\}/)[0]);
  assert.equal(parsed.key, 'default');
  assert.equal(parsed.name, VALID_SPEC.name);
  assert.equal(parsed.model, VALID_SPEC.model);
});

// ── writeAssistantInstructions ────────────────────────────────────────

test('writeAssistantInstructions: returns trimmed model output', async () => {
  // Set env so resolveWriterAssistantId doesn't throw.
  process.env.PROMPT_WRITER_ASSISTANT_ID = 'test-writer-id';
  const callImpl = makeMockCall(`  ${STUB_INSTRUCTIONS_RESPONSE}  `);
  const out = await writeAssistantInstructions(
    { spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS },
    { callImpl },
  );
  assert.equal(out, STUB_INSTRUCTIONS_RESPONSE);
  delete process.env.PROMPT_WRITER_ASSISTANT_ID;
});

test('writeAssistantInstructions: passes the assistantId from env to callImpl', async () => {
  process.env.PROMPT_WRITER_ASSISTANT_ID = 'env-id-abc';
  let captured;
  const callImpl = async (args) => { captured = args; return { content: STUB_INSTRUCTIONS_RESPONSE }; };
  await writeAssistantInstructions(
    { spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS },
    { callImpl },
  );
  assert.equal(captured.assistantId, 'env-id-abc');
  delete process.env.PROMPT_WRITER_ASSISTANT_ID;
});

test('writeAssistantInstructions: throws when callImpl returns empty content', async () => {
  process.env.PROMPT_WRITER_ASSISTANT_ID = 'test-id';
  const callImpl = makeMockCall('');
  await assert.rejects(
    () => writeAssistantInstructions(
      { spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS },
      { callImpl },
    ),
    /empty instructions/,
  );
  delete process.env.PROMPT_WRITER_ASSISTANT_ID;
});

test('writeAssistantInstructions: throws on suspiciously short content', async () => {
  process.env.PROMPT_WRITER_ASSISTANT_ID = 'test-id';
  const callImpl = makeMockCall('You are a bot.');
  await assert.rejects(
    () => writeAssistantInstructions(
      { spec: VALID_SPEC, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS },
      { callImpl },
    ),
    /suspiciously short/,
  );
  delete process.env.PROMPT_WRITER_ASSISTANT_ID;
});

test('writeAssistantInstructions: throws when spec.name missing', async () => {
  process.env.PROMPT_WRITER_ASSISTANT_ID = 'test-id';
  const callImpl = makeMockCall(STUB_INSTRUCTIONS_RESPONSE);
  await assert.rejects(
    () => writeAssistantInstructions(
      { spec: { ...VALID_SPEC, name: undefined }, userPrompt: USER_PROMPT, contracts: VALID_CONTRACTS },
      { callImpl },
    ),
    /spec\.name required/,
  );
  delete process.env.PROMPT_WRITER_ASSISTANT_ID;
});
