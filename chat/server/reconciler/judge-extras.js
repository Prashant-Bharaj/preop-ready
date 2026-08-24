/**
 * LLM-judge for ambiguous "extras" the deterministic comparator can't classify
 * on its own.
 *
 * Input shape (per extra):
 *   { kind, scope, method, path, contract, component, evidence, ... }
 *
 * Output shape:
 *   { ...extra, judgment: 'legitimate' | 'mismatch:<contract-id>' | 'noise' }
 *
 * Default backend uses the orchestrator's MGA assistant id — the judge call
 * is small and narrow (single contract slice + single extra item per call).
 * Tests inject `judge` to run synchronously without hitting MGA. If the
 * orchestrator assistant isn't configured, judge defaults to 'legitimate'
 * for backend extras (don't block builds on missing config) and 'noise' for
 * coverage gaps (the comparator already classified these as missing).
 */

// Cap on extras per judge call. Beyond ~10 the model starts dropping items
// from the output array. 10 is empirically safe.
const JUDGE_BATCH_MAX = 10;

// User-message builder for a batch of extras. The contract agent's system
// prompt (chat/prompts/contract-agent.md Section 13) carries the rubric + the
// batched I/O contract; this builder just supplies the per-call inputs.
//
// `batch` is an array of 1..JUDGE_BATCH_MAX extras that share `kind` + `scope`
// (so they share contract slice + sibling rule). The contract agent returns
// an array of N verdict objects in the same order.
const BATCHED_PROMPT = (batch, contractsSlice, siblingExtras, buildIntent) => {
  return [
    '=== BUILD INTENT ===',
    buildIntent || '(no task summaries available — judge based on contract + extras alone)',
    '',
    '=== ROUTER CONTRACT (relevant slice) ===',
    JSON.stringify(contractsSlice, null, 2),
    '',
    `=== EXTRAS (array of ${batch.length} item${batch.length === 1 ? '' : 's'} to classify) ===`,
    JSON.stringify(batch, null, 2),
    '',
    '=== SIBLING EXTRAS ===',
    siblingExtras.length > 0 ? JSON.stringify(siblingExtras, null, 2) : '(none)',
    '',
    `Return a JSON array of ${batch.length} verdict object${batch.length === 1 ? '' : 's'} in the same order as the EXTRAS above.`,
  ].join('\n');
};

/**
 * Build a one-liner-per-scope summary from the router's tasks. Used as
 * "BUILD INTENT" so the judge can decide whether an extra fits the app's
 * purpose (e.g., /admin route on a single-user tracker = noise; same on a
 * team admin dashboard = legitimate).
 */
function summarizeBuildIntent(routerContracts) {
  const tasks = routerContracts.tasks || [];
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  return tasks
    .filter(t => t && t.scope && (t.summary || t.task))
    .map(t => `- [${t.scope}] ${t.summary || (t.task || '').slice(0, 120)}`)
    .join('\n');
}

/**
 * Slice routerContracts to the parts relevant to a single extra item, so the
 * judge call payload stays small. Routes-related extras get the full
 * apiContract.endpoints; UI-component extras get the components list.
 */
function contractSlice(extra, routerContracts) {
  const out = {};
  if (extra.scope === 'backend' || extra.scope === 'frontend') {
    out.endpoints = routerContracts.apiContract?.endpoints || [];
  }
  if (extra.kind === 'coverage-gap-ui-component') {
    out.components = routerContracts.uiContract?.components || [];
  }
  return out;
}

/**
 * Sibling extras the judge should see for cross-reference. When classifying a
 * `coverage-gap-backend` (contract had X but nobody implements), it's helpful
 * to see the `backend-extra-route` items (backend exposes Y not in contract)
 * — they may be the same feature renamed.
 */
function siblingsForExtra(extra, allExtras) {
  if (!Array.isArray(allExtras)) return [];
  // Cross-reference rule: routing extras see other routing extras.
  const routingKinds = new Set(['backend-extra-route', 'coverage-gap-backend', 'coverage-gap-frontend', 'frontend-extra-fetch']);
  if (!routingKinds.has(extra.kind)) return [];
  return allExtras.filter(e => e !== extra && routingKinds.has(e.kind));
}

import { tlog } from '../util/timestamped-log.js';
import { JUDGE_CALL_TIMEOUT_MS } from '../config/defaults.js';
import { pushReconcilerVerdict, flushReconcilerVerdicts, normaliseJudgeVerdict, classifyContractKind } from '../util/telemetry-verdicts.js';

/**
 * @param {Array} extras
 * @param {object} routerContracts
 * @param {object} [opts]
 * @param {(prompt:string, opts?:{signal?:AbortSignal})=>Promise<string>} [opts.judge] — injectable LLM caller. Returns raw response.
 * @param {string} [opts.workspaceDir] — when set, each verdict is also written
 *   structurally to `<workspaceDir>/.harness/reconciler-verdicts.jsonl` per
 *   Section M item 4 (W3.TEL). Emission is ADDITIVE — the existing tlog line
 *   stays. Falsy / unset → no jsonl write (back-compat for tests + callers
 *   that don't have a workspace yet).
 * @param {(record: object) => void} [opts.onVerdict] — optional in-process
 *   sink invoked once per emitted verdict (same record as the jsonl line).
 *   Used by the session-level run-summary aggregator to maintain the
 *   `session.reconcilerVerdictCounts` mirror without re-parsing the jsonl.
 * @returns {Promise<Array>}
 */
export async function judgeExtras(extras, routerContracts, opts = {}) {
  if (!extras || extras.length === 0) return [];
  const judge = opts.judge || defaultJudge;
  const buildIntent = summarizeBuildIntent(routerContracts);
  const workspaceDir = opts.workspaceDir || null;
  const onVerdict = typeof opts.onVerdict === 'function' ? opts.onVerdict : null;
  // PR 2 / Alt A — when present, defaultJudge continues the contract
  // agent's prior conversation via /chat/completions instead of making
  // a fresh stateless /chat/agent call. The judge sees its own contract
  // decision when classifying extras. Threaded through each batch call.
  const contractAgentMessages = Array.isArray(opts.contractAgentMessages) && opts.contractAgentMessages.length > 0
    ? opts.contractAgentMessages
    : null;

  // Group extras by (kind, scope). Within a group, items share the same
  // contract slice + sibling rule, so we can judge them in a single batched
  // MGA call. Previously: N MGA calls in parallel (one per extra). Now:
  // ceil(N / JUDGE_BATCH_MAX) MGA calls — typically 1-3 instead of 20-80.
  // Each call amortizes the system prompt over many items, which is most of
  // the prompt cost.
  const groupsMap = new Map();
  for (const e of extras) {
    const key = `${e.kind || 'unknown'}::${e.scope || 'unknown'}`;
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(e);
  }
  // Split any group larger than JUDGE_BATCH_MAX into chunks so we don't ask
  // the model to track too many items per response.
  const batches = [];
  for (const [key, group] of groupsMap) {
    for (let i = 0; i < group.length; i += JUDGE_BATCH_MAX) {
      batches.push({ key, items: group.slice(i, i + JUDGE_BATCH_MAX) });
    }
  }

  const batchStart = Date.now();
  tlog('[reconciler-judge] start: %d extra(s) → %d batched call(s) (groups=%d, max-per-call=%d)',
    extras.length, batches.length, groupsMap.size, JUDGE_BATCH_MAX);

  // Per-extra results, keyed by reference so we can stitch back in input order.
  const judgmentByExtra = new Map();
  const callDurations = [];
  let aborts = 0;

  // Run batched calls in parallel (each batch is one MGA call).
  await Promise.all(batches.map(async (batch) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_CALL_TIMEOUT_MS);
    const callStart = Date.now();
    const sample = batch.items[0];
    let outcome = 'ok';
    let verdicts = null;
    try {
      const slice = contractSlice(sample, routerContracts);
      // Siblings for a batch: extras that are NOT in this batch but share
      // the cross-reference set (routing kinds).
      const siblings = siblingsForBatch(batch.items, extras);
      const prompt = BATCHED_PROMPT(batch.items, slice, siblings, buildIntent);
      const raw = await judge(prompt, { signal: controller.signal, contractAgentMessages });
      verdicts = parseBatchedJudgment(raw, batch.items.length);
    } catch (err) {
      outcome = controller.signal.aborted ? 'abort' : 'err';
      if (outcome === 'abort') aborts++;
      verdicts = null;
    } finally {
      clearTimeout(timer);
    }
    const dur = Date.now() - callStart;
    callDurations.push(dur);

    // Distribute verdicts back to items. If the batched call failed or the
    // response didn't parse to an array of the expected length, apply the
    // kind-aware fallback to every item in the batch.
    for (let i = 0; i < batch.items.length; i++) {
      const e = batch.items[i];
      const judgment = (verdicts && verdicts[i])
        ? verdicts[i]
        : (e.kind?.startsWith('coverage-gap-') ? 'noise' : 'legitimate');
      judgmentByExtra.set(e, judgment);
      tlog('[reconciler-judge] verdict kind=%s scope=%s item=%d/%d outcome=%s verdict=%s',
        e.kind, e.scope, i + 1, batch.items.length, outcome, judgment);
      const { verdict, target } = normaliseJudgeVerdict(judgment);
      const verdictRecord = {
        scope: e.scope || null,
        contractItem: e.method && e.path ? `${e.method} ${e.path}`
          : (e.path || e.component || e.kind || null),
        kind: classifyContractKind(e),
        verdict,
        target,
        reasoning: null,
      };
      if (workspaceDir) pushReconcilerVerdict(workspaceDir, verdictRecord);
      if (onVerdict) {
        try { onVerdict(verdictRecord); } catch { /* sink errors must not affect judging */ }
      }
    }
    tlog('[reconciler-judge] batch done: key=%s items=%d dur=%dms outcome=%s',
      batch.key, batch.items.length, dur, outcome);
  }));

  const wall = Date.now() - batchStart;
  const sumSeq = callDurations.reduce((a, b) => a + b, 0);
  const max = callDurations.length ? Math.max(...callDurations) : 0;
  tlog('[reconciler-judge] done: %d extra(s) across %d batch(es) in %dms wall (sum-if-seq=%dms parallelism=%sx max=%dms aborts=%d)',
    extras.length, batches.length, wall, sumSeq, (sumSeq / Math.max(wall, 1)).toFixed(2), max, aborts);
  if (workspaceDir) flushReconcilerVerdicts(workspaceDir);

  // Return in original input order.
  return extras.map(e => ({ ...e, judgment: judgmentByExtra.get(e) }));
}

/**
 * Siblings rule for a batch (replaces siblingsForExtra). When the batch is a
 * routing-class kind, surface OTHER routing extras (not in this batch) for
 * cross-reference. Otherwise, no siblings.
 */
function siblingsForBatch(batchItems, allExtras) {
  if (!Array.isArray(allExtras)) return [];
  const routingKinds = new Set(['backend-extra-route', 'coverage-gap-backend', 'coverage-gap-frontend', 'frontend-extra-fetch']);
  const sampleKind = batchItems[0]?.kind;
  if (!routingKinds.has(sampleKind)) return [];
  const batchSet = new Set(batchItems);
  return allExtras.filter(e => !batchSet.has(e) && routingKinds.has(e.kind));
}

/**
 * Parse the assistant's batched response into an array of verdict TOKENS
 * (matching the existing parseJudgment signature). Returns null on any
 * failure — caller applies the kind-aware fallback.
 */
function parseBatchedJudgment(raw, expectedLength) {
  if (!raw) return null;
  let arr;
  try {
    // Strip code fences if the model wrapped JSON in ```
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    arr = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  if (arr.length !== expectedLength) {
    // Length mismatch — could be model dropping items. Reject the whole
    // batch and let the kind-aware fallback apply.
    return null;
  }
  // Map each entry to a verdict TOKEN (same shape parseJudgment returned).
  return arr.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const v = entry.verdict;
    if (typeof v !== 'string') return null;
    // Accept the three canonical tokens.
    if (v === 'legitimate' || v === 'noise') return v;
    if (v.startsWith('mismatch:')) return v;
    return null;
  });
}

/**
 * Parse the judge's response. Two accepted formats:
 *
 * 1. JSON (preferred — what the deployed reconciler-judge prompt asks for):
 *    {"verdict": "legitimate" | "mismatch:<id>" | "noise", "target": "...", "reasoning": "..."}
 * 2. Bare token (fallback if assistant ignores the output contract):
 *    "legitimate" | "mismatch:<id>" | "noise"
 *
 * Anything we can't parse defaults to "legitimate" — the judge is advisory,
 * not load-bearing; never block a build on a parse failure.
 */
function parseJudgment(raw) {
  if (!raw) return 'legitimate';
  const text = String(raw).trim();

  // Try JSON first (handles ```json wrappers too).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj.verdict === 'string') {
        const verdict = obj.verdict.trim();
        if (/^legitimate$/i.test(verdict)) return 'legitimate';
        if (/^noise$/i.test(verdict)) return 'noise';
        const m = verdict.match(/^mismatch:(.+)$/i);
        if (m) return `mismatch:${m[1].trim()}`;
      }
    } catch {
      // fall through to bare-token parsing
    }
  }

  // Bare token fallback.
  const s = text.toLowerCase();
  if (s.startsWith('legitimate')) return 'legitimate';
  if (s.startsWith('noise')) return 'noise';
  const m = s.match(/^mismatch:(.+)$/);
  if (m) return `mismatch:${m[1].trim()}`;
  return 'legitimate';
}

// Default judge: real MGA-backed call routed through the **Contract Agent**.
//
// Two transport modes, picked at call time:
//
//   1. CONTINUATION (when caller passes `contractAgentMessages`) — append
//      the judge prompt as a new user turn to the contract agent's prior
//      messages[] and call /chat/completions. The model sees its own
//      contract decision when classifying extras; the system + brief +
//      contract response prefix hits Anthropic's prompt cache (set up by
//      makeContractAgentCaller in two-agent.js) on subsequent batch
//      calls within the 5-min TTL.
//
//   2. STATELESS (no contractAgentMessages or env opt-in to legacy) —
//      single-shot /chat/completions call through the contract agent or
//      the dedicated reconciler-judge assistant, with the system prompt
//      loaded from disk (chat/prompts/contract-agent.md JUDGE mode, or
//      chat/prompts/reconciler-judge.md for the legacy assistant). The
//      continuation path just adds "the model remembers its own contract
//      decision" on top of the same JUDGE rubric.
//
// Env opt-outs:
//   - JUDGE_USE_LEGACY_RECONCILER=true → route to the dedicated
//     reconciler-judge assistant instead of the contract agent (fallback
//     during migration). Forces STATELESS mode.
//   - JUDGE_DISABLE_CONTINUATION=true → use STATELESS even when
//     contractAgentMessages is provided. Useful for A/B comparisons.
//
// If no assistant is configured, returns 'legitimate' so tests can
// exercise judgeExtras without MGA.
async function defaultJudge(prompt, { signal, contractAgentMessages = null } = {}) {
  const { getCredentials } = await import('../core/auth.js');
  const creds = getCredentials() || {};
  const useLegacy = process.env.JUDGE_USE_LEGACY_RECONCILER === 'true';
  const disableContinuation = process.env.JUDGE_DISABLE_CONTINUATION === 'true';

  const assistantId = useLegacy
    ? creds.reconcilerJudgeAssistantId
    : (creds.contractAssistantId || creds.reconcilerJudgeAssistantId);
  if (!assistantId) return 'legitimate';

  const { deriveRunContext } = await import('../agent/compaction/run-logger.js');
  const { WORKSPACE_DIR } = await import('../core/paths.js');
  const runContext = deriveRunContext(WORKSPACE_DIR);

  // CONTINUATION path: only when we have the contract agent's prior
  // conversation AND we're routing to the contract agent (not the legacy
  // dedicated judge — that assistant has no contract context to continue).
  if (!useLegacy && !disableContinuation && Array.isArray(contractAgentMessages) && contractAgentMessages.length > 0) {
    try {
      const { callMgaCompletions } = await import('../agent/llm/llm.js');
      const { pickModel } = await import('../agent/llm/model-picker.js');
      const messages = [
        ...contractAgentMessages,
        { role: 'user', content: prompt },
      ];
      const picked = pickModel({ phase: 'JUDGE', scope: 'reconciler' });
      const result = await callMgaCompletions({
        messages,
        model: picked.model,
        assistantLabel: 'Contract-Agent-Judge',
        runContext, phase: 'JUDGE', scope: 'reconciler', signal,
      });
      return result.content || 'legitimate';
    } catch (err) {
      // Fall through to stateless path on any continuation failure.
      // Continuation is purely an enhancement; never block a build on it.
      tlog('[reconciler-judge] continuation failed (%s) — falling back to stateless', err.message);
    }
  }

  // STATELESS path: single-shot /chat/completions through whichever
  // assistant is configured. System prompt loaded from disk so the JUDGE
  // call works without depending on MGA's stored instructions field.
  const { callMgaCompletions } = await import('../agent/llm/llm.js');
  const { pickModel } = await import('../agent/llm/model-picker.js');
  const { loadPrompt } = await import('../agent/prompts/disk-prompt.js');

  // Legacy assistant gets the dedicated reconciler-judge prompt;
  // contract assistant gets contract-agent.md (JUDGE mode lives in Section 13).
  const promptFile = useLegacy ? 'reconciler-judge.md' : 'contract-agent.md';
  const instructions = loadPrompt(promptFile);
  const messages = [
    { role: 'system', content: [{
        type: 'text',
        text: instructions,
        cache_control: { type: 'ephemeral' },
    }]},
    { role: 'user', content: prompt },
  ];
  const picked = pickModel({ phase: 'JUDGE', scope: 'reconciler' });
  const result = await callMgaCompletions({
    messages,
    model: picked.model,
    assistantLabel: useLegacy ? 'Reconciler-Judge' : 'Contract-Agent-Judge',
    runContext, phase: 'JUDGE', scope: 'reconciler', signal,
  });
  return result.content || 'legitimate';
}
