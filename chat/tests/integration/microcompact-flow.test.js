/**
 * Coverage: flow 7 (multi-turn session) primary, flow 8 (recovery context
 * preservation) secondary, via chain
 *   flow 7 → between iterations, context grows past threshold → microcompact
 *           fires → old tool-results summarized → afterTokens < beforeTokens
 *           → next iteration continues with compacted history
 *   flow 8 → when summarizer is unavailable, microcompact contains the
 *           failure (logAndSwallow) → recovery path still proceeds without
 *           crashing the iteration
 *
 * Migrated from `tests/agents/test-microcompact.js` (Dispatch 3 — original
 * was a scripted `process.exit(N)` driver, W4.BUDGET.2 verification). Same
 * code paths exercised, same assertions made; the wrapping is mechanical.
 *
 * Integration tier: real `maybeMicrocompact` from agent/compaction. Summarizer
 * stubbed in-process (the brief-stated W4.BUDGET.2 test seam). No MGA, no
 * Docker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeMicrocompact } from '../../server/agent/compaction/microcompact-iteration.js';
import { VirtualHistoryManager } from '../../server/agent/compaction/history.js';
import {
  MICROCOMPACT_HISTORY_THRESHOLD_RATIO,
  MICROCOMPACT_MODEL_WINDOW_TOKENS,
  MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE,
} from '../../server/config/defaults.js';

const THRESHOLD = Math.floor(MICROCOMPACT_MODEL_WINDOW_TOKENS * MICROCOMPACT_HISTORY_THRESHOLD_RATIO);

function makeStubSummarizer({ available = true, summaryText = 'Compacted: read foo.ts, wrote bar.ts, no errors.' } = {}) {
  const calls = [];
  return {
    client: {
      available,
      async summarizeTranscript(transcript, opts = {}) {
        calls.push({ transcript, opts });
        if (!available) {
          throw new Error('summarizer unavailable (stub)');
        }
        return {
          rawResponse: `<summary>${summaryText}</summary>`,
          summary: summaryText,
          analysis: null,
          usage: { prompt_tokens: 1000, completion_tokens: 50 },
          elapsedMs: 5,
          mode: opts.mode || 'lite',
        };
      },
    },
    calls,
  };
}

function buildHistoryAtTokens(targetTokens, { withToolCalls = 2 } = {}) {
  const h = new VirtualHistoryManager({ conversationId: 'stub', scope: 'backend' });
  h.recordUserMessage('initial user message — small');
  const tokensPerTurn = Math.ceil(targetTokens / Math.max(withToolCalls, 1));
  for (let i = 0; i < withToolCalls; i++) {
    h.recordUserMessage(`tool result wrap turn ${i + 1}`);
    h.recordAssistantResponse(`assistant turn ${i + 1} narrative`, {
      prompt_tokens: tokensPerTurn,
      completion_tokens: 0,
    });
    h.recordToolCall('read_file', { path: `src/file${i + 1}.ts` }, 'x'.repeat(500));
  }
  return h;
}

function makeEmitCapture() {
  const events = [];
  return {
    emit: (payload) => { events.push(payload); },
    events,
  };
}

// ── SCENARIO 1 — under threshold ──────────────────────────────────────────

test('SCENARIO 1 — under threshold: fired=false, no summarizer call, no event', async () => {
  const history = buildHistoryAtTokens(Math.floor(THRESHOLD * 0.3), { withToolCalls: 2 });
  const stub = makeStubSummarizer({ available: true });
  const cap = makeEmitCapture();
  const result = await maybeMicrocompact({
    history,
    summarizerClient: stub.client,
    iter: 3,
    emitEvent: cap.emit,
  });
  assert.equal(result.fired, false, 'expected fired=false under threshold');
  assert.equal(result.reason, 'under-threshold', `unexpected reason: ${result.reason}`);
  assert.equal(stub.calls.length, 0, 'summarizer must not be called when under threshold');
  assert.equal(cap.events.length, 0, 'no microcompact_fired event should be emitted');
});

// ── SCENARIO 2 — over threshold, summarizer available ─────────────────────

test('SCENARIO 2 — over threshold, summarizer available: fires, ratio<1, event emitted', async () => {
  const target = Math.floor(THRESHOLD * 1.1);
  const history = buildHistoryAtTokens(target, { withToolCalls: 3 });
  const stub = makeStubSummarizer({ available: true, summaryText: 'A short compacted note.' });
  const cap = makeEmitCapture();
  const result = await maybeMicrocompact({
    history,
    summarizerClient: stub.client,
    iter: 7,
    emitEvent: cap.emit,
  });

  assert.equal(result.fired, true, `expected fired=true (beforeTokens=${result.beforeTokens}, threshold=${THRESHOLD})`);
  assert.equal(result.blocksSummarised, MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE,
    `expected ${MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE} blocks summarised, got ${result.blocksSummarised}`);
  assert.ok(result.beforeTokens > THRESHOLD,
    `beforeTokens=${result.beforeTokens} must exceed threshold=${THRESHOLD}`);
  assert.ok(result.afterTokens < result.beforeTokens,
    `afterTokens=${result.afterTokens} must be < beforeTokens=${result.beforeTokens}`);
  assert.ok(result.ratio < 1, `ratio=${result.ratio} must be < 1`);
  assert.equal(stub.calls.length, 1, 'summarizer must be called exactly once');
  assert.equal(stub.calls[0].opts.mode, 'lite', 'summarizer must be called in lite mode');
  assert.equal(cap.events.length, 1, 'exactly one microcompact_fired event expected');

  const ev = cap.events[0];
  assert.equal(ev.say, 'microcompact_fired', `event say must be microcompact_fired, got ${ev.say}`);
  assert.equal(ev.blocksSummarised, MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE);
  assert.ok(ev.beforeTokens > 0 && ev.afterTokens > 0, 'event must carry before/after token counts');
  assert.ok(ev.ratio > 0 && ev.ratio < 1, 'event ratio must be in (0,1)');
  assert.equal(ev.iter, 7, 'event must carry iter index');
  assert.ok(Array.isArray(ev.coveredTurns) && ev.coveredTurns.length === MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE,
    'event must list coveredTurns');
});

// ── SCENARIO 3 — over threshold, summarizer unavailable ───────────────────

test('SCENARIO 3 — summarizer unavailable: fired=false, no throw, no event (recovery flow continues)', async () => {
  const target = Math.floor(THRESHOLD * 1.1);
  const history = buildHistoryAtTokens(target, { withToolCalls: 3 });
  const stub = makeStubSummarizer({ available: false });
  const cap = makeEmitCapture();
  let threw = null;
  let result = null;
  try {
    result = await maybeMicrocompact({
      history,
      summarizerClient: stub.client,
      iter: 9,
      emitEvent: cap.emit,
    });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, 'maybeMicrocompact must not throw when summarizer is unavailable');
  assert.ok(result, 'maybeMicrocompact must return a result object');
  assert.equal(result.fired, false, 'expected fired=false when summarizer unavailable');
  assert.equal(result.reason, 'summarizer-unavailable', `unexpected reason: ${result.reason}`);
  assert.equal(stub.calls.length, 0, 'summarizer must not be invoked when unavailable');
  assert.equal(cap.events.length, 0, 'no event should be emitted on the unavailable path');
});

// ── SCENARIO 4 — over threshold, no tool-calls in history ─────────────────

test('SCENARIO 4 — over threshold but no tool-results: fired=false, no summarizer call, no event', async () => {
  const target = Math.floor(THRESHOLD * 1.1);
  const h = new VirtualHistoryManager({ conversationId: 'stub', scope: 'backend' });
  h.recordUserMessage('user');
  h.recordAssistantResponse('assistant text only', {
    prompt_tokens: target,
    completion_tokens: 0,
  });
  const stub = makeStubSummarizer({ available: true });
  const cap = makeEmitCapture();
  const result = await maybeMicrocompact({
    history: h,
    summarizerClient: stub.client,
    iter: 2,
    emitEvent: cap.emit,
  });
  assert.equal(result.fired, false, 'expected fired=false when no tool-results available');
  assert.equal(result.reason, 'no-tool-results-to-summarise', `unexpected reason: ${result.reason}`);
  assert.equal(stub.calls.length, 0, 'summarizer must not be called when there are no tool-results');
  assert.equal(cap.events.length, 0, 'no event when nothing to compact');
});
