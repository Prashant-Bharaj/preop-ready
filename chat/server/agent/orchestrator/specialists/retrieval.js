/**
 * Retrieval specialist — reads the domain and intent from the module plan
 * entry and calls the MGA LLM to produce contextual background data.
 *
 * Read-only: no file writes, no DB calls, no external API calls outside
 * the approved MGA completions endpoint.
 *
 * Input:  domain + intent (from entry.input)
 * Output: { contextData: [...] }
 *   contextData — array of { topic, summary, relevance } objects providing
 *   domain background that synthesis can use to produce richer templates.
 */

import { callMgaCompletions } from '../../llm/llm.js';
import { pickModel } from '../../llm/model-picker.js';
import { tlog } from '../../../util/timestamped-log.js';

const SYSTEM_PROMPT = `You are a domain research specialist. Given an application domain and user intent, produce structured background context that will help a code-generation system make better architectural decisions.

Output ONLY valid JSON — no markdown, no preamble — in this shape:
{
  "contextData": [
    { "topic": "string", "summary": "string", "relevance": "high" | "medium" | "low" }
  ]
}

Rules:
- Return 3–6 context items maximum
- Focus on practical considerations: data shape, API patterns, compliance constraints, common user needs
- Do not suggest specific libraries or frameworks — only domain facts
- Do not write code`;

/**
 * @param {object} opts
 * @param {object} opts.entry      — { module, trigger, input, output }
 * @param {object} opts.contract   — current contract (read-only reference)
 * @param {object} opts.session    — session record (read-only; no mutations)
 * @param {object} opts.envContext — env context
 * @returns {Promise<{ contextData: Array }>}
 */
export async function run({ entry, contract, session, envContext }) {
  const userContent = JSON.stringify({
    domain: entry.input || 'general application domain',
    intent: contract.businessLogicContract?.intent || entry.output || 'build a web application',
  });

  const { model } = pickModel({ phase: 'CONTRACT', scope: null });
  tlog('[specialist/retrieval] session=%s model=%s', session.id, model);

  const { content } = await callMgaCompletions({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    model,
    assistantLabel: 'hybrid-retrieval',
    phase: 'CONTRACT',
  });

  let parsed;
  try {
    // Strip markdown fences if the model wraps output despite instructions
    const clean = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    tlog('[specialist/retrieval] JSON parse failed — returning empty contextData');
    return { contextData: [] };
  }

  const contextData = Array.isArray(parsed?.contextData) ? parsed.contextData : [];
  tlog('[specialist/retrieval] returning %d context items', contextData.length);
  return { contextData };
}
