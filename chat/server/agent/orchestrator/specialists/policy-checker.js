/**
 * Policy-checker specialist — checks the application domain, categories, and
 * intent for regulatory compliance flags (HIPAA, COPPA, GDPR, etc.).
 *
 * Read-only: no file writes, no DB calls, no external API calls outside
 * the approved MGA completions endpoint.
 *
 * Input:  domain + category list + intent (from contract + entry)
 * Output: { flags: [{ category, regulation, note }] }
 *   flags — array of compliance concerns found. Empty array = no concerns.
 */

import { callMgaCompletions } from '../../llm/llm.js';
import { pickModel } from '../../llm/model-picker.js';
import { tlog } from '../../../util/timestamped-log.js';

const SYSTEM_PROMPT = `You are a compliance specialist for a software platform serving regulated industries. Given an application domain, content categories, and user intent, identify any regulatory compliance flags the development team should review before launching.

Output ONLY valid JSON — no markdown, no preamble — in this shape:
{
  "flags": [
    {
      "category": "string — the application category or feature triggering this flag",
      "regulation": "string — the regulation name (HIPAA, COPPA, GDPR, CCPA, FINRA, SOX, etc.)",
      "note": "string — one sentence explaining what needs review and why"
    }
  ]
}

Rules:
- Return an empty flags array if no regulatory concerns are found
- Only flag genuine regulatory exposure — do not over-flag
- Do not provide legal advice — only identify categories for team review
- Focus on: healthcare/medical data (HIPAA), children under 13 (COPPA), EU personal data (GDPR), financial advice (FINRA/SEC), payment data (PCI-DSS)`;

/**
 * @param {object} opts
 * @param {object} opts.entry      — { module, trigger, input, output }
 * @param {object} opts.contract   — current contract (read-only reference)
 * @param {object} opts.session    — session record (read-only; no mutations)
 * @param {object} opts.envContext — env context
 * @returns {Promise<{ flags: Array }>}
 */
export async function run({ entry, contract, session, envContext }) {
  const userContent = JSON.stringify({
    domain: entry.input || 'web application',
    intent: contract.businessLogicContract?.intent || entry.output || 'build a web application',
    categories: Array.isArray(contract.businessLogicContract?.categories)
      ? contract.businessLogicContract.categories
      : [],
  });

  const { model } = pickModel({ phase: 'CONTRACT', scope: null });
  tlog('[specialist/policy-checker] session=%s model=%s', session.id, model);

  const { content } = await callMgaCompletions({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    model,
    assistantLabel: 'hybrid-policy-checker',
    phase: 'CONTRACT',
  });

  let parsed;
  try {
    const clean = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    tlog('[specialist/policy-checker] JSON parse failed — returning empty flags');
    return { flags: [] };
  }

  const flags = Array.isArray(parsed?.flags) ? parsed.flags : [];
  tlog('[specialist/policy-checker] returning %d compliance flags', flags.length);
  return { flags };
}
