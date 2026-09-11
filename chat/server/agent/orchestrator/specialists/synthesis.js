/**
 * Synthesis specialist — combines the user intent, optional retrieval output,
 * and category list to produce LLM prompt templates, API endpoint specs, and
 * content schemas that the build system can wire into the application.
 *
 * Read-only: no file writes, no DB calls, no external API calls outside
 * the approved MGA completions endpoint.
 *
 * Input:  intent + retrieval output + category list (from contract + entry)
 * Output: { promptTemplate, apiSpec, contentSchema }
 */

import { callMgaCompletions } from '../../llm/llm.js';
import { pickModel } from '../../llm/model-picker.js';
import { tlog } from '../../../util/timestamped-log.js';

const SYSTEM_PROMPT = `You are a synthesis specialist for a code-generation platform. Given a user's intent, optional domain context, and a list of content categories, produce:

1. A reusable LLM prompt template the application can call at runtime
2. An API endpoint specification for the LLM integration endpoint
3. A content schema describing the shape of LLM responses

Output ONLY valid JSON — no markdown, no preamble — in this shape:
{
  "promptTemplate": "string — the prompt the app should send to the LLM, with {placeholders} for dynamic values",
  "apiSpec": {
    "method": "POST",
    "path": "/api/generate",
    "requestBody": { "description": "string", "fields": [{ "name": "string", "type": "string", "required": true }] },
    "responseBody": { "description": "string", "fields": [{ "name": "string", "type": "string" }] }
  },
  "contentSchema": {
    "description": "string",
    "fields": [{ "name": "string", "type": "string", "description": "string" }]
  }
}

Rules:
- promptTemplate must use {curly_brace} placeholders for runtime-injected values
- apiSpec must be minimal — only what the integration needs
- The LLM provider is ALWAYS MGA. The built app's backend must call the MGA completions
  endpoint using the mga-streaming-chat or mga-assistant-client snippet. Never reference
  OpenAI, Azure OpenAI, Anthropic, or any other external LLM provider directly.
- apiSpec.provider must always be set to "mga"
- apiSpec.mgaEndpoint must always be set to "/chat/completions" (proxied via the platform backend)
- Do not write backend code, only the specification`;

/**
 * @param {object} opts
 * @param {object} opts.entry      — { module, trigger, input, output }
 * @param {object} opts.contract   — current contract (read-only reference)
 * @param {object} opts.session    — session record (read-only; no mutations)
 * @param {object} opts.envContext — env context
 * @returns {Promise<{ promptTemplate: string|null, apiSpec: object|null, contentSchema: object|null }>}
 */
export async function run({ entry, contract, session, envContext }) {
  // Gather retrieval context if present from businessLogicContract (set by reconcile)
  const contextData = contract.businessLogicContract?.contextData || [];
  const userContent = JSON.stringify({
    intent: entry.input || 'build an AI-assisted web application',
    context: contextData.slice(0, 4), // cap to 4 items to stay within budget
    expectedOutput: entry.output || 'LLM integration spec',
  });

  const { model } = pickModel({ phase: 'CONTRACT', scope: null });
  tlog('[specialist/synthesis] session=%s model=%s', session.id, model);

  const { content } = await callMgaCompletions({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    model,
    assistantLabel: 'hybrid-synthesis',
    phase: 'CONTRACT',
  });

  let parsed;
  try {
    const clean = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    tlog('[specialist/synthesis] JSON parse failed — returning null outputs');
    return { promptTemplate: null, apiSpec: null, contentSchema: null };
  }

  return {
    promptTemplate: parsed?.promptTemplate || null,
    apiSpec: parsed?.apiSpec || null,
    contentSchema: parsed?.contentSchema || null,
  };
}
