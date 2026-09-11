/**
 * Track A (A5): LLM-as-judge for router-output semantic-intent match.
 *
 * Per smoke scenario: hand-authored `expectedIntent` (plain English; e.g.
 * "track personal todos with priority and due date"). After the deterministic
 * `assertRouterExpect` gate (A4) passes, smoke calls this judge with three
 * inputs:
 *   1. `userPrompt`     — the raw smoke prompt sent to the router.
 *   2. `expectedIntent` — the plain-English ground truth.
 *   3. `routerOutput`  — the structured plan_preview payload (tasks + all contracts).
 *
 * The judge (a dedicated MGA assistant under JUDGE_ASSISTANT_ID, with system
 * prompt sourced from `chat/prompts/router-judge.md`) returns:
 *   { score: 0..1, reasoning: string }
 *
 * The smoke gate logs the score per run and treats `score < 0.8` as a soft
 * fail (downgrades scenario status). One call per scenario, gate-time only.
 *
 * Transport: `/chat/completions` with the system prompt loaded from disk —
 * matches understanding-agent + contract-agent. MGA's stored `instructions`
 * on the JUDGE_ASSISTANT_ID are still uploaded for parity, but the disk file
 * is what actually runs.
 *
 * Graceful degrade: when `JUDGE_ASSISTANT_ID` is unset (e.g. user hasn't
 * created the MGA assistant yet), this helper returns
 * `{ score: null, reasoning: 'judge not configured' }` without throwing —
 * the smoke gate logs but doesn't fail. Same goes for parse failures and
 * network errors: log + return null score, never break the gate.
 */

import { callMgaCompletions } from '../llm/llm.js';
import { pickModel } from '../llm/model-picker.js';
import { loadPrompt } from '../prompts/disk-prompt.js';

/**
 * Build the user message sent to the judge assistant. Mirrors the three-input
 * shape the system prompt expects.
 */
function buildJudgeMessage({ userPrompt, expectedIntent, routerOutput }) {
  return [
    'USER PROMPT (what the user actually typed):',
    userPrompt,
    '',
    'EXPECTED INTENT (hand-authored plain English ground truth):',
    expectedIntent,
    '',
    'PLANNER OUTPUT (structured JSON the planner emitted):',
    JSON.stringify(routerOutput, null, 2),
    '',
    'Score per the rubric. Return JSON only.',
  ].join('\n');
}

/**
 * Parse the judge's response. Strips ```json fences if present. Returns
 * `{ score, reasoning }` or null on parse failure.
 */
function parseJudgeResponse(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const score = typeof parsed.score === 'number' ? parsed.score : null;
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  if (score === null) return null;
  // Clamp into [0, 1] in case the model returns 0..10 or out-of-range.
  const clamped = Math.max(0, Math.min(1, score));
  return { score: clamped, reasoning };
}

/**
 * Call the judge assistant for one scenario. Returns:
 *   { score: 0..1, reasoning: string }
 * or `{ score: null, reasoning: <why> }` on graceful-degrade paths.
 *
 * Never throws — the judge is observability, not load-bearing.
 */
export async function judgeRouterOutput({ userPrompt, expectedIntent, routerOutput }) {
  const judgeAssistantId = process.env.JUDGE_ASSISTANT_ID;
  if (!judgeAssistantId) {
    return { score: null, reasoning: 'judge not configured (JUDGE_ASSISTANT_ID unset)' };
  }
  if (!userPrompt || !expectedIntent || !routerOutput) {
    return { score: null, reasoning: 'judge skipped: missing input(s)' };
  }

  const userMessage = buildJudgeMessage({ userPrompt, expectedIntent, routerOutput });

  let result;
  try {
    const instructions = loadPrompt('router-judge.md');
    const messages = [
      { role: 'system', content: [{
          type: 'text',
          text: instructions,
          cache_control: { type: 'ephemeral' },
      }]},
      { role: 'user', content: userMessage },
    ];
    const picked = pickModel({ phase: 'ROUTER_JUDGE', scope: 'router-judge' });
    result = await callMgaCompletions({
      messages,
      model: picked.model,
      assistantLabel: 'Judge',
      phase: 'ROUTER_JUDGE',
      scope: 'router-judge',
    });
  } catch (err) {
    return { score: null, reasoning: `judge call failed: ${err.message || String(err)}` };
  }

  const parsed = parseJudgeResponse(result.content);
  if (!parsed) {
    return {
      score: null,
      reasoning: `judge parse failed: ${(result.content || '').slice(0, 200)}`,
    };
  }
  return parsed;
}
