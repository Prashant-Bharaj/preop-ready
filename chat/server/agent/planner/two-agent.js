/**
 * Two-agent planner runtime entry.
 *
 * Signature-compatible with the legacy `routeMessage` in
 * `chat/server/agent/planner/router.js` so callers in
 * [routes.js](../../session/routes.js) don't change. Internally drives the
 * two-agent flow (Phase B, FRESH-only for user-driven turns):
 *
 *   user message + envContext
 *     → enriched message (Project Context + Attached Files + Project Memory)
 *     → Understanding Agent (SSE; multi-turn clarify loop owned by caller)
 *     → if clarify: return action=clarify, caller relays to user
 *     → if ready: extract brief
 *     → Contract Agent FRESH via runContractAgentWithRetry (one retry-once)
 *     → validated contract (parseRouterJSON-compatible normalized shape)
 *     → return action=execute
 *
 * The understanding-agent clarify loop is NOT looped inside this function;
 * each call processes ONE turn. The caller (`routes.js`) handles multi-turn
 * threading via `opts.priorMessages` (mirror of the legacy router pattern).
 *
 * ITERATE / DIAGNOSE / build-failure-recovery wiring is deferred per the
 * Phase B plan; see `/Users/alen/.claude/plans/lexical-wandering-perlis.md`.
 */

import { getCredentials } from '../../core/auth.js';
import { WORKSPACE_DIR } from '../../core/paths.js';
import {
  buildProjectContext,
  buildAttachedFilesBlock,
  buildProjectMemoryBlock,
  maybeWarnPromptSize,
} from './shared-context.js';
import { runContractAgentWithRetry } from './validate-with-retry.js';
import { callMgaCompletions } from '../llm/llm.js';
import { buildImageBlocks } from '../shared/image-blocks.js';
import { pickModel } from '../llm/model-picker.js';
import { loadPrompt } from '../prompts/disk-prompt.js';
import { normalizeClarifyQuestions } from '../clarify-questions.js';

// NOTE: image uploads reach the Understanding Agent as BOTH a text reference
// (inside enrichedMessage) AND, when vision-capable, as OpenAI `image_url`
// blocks so the model actually SEES the mockup/screenshot. MGA's
// /chat/completions proxy accepts multimodal array content for user messages as
// long as the image block is OpenAI-shaped ({ type:'image_url', image_url:{ url:
// 'data:…' } }); Anthropic-shaped blocks 422 ("Input should be a valid string").
// See server/agent/shared/image-blocks.js. The planner's own configured model
// does the vision — no separate describe-to-text call.

/**
 * Public entry. Signature mirrors legacy `routeMessage`.
 *
 * @param {string} userMessage
 * @param {object} envContext
 * @param {object} opts
 * @param {string|null} [opts.conversationId] - understanding-agent thread label
 * @param {Array} [opts.priorMessages] - prior router-dialog turns (clarify rounds)
 * @param {function|null} [opts.onProgress] - SSE progress callback ({chars, elapsedMs})
 * @param {Array|null} [opts.uploads] - user-attached files this turn
 * @param {string} [opts.workspaceDir]
 * @param {number|null} [opts.sessionFirstMessageChars]
 * @returns {Promise<RouterResult>} parseRouterJSON-compatible shape
 */
export async function routeMessage(userMessage, envContext, opts = {}) {
  const creds = getCredentials();
  if (!creds) {
    return errorResult('No credentials configured', null, '');
  }

  const understandingId = creds.understandingAssistantId;
  const contractId = creds.contractAssistantId;
  if (!understandingId || !contractId) {
    return errorResult(
      'Two-agent planner not configured. Run `npm run mga:bootstrap -- --admin` from chat/ to provision the missing assistants, or set understandingAssistantId + contractAssistantId in chat/server/config/assistants.json.',
      null,
      '',
    );
  }

  const workspaceDir = opts.workspaceDir || WORKSPACE_DIR;
  const priorMessages = opts.priorMessages || [];
  const isFirstTurn = priorMessages.length === 0;

  // ── Build enriched user message for understanding-agent ──
  const enrichedMessage = buildEnrichedUserMessage({
    userMessage,
    envContext,
    uploads: opts.uploads || null,
    workspaceDir,
    isFirstTurn,
  });

  maybeWarnPromptSize(enrichedMessage.length, opts.sessionFirstMessageChars || null);

  // ── Phase 1: Understanding Agent (SSE) ──
  const understandingStart = Date.now();
  let understandingContent, understandingConvoId;
  try {
    const result = await callUnderstandingAgentSSE({
      assistantId: understandingId,
      priorMessages,
      enrichedMessage,
      uploads: opts.uploads || null,
      workspaceDir,
      onProgress: opts.onProgress || null,
    });
    understandingContent = result.content;
    understandingConvoId = result.responseConversationId;
  } catch (err) {
    return errorResult(
      `Understanding agent call failed: ${err.message}`,
      opts.conversationId || null,
      enrichedMessage,
    );
  }
  console.log('[two-agent] understanding response in %dms (%d chars), conversation=%s',
    Date.now() - understandingStart, understandingContent.length, understandingConvoId);

  const understandingParsed = tryParseJSON(understandingContent);
  if (!understandingParsed) {
    console.warn('[two-agent] understanding response did not parse as JSON — treating as clarify');
    return clarifyResult({
      message: understandingContent || 'The planner did not respond with valid JSON. Please try rephrasing.',
      conversationId: understandingConvoId,
      sentUserMessage: enrichedMessage,
      rawAssistantResponse: understandingContent,
    });
  }

  // Understanding agent emits two actions: clarify (relay to user) or ready (brief).
  if (understandingParsed.action === 'clarify') {
    return clarifyResult({
      message: typeof understandingParsed.message === 'string' ? understandingParsed.message : '',
      questions: understandingParsed.questions,
      conversationId: understandingConvoId,
      sentUserMessage: enrichedMessage,
      rawAssistantResponse: understandingContent,
    });
  }

  if (understandingParsed.action !== 'ready' || !understandingParsed.brief) {
    console.warn('[two-agent] understanding emitted unexpected action=%s — falling back to clarify', understandingParsed.action);
    return clarifyResult({
      message: `Planner emitted unexpected action "${understandingParsed.action}". Please try again.`,
      conversationId: understandingConvoId,
      sentUserMessage: enrichedMessage,
      rawAssistantResponse: understandingContent,
    });
  }

  const brief = understandingParsed.brief;
  const hybridSignals = brief?.hybrid_signals || null;
  console.log('[two-agent] brief.hybrid_signals=%s', JSON.stringify(hybridSignals));

  // ── Phase 2: Contract Agent FRESH (with one retry on validator failure) ──
  const contractStart = Date.now();
  const callContractAgent = makeContractAgentCaller({ assistantId: contractId });
  const contractResult = await runContractAgentWithRetry(brief, callContractAgent, { mode: 'execute', hybridSignals });
  console.log('[two-agent] contract result in %dms ok=%s attempt=%s',
    Date.now() - contractStart, contractResult.ok, contractResult.attempt || 'n/a');
  if (contractResult.ok && contractResult.contract) {
    const confidence = typeof contractResult.contract.confidence === 'number'
      ? contractResult.contract.confidence
      : 'n/a';
    const reasonCodes = Array.isArray(contractResult.contract.reasonCodes)
      ? contractResult.contract.reasonCodes
      : [];
    const modulePlan = Array.isArray(contractResult.contract.modulePlan)
      ? contractResult.contract.modulePlan
      : null;
    const moduleNames = modulePlan ? modulePlan.map((m) => m?.module).filter(Boolean) : [];
    console.log(
      '[two-agent] contract.hybrid decision: confidence=%s reasonCodes=%s modulePlan=%s modules=%s',
      confidence,
      JSON.stringify(reasonCodes),
      modulePlan ? `len=${modulePlan.length}` : 'null',
      JSON.stringify(moduleNames),
    );
  }

  if (!contractResult.ok) {
    // Retry-once exhausted. Surface as clarify with the violations so the user
    // can rephrase or the maintainer can debug. The conversationId carried
    // here is the UNDERSTANDING agent's — the next turn re-enters the loop
    // with that thread, which is the same UX as the validator-exhausted case
    // would have hit in legacy router (clarify-style fallback).
    const violations = (contractResult.violations || []).join('; ');
    return clarifyResult({
      message: `The planner failed to emit a valid contract after one retry. Validator violations: ${violations || 'unknown'}. Please rephrase your request.`,
      conversationId: understandingConvoId,
      sentUserMessage: enrichedMessage,
      rawAssistantResponse: understandingContent,
    });
  }

  // Validator returned a parseRouterJSON-compatible shape. Wrap into the
  // full router-result envelope routes.js expects.
  return executeResult({
    contract: contractResult.contract,
    contractAttempt: contractResult.attempt || 1,
    softCorrects: contractResult.softCorrects || [],
    conversationId: understandingConvoId,
    sentUserMessage: enrichedMessage,
    rawAssistantResponse: understandingContent,
    // PR 2 / Alt A — the contract agent's messages[] (system + user(brief)
    // + assistant(contract)). Persisted into pendingPlan and threaded
    // through tryAutoStartApp so the reconciler-judge can continue this
    // conversation when classifying extras.
    contractAgentMessages: contractResult.messages || null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose the user message sent to the understanding-agent on this turn.
 *
 * First turn:    [Project Context] + [Attached files] + [User Message]
 * Follow-up:     === PROJECT MEMORY === + [Attached files] + bare user msg
 *
 * The follow-up shape matches legacy router behaviour: priorMessages already
 * carries the first-turn enriched message, so re-sending project context
 * would just inflate the prompt.
 */
export function _testables_buildEnrichedUserMessage(args) { return buildEnrichedUserMessage(args); }

function buildEnrichedUserMessage({ userMessage, envContext, uploads, workspaceDir, isFirstTurn }) {
  const attached = buildAttachedFilesBlock(uploads);

  if (isFirstTurn) {
    const ctx = buildProjectContext(envContext);
    const parts = [];
    if (ctx) parts.push(ctx);
    if (attached) parts.push(attached);
    parts.push(`[User Message]\n${userMessage}`);
    return parts.join('\n\n');
  }

  // Follow-up turn — inject project memory if `.harness/` is populated.
  const memory = buildProjectMemoryBlock(workspaceDir);
  const parts = [];
  if (memory) parts.push(memory);
  if (attached) parts.push(attached);
  parts.push(`[User Message]\n${userMessage}`);
  return parts.join('\n\n');
}

/**
 * Stream the understanding-agent response via /chat/completions.
 *
 * Why /chat/completions: /chat/agent's conversation_id doesn't actually
 * load prior context into the LLM (see /tmp/cache-probes/
 * MGA_ANTHROPIC_CACHING.md — referenced by chat/server/agent/agent.js).
 * The understanding agent is a multi-turn clarify loop — without real
 * memory it can't track what it already asked the user. We own
 * priorMessages on the caller side (session.routerMessages), so we just
 * pass them as the messages[] array along with the system prompt.
 *
 * Cache: cache_control on the system block. The understanding-agent
 * prompt is large + identical across clarify turns within a session,
 * so the prefix hits Anthropic's prompt cache from turn 2 onward.
 */
async function callUnderstandingAgentSSE({ assistantId, priorMessages, enrichedMessage, uploads, workspaceDir, onProgress }) {
  // Map onProgress (legacy: { chars, elapsedMs }) onto callMgaCompletions's
  // onTextDelta hook so the UI router_status events still fire.
  let accumulated = '';
  const startTime = Date.now();
  let lastProgressAt = 0;
  const onTextDelta = (delta) => {
    accumulated += delta;
    if (onProgress && Date.now() - lastProgressAt > 500) {
      lastProgressAt = Date.now();
      onProgress({ chars: accumulated.length, elapsedMs: Date.now() - startTime });
    }
  };

  // Instructions from disk (chat/prompts/understanding-agent.md). Model is
  // resolved from config via pickModel — no getAssistantConfig / assistant
  // lookup, so this runs anywhere with a valid MGA /chat/completions key.
  const instructions = loadPrompt('understanding-agent.md');
  // Embed this turn's image uploads (mockups/screenshots) as OpenAI image_url
  // blocks so the planner's model SEES them; non-images already surface as text
  // inside enrichedMessage. No images → keep the plain string-content shape.
  const imageBlocks = buildImageBlocks(uploads, workspaceDir, 'understanding-agent');
  const userContent = imageBlocks.length === 0
    ? enrichedMessage
    : [{ type: 'text', text: enrichedMessage }, ...imageBlocks];
  const messages = [
    { role: 'system', content: [{
        type: 'text',
        text: instructions,
        cache_control: { type: 'ephemeral' },
    }]},
    // priorMessages is the multi-turn clarify history (user/assistant
    // pairs from session.routerMessages). The system prompt + this
    // history form the cached prefix on follow-up calls within the
    // 5-min TTL.
    ...priorMessages,
    { role: 'user', content: userContent },
  ];
  const picked = pickModel({ phase: 'UNDERSTANDING', scope: 'planner' });
  console.log('[two-agent] Understanding (/chat/completions): assistant=%s model=%s%s prior=%d',
    assistantId, picked.model, picked.source, priorMessages.length);
  const { content } = await callMgaCompletions({
    messages,
    model: picked.model,
    assistantLabel: 'Understanding-Agent',
    phase: 'UNDERSTANDING',
    scope: 'planner',
    onTextDelta,
  });
  // /chat/completions doesn't return a conversation_id — return null so
  // the caller stores null. priorMessages on the next turn is the real
  // continuity mechanism, not the conv_id.
  return { content, responseConversationId: null };
}

/**
 * Build the closure that the retry-wrapper calls to invoke the contract-agent.
 *
 * Uses `/chat/completions` (Alt A — PR 2). We own the messages[] array so
 * the reconciler-judge can append a JUDGE turn to it later and the model
 * sees its own prior contract decision when classifying extras.
 *
 * Caching: cache_control on the system block — the system prompt
 * (contract-agent.md, ~5K tokens) is identical across both the FRESH and
 * the optional retry call within this build, and identical again when
 * the reconciler appends a JUDGE turn within the 5-min TTL.
 *
 * Each call returns `{ content, conversationId: null, messages }` where
 * `messages` is `[system, user(input), assistant(content)]` — the
 * pre-image the reconciler continues from.
 */
export function makeContractAgentCaller({ assistantId }) {
  return async function callContractAgent(input) {
    const userMessage = JSON.stringify(input, null, 2);

    // Instructions from disk (chat/prompts/contract-agent.md); model resolved
    // from config via pickModel (no assistant lookup). The reconciler-judge
    // continuation (judge-extras.js) shares this same contract-agent prompt.
    const instructions = loadPrompt('contract-agent.md');
    const messages = [
      { role: 'system', content: [{
          type: 'text',
          text: instructions,
          cache_control: { type: 'ephemeral' },
      }]},
      { role: 'user', content: userMessage },
    ];
    const picked = pickModel({ phase: 'CONTRACT', scope: 'planner' });
    console.log('[two-agent] Contract (/chat/completions): assistant=%s model=%s%s',
      assistantId, picked.model, picked.source);
    const { content } = await callMgaCompletions({
      messages,
      model: picked.model,
      assistantLabel: 'Contract-Agent',
      phase: 'CONTRACT',
      scope: 'planner',
    });
    return {
      content,
      conversationId: null,
      messages: [...messages, { role: 'assistant', content }],
    };
  };
}

/**
 * Robust JSON extraction from LLM output. Mirrors the helper in
 * [two-agent-parser.js](./two-agent-parser.js) — duplicated rather than
 * cross-imported to keep this module self-contained.
 */
function tryParseJSON(content) {
  if (!content || !content.trim()) return null;
  try { return JSON.parse(content.trim()); } catch { /* fall through */ }

  const codeBlock = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }

  const firstBrace = content.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0, inString = false, escape = false;
    for (let i = firstBrace; i < content.length; i++) {
      const ch = content[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(content.substring(firstBrace, i + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result-shape constructors — every router-result returned by routeMessage
// has the same envelope so [routes.js](../../session/routes.js) doesn't
// need conditional null-checks across action types.
// ─────────────────────────────────────────────────────────────────────────────

function emptyContractFields() {
  return {
    tasks: [],
    flags: [],
    dataModel: null,
    apiContract: null,
    uiContract: null,
    businessLogicContract: null,
    vectorEngine: null,
    mgaAssistants: [],
    contractDiffs: null,
    affectedScopes: [],
    symptom: null,
    suspectedScope: null,
    softCorrects: [],
  };
}

function clarifyResult({ message, questions, conversationId, sentUserMessage, rawAssistantResponse }) {
  return {
    action: 'clarify',
    message,
    questions: normalizeClarifyQuestions(questions),
    conversationId,
    sentUserMessage,
    rawAssistantResponse,
    ...emptyContractFields(),
  };
}

function executeResult({ contract, softCorrects, conversationId, sentUserMessage, rawAssistantResponse, contractAgentMessages = null, contractAttempt = 1 }) {
  return {
    action: 'execute',
    message: contract.message || '',
    contractAttempt,
    tasks: contract.tasks,
    flags: contract.flags,
    dataModel: contract.dataModel,
    apiContract: contract.apiContract,
    uiContract: contract.uiContract,
    businessLogicContract: contract.businessLogicContract,
    vectorEngine: contract.vectorEngine,
    mgaAssistants: contract.mgaAssistants,
    contractDiffs: null,
    affectedScopes: [],
    symptom: null,
    suspectedScope: null,
    conversationId,
    softCorrects,
    sentUserMessage,
    rawAssistantResponse,
    contractAgentMessages,
    // Hybrid module plan fields — emitted by Contract Agent in FRESH mode.
    // null/defaults when absent (deterministic path unchanged).
    modulePlan: contract.modulePlan || null,
    confidence: typeof contract.confidence === 'number' ? contract.confidence : 1.0,
    reasonCodes: Array.isArray(contract.reasonCodes) ? contract.reasonCodes : [],
    aiNeed: contract.aiNeed || 'optional',
    aiEvidence: Array.isArray(contract.aiEvidence) ? contract.aiEvidence : [],
    // RAG architecture decision — emitted by Contract Agent when has_rag_pattern signal is true.
    // null/undefined when RAG pattern not detected (no RAG configuration needed).
    ragArchitecture: contract.ragArchitecture || null,
  };
}

function errorResult(message, conversationId, sentUserMessage) {
  return {
    action: 'clarify',
    message,
    conversationId,
    sentUserMessage,
    rawAssistantResponse: '',
    ...emptyContractFields(),
  };
}
