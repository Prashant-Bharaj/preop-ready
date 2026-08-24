/**
 * Prompt-writer: writes user-app MGA-assistant `instructions` (system prompts)
 * from intent + tool list + router contracts.
 *
 * Why a dedicated agent: the Router is good at structural emission
 * (scopes, contracts, tool_keys, model picks) but unreliable at creative
 * writing. Splitting prompt-writing into a specialized assistant mirrors the
 * reconciler-judge pattern (extract specialized work into a dedicated
 * assistant) and lets us iterate on prompt-writing quality without touching
 * the Router prompt.
 *
 * Called from session/routes.js Stage 5b (per spec) before POST /assistants.
 * Output is uploaded VERBATIM as the `instructions` field on the user-app
 * assistant.
 *
 * Transport: `/chat/completions` with the system prompt loaded from disk
 * (`chat/prompts/prompt-writer.md`) — matches understanding-agent +
 * contract-agent. MGA's stored `instructions` on PROMPT_WRITER_ASSISTANT_ID
 * are still uploaded for parity, but the disk file is what actually runs.
 *
 * Failure policy: throw. Shipping a chatbot whose backing assistant has a
 * broken/empty system prompt is shipping broken code — pre-stage's caller
 * already aborts the build on prompt-writer failure (see session/routes.js).
 */

import { getCredentials } from '../../core/auth.js';
import { TOOL_DESCRIPTIONS } from '../llm/mga-platform-config.js';

function resolveWriterAssistantId() {
  if (process.env.PROMPT_WRITER_ASSISTANT_ID) {
    return process.env.PROMPT_WRITER_ASSISTANT_ID;
  }
  const id = getCredentials()?.promptWriterAssistantId;
  if (!id) {
    throw new Error('No prompt-writer assistant configured. Set PROMPT_WRITER_ASSISTANT_ID env or add promptWriterAssistantId to chat/server/config/assistants.json.');
  }
  return id;
}

/**
 * Build the structured input message the prompt-writer assistant expects
 * (per chat/prompts/prompt-writer.md INPUT FORMAT).
 *
 * Each block is labeled with `=== ... ===` markers and gets verbatim content.
 * Empty blocks still appear (with a one-liner explanation) so the writer
 * doesn't have to guess whether a block was omitted vs absent.
 */
function buildWriterInput({ spec, userPrompt, contracts }) {
  const lines = [];

  lines.push('=== USER INTENT ===');
  lines.push(userPrompt && userPrompt.trim() ? userPrompt.trim() : '(no original user prompt available — derive scope from metadata)');
  lines.push('');

  lines.push('=== ASSISTANT METADATA ===');
  lines.push(JSON.stringify({
    key: spec.key || 'default',
    name: spec.name,
    description: spec.description || '',
    model: spec.model,
  }, null, 2));
  lines.push('');

  lines.push('=== ASSISTANT TOOLS ===');
  const toolKeys = Array.isArray(spec.tool_keys) ? spec.tool_keys : [];
  if (toolKeys.length === 0) {
    lines.push('(no tools attached — write a prompt that does NOT mention tools)');
  } else {
    for (const k of toolKeys) {
      const desc = TOOL_DESCRIPTIONS[k] || '(no description available)';
      lines.push(`- ${k}: ${desc}`);
    }
  }
  lines.push('');

  lines.push('=== APP CONTRACTS ===');
  const c = contracts || {};
  const blocks = [];
  if (c.apiContract && Array.isArray(c.apiContract.endpoints) && c.apiContract.endpoints.length) {
    const endpoints = c.apiContract.endpoints
      .map(e => `  ${e.method} ${e.path}`)
      .join('\n');
    blocks.push(`Endpoints:\n${endpoints}`);
  }
  if (c.dataModel && Array.isArray(c.dataModel.tables) && c.dataModel.tables.length) {
    const tables = c.dataModel.tables
      .map(t => `  ${t.name}(${(t.columns || []).map(col => col.name).join(', ')})`)
      .join('\n');
    blocks.push(`Tables:\n${tables}`);
  }
  if (c.businessLogicContract && Array.isArray(c.businessLogicContract.rules) && c.businessLogicContract.rules.length) {
    blocks.push(`Rules:\n${c.businessLogicContract.rules.map(r => `  - ${r}`).join('\n')}`);
  }
  if (c.uiContract && c.uiContract.primary_view) {
    blocks.push(`Primary UI view: ${c.uiContract.primary_view}`);
  }
  lines.push(blocks.length ? blocks.join('\n\n') : '(no contracts available — write a generic prompt scoped to USER INTENT + METADATA)');
  lines.push('');

  lines.push('=== INTENT STUB ===');
  lines.push(spec.instructions && spec.instructions.trim() ? spec.instructions.trim() : '(planner did not provide a stub — derive from USER INTENT)');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a system prompt for one user-app MGA assistant.
 *
 * @param {object} args
 * @param {object} args.spec       — { key, name, description, model, tool_keys, instructions? }
 * @param {string} args.userPrompt — original user prompt that triggered the build
 * @param {object} [args.contracts] — { apiContract, dataModel, businessLogicContract, uiContract }
 * @param {object} [opts]
 * @param {Function} [opts.callImpl] — injectable for tests; defaults to callMgaCompletions
 * @returns {Promise<string>} the instructions string (will be uploaded verbatim)
 */
export async function writeAssistantInstructions({ spec, userPrompt, contracts }, opts = {}) {
  if (!spec || typeof spec !== 'object' || !spec.name) {
    throw new Error('writeAssistantInstructions: spec.name required');
  }
  const userMessage = buildWriterInput({ spec, userPrompt, contracts });
  const assistantId = resolveWriterAssistantId();

  const callImpl = opts.callImpl || (async (args) => {
    const { callMgaCompletions } = await import('../llm/llm.js');
    const { pickModel } = await import('../llm/model-picker.js');
    const { loadPrompt } = await import('../prompts/disk-prompt.js');
    const { deriveRunContext } = await import('../compaction/run-logger.js');
    const { WORKSPACE_DIR } = await import('../../core/paths.js');
    const runContext = deriveRunContext(WORKSPACE_DIR);

    const instructions = loadPrompt('prompt-writer.md');
    const messages = [
      { role: 'system', content: [{
          type: 'text',
          text: instructions,
          cache_control: { type: 'ephemeral' },
      }]},
      { role: 'user', content: args.message },
    ];
    const picked = pickModel({ phase: 'PROMPT_WRITER', scope: 'prompt-writer' });

    return callMgaCompletions({
      messages,
      model: picked.model,
      assistantLabel: 'Prompt-Writer',
      runContext,
      phase: 'PROMPT_WRITER',
      scope: 'prompt-writer',
    });
  });

  const result = await callImpl({ message: userMessage, assistantId });
  const instructions = (result?.content || '').trim();

  if (!instructions) {
    throw new Error('Prompt-writer returned empty instructions — refusing to create an assistant with no system prompt.');
  }
  if (instructions.length < 50) {
    throw new Error(`Prompt-writer returned suspiciously short instructions (${instructions.length} chars) — refusing to use.`);
  }
  return instructions;
}

// Exported for unit testing. Don't call from app code.
export const __test = { buildWriterInput, resolveWriterAssistantId };
