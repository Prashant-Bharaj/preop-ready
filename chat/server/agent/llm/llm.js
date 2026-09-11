/**
 * LLM client for the custom agent — calls MGA's `/chat/completions`
 * endpoint. Caller picks which MGA assistant to dispatch via the
 * `assistantId` parameter; every dispatch picks an explicit assistant via
 * the phase + scope combo, with the orchestrator and per-scope subagents
 * owning the primary dispatch flows.
 *
 * Caller owns the full message history; the system prompt is sent every
 * call with cache_control on its text block so MGA's LiteLLM proxy
 * serves the prefix from Anthropic's prompt cache after turn 1. There
 * is no server-side conversation_id concept — that's the whole point.
 *
 * Streaming is SSE. We forward text deltas via `onTextDelta` as they
 * arrive so the UI sees incremental output. We return the accumulated
 * content + usage + computed costUsd.
 */

import { getCredentials } from '../../core/auth.js';
import { tlog } from '../../util/timestamped-log.js';
import { recordLlmCall } from '../compaction/run-logger.js';
import { computeCost } from '../../util/pricing.js';

function getPlatformBase(baseUrl) {
  return baseUrl.replace(/\/$/, '');
}

export class MgaLlmError extends Error {
  constructor(message, { status = null, modelId = null, providerId = null, idleTimeout = false } = {}) {
    super(message);
    this.name = 'MgaLlmError';
    this.status = status;
    this.modelId = modelId;
    this.providerId = providerId;
    this.idleTimeout = idleTimeout;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared SSE stream consumer + debug log writer for the /chat/completions
// path (OpenAI-compatible event shape).
// ─────────────────────────────────────────────────────────────────────────────

// Models that REJECT the `temperature` request body field with
// HTTP 400 ("temperature is deprecated for this model"). Anthropic's
// adaptive-thinking models that own sampling control internally. Verified
// empirically 2026-05-24:
//   - claude-opus-4.7  → REJECTS (only one observed so far)
//   - claude-opus-4.6  → accepts (and is deterministic by default)
//   - claude-opus-4.5  → accepts; deterministic on code prompts
//                        (0.22% spread = 1 char drift over 5 runs)
//   - claude-sonnet-4.6 → accepts
//   - claude-sonnet-4.5 → accepts
//   - claude-haiku-4.5  → accepts
//   - gpt-5-mini        → accepts
// Add a model id here when we hit a new one with the same rejection.
const TEMPERATURE_REJECTING_MODELS = new Set([
  'claude-opus-4.7',
]);

/**
 * Return true if `model` accepts a `temperature` body param. Used to
 * conditionally include temperature: 0 for code-generation determinism
 * without breaking calls to adaptive-thinking models that reject it.
 *
 * Returns false when model is null/undefined so we never trip a 400 by
 * setting temperature for an unknown model.
 */
function modelSupportsTemperature(model) {
  if (!model) return false;
  return !TEMPERATURE_REJECTING_MODELS.has(model);
}

async function _readSseStream(res, onTextDelta, onActivity = null) {
  let content = '';
  let conversationId = null; // /chat/agent only; /chat/completions never sets it
  let usage = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      // Real data event — reset the caller's inactivity watchdog. Raw bytes
      // don't count: SSE keepalives from a stalled upstream must still trip
      // the timeout.
      if (onActivity) onActivity();
      try {
        const data = JSON.parse(trimmed.slice(6));
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          if (onTextDelta) onTextDelta(delta);
          continue;
        }
        // Some platforms send full-message form
        if (data.choices?.[0]?.message?.content) {
          const whole = data.choices[0].message.content;
          const additional = whole.slice(content.length);
          content = whole;
          if (additional && onTextDelta) onTextDelta(additional);
        }
        if (data.conversation_id) conversationId = data.conversation_id;
        if (data.metadata?.conversation_id) conversationId = data.metadata.conversation_id;
        if (data.usage) usage = data.usage;
        if (data.metadata?.usage) usage = data.metadata.usage;
      } catch { /* malformed SSE line — skip */ }
    }
  }
  return { content, conversationId, usage };
}

// _appendDebugLog: best-effort writer to /tmp/llm-calls.log. Failures used
// to be swallowed (catch-all with no message), so when something went wrong
// (perm denied, disk full, EAGAIN under load) the log went silent without
// anybody noticing — observed 2026-05-24 where a smoke run's 11:36-11:47
// window produced zero entries despite real MGA traffic. Now we surface the
// failure to stderr ONCE per process per error kind so the next time it
// happens it's obvious from the run log.
const _debugLogFailureReasons = new Set();
async function _appendDebugLog(entry) {
  try {
    const fsp = await import('node:fs/promises');
    await fsp.appendFile('/tmp/llm-calls.log', JSON.stringify(entry) + '\n');
  } catch (err) {
    const reason = `${err.code || 'unknown'}:${err.message || String(err)}`;
    if (!_debugLogFailureReasons.has(reason)) {
      _debugLogFailureReasons.add(reason);
      console.warn('[llm-debug-log] write failed (first occurrence; further occurrences suppressed): %s', reason);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// _fetchWithRetry: transient-failure retry wrapper around `fetch`.
//
// Two failure classes are retried:
//   1. THROWN errors from fetch itself ("fetch failed", ECONNRESET,
//      ETIMEDOUT, ENOTFOUND, EAI_AGAIN, UND_ERR_*). These mean the request
//      never got a response — safe to retry.
//   2. HTTP responses with status 429 (rate limited), 408 (request
//      timeout), or 5xx (server-side). These mean the request reached MGA
//      but the upstream had a problem — usually safe to retry.
//
// NOT retried:
//   - AbortError / signal cancellation. The caller asked us to stop.
//   - HTTP 4xx other than 408/429 (auth, bad request, etc.). The request
//     is malformed and will fail identically on retry.
//
// Backoff: 1s, 2s, 4s with ±20% jitter. Total worst-case ~8s extra wall
// before final failure on attempt 3. Honors the request signal: if the
// caller aborts during the backoff, we bail immediately.
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function _isRetryableThrown(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const code = err.code || err.cause?.code || '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return true;
  if (typeof code === 'string' && code.startsWith('UND_ERR_')) return true;
  // Node's fetch wraps low-level errors as TypeError("fetch failed") with
  // the real reason in .cause — catch the generic case too.
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('socket hang up') || msg.includes('network')) return true;
  return false;
}

async function _sleep(ms, signal) {
  if (signal?.aborted) throw new MgaLlmError('Aborted before retry backoff', { status: null });
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new MgaLlmError('Aborted during retry backoff', { status: null })); }, { once: true });
    }
  });
}

async function _fetchWithRetry(url, init, { logLabel = 'mga-fetch' } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_MAX_ATTEMPTS) {
        // Drain body so the connection can be reused.
        await res.text().catch(() => null);
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4);
        console.warn('[%s] retryable status %d on attempt %d/%d — backing off %dms', logLabel, res.status, attempt, RETRY_MAX_ATTEMPTS, Math.round(delay));
        await _sleep(delay, init.signal);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!_isRetryableThrown(err) || attempt === RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4);
      console.warn('[%s] retryable network error on attempt %d/%d (%s) — backing off %dms',
        logLabel, attempt, RETRY_MAX_ATTEMPTS, err.message || err.code || 'unknown', Math.round(delay));
      await _sleep(delay, init.signal);
    }
  }
  throw lastErr || new MgaLlmError(`${logLabel}: retries exhausted`, { status: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// Assistant-config cache (lazy fetch, in-memory). Used by callMgaCompletions
// to pull the assistant's `instructions` (system prompt) + `model` from MGA
// once per process per assistant ID. /chat/agent doesn't need this — MGA owns
// the system prompt server-side on that endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const _assistantConfigCache = new Map();

export async function getAssistantConfig(assistantId) {
  if (!assistantId) throw new MgaLlmError('getAssistantConfig: assistantId required');
  if (_assistantConfigCache.has(assistantId)) return _assistantConfigCache.get(assistantId);

  const creds = getCredentials();
  if (!creds) throw new MgaLlmError('No credentials configured', { status: 401 });

  const url = `${getPlatformBase(creds.baseUrl)}/assistants/${assistantId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${creds.apiKey}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    throw new MgaLlmError(
      `getAssistantConfig ${assistantId} failed (${res.status}): ${errText.slice(0, 300)}`,
      { status: res.status },
    );
  }
  const body = await res.json();
  // MGA returns `model` as an OBJECT, not a string:
  //   { id: 'claude-sonnet-4.5', name: '...', max_input_tokens: ..., ... }
  // For /chat/completions we need the model id string. Be defensive — accept
  // either shape so a platform-side change doesn't silently break us.
  const modelField = body.model;
  const modelId = typeof modelField === 'string'
    ? modelField
    : (modelField?.id || modelField?.model || null);
  const config = {
    instructions: body.instructions || '',
    model: modelId,
  };
  _assistantConfigCache.set(assistantId, config);
  return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// /chat/completions path — caller manages full message history; system prompt
// is sent every call with cache_control so the underlying provider (Anthropic
// via MGA's LiteLLM proxy) serves the prefix from cache after turn 1.
//
// Returns { content, usage, latencyMs, costUsd, model }. NO conversationId —
// completions has no server-side conversation concept; that's the whole point.
//
// `messages` must already include the system message (with cache_control on
// its text block) and the full prior history. Caller is responsible for
// appending the assistant response to its own state after each call.
// See /tmp/cache-probes/MGA_ANTHROPIC_CACHING.md for the canonical body shape
// and verification details.
// ─────────────────────────────────────────────────────────────────────────────

export async function callMgaCompletions(opts = {}) {
  const override = globalThis.__HARNESS_MGA_CALL_OVERRIDE;
  if (typeof override === 'function') {
    // Test seam reuse — the integration mock intercepts both endpoints.
    return override({ ...opts, _endpoint: 'completions' });
  }
  return _callMgaCompletionsImpl(opts);
}

async function _callMgaCompletionsImpl({
  messages,
  model,
  assistantLabel = 'MGA',
  onTextDelta = null,
  signal = null,
  runContext = null,
  phase = null,
  scope = null,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new MgaLlmError('callMgaCompletions: messages array required and non-empty');
  }
  if (!model) {
    throw new MgaLlmError('callMgaCompletions: model required (resolve via pickModel)');
  }
  const creds = getCredentials();
  if (!creds) throw new MgaLlmError('No credentials configured', { status: 401 });

  const url = `${getPlatformBase(creds.baseUrl)}/chat/completions`;
  // stream_options.include_usage REQUIRED — otherwise the SSE stream ends after
  // the content chunks and we never see prompt_tokens / cache_read_input_tokens
  // / cache_creation_input_tokens. Without these we can't measure caching
  // effectiveness or compute cost.
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Conditionally set temperature=0 for code-generation determinism.
  // Opus 4.7 REJECTS this param (400 "deprecated for this model") because
  // its adaptive-thinking loop owns sampling internally; other models
  // (Opus 4.6, Sonnet 4.6/4.5, Haiku 4.5, GPT-5-mini) accept it. See
  // modelSupportsTemperature above for the deny-list.
  if (modelSupportsTemperature(model)) {
    body.temperature = 0;
  }

  await _appendDebugLog({
    kind: 'request',
    ts: new Date().toISOString(),
    endpoint: 'completions',
    assistant: assistantLabel,
    model,
    bodyLen: JSON.stringify(body).length,
    messageCount: messages.length,
  });

  recordLlmCall({
    runContext, phase, scope,
    kind: 'request',
    assistant: assistantLabel,
    conversationId: null,
    body,
  });

  const requestStartTs = Date.now();

  // Inactivity watchdog: a hung MGA stream (headers or body producing no
  // bytes) previously hung the calling agent turn FOREVER — observed live:
  // a subagent stuck 17+ minutes with zero output while the build moved on
  // without its scope. Abort after MGA_STREAM_IDLE_TIMEOUT_MS without any
  // stream activity and retry once with a fresh request; a second hang
  // throws so the agent loop fails the turn loudly instead of silently.
  const idleTimeoutMs = Number(process.env.MGA_STREAM_IDLE_TIMEOUT_MS || 180_000);
  // Unresettable cap on time-to-first-CONTENT. Observed live: a degraded MGA
  // stream held connections open with empty-delta heartbeat events — legal
  // data events that reset the idle timer forever while never producing a
  // token. Heartbeats must not defeat the watchdog.
  const firstContentTimeoutMs = Number(process.env.MGA_STREAM_FIRST_CONTENT_TIMEOUT_MS || 180_000);

  const attemptOnce = async () => {
    const ac = new AbortController();
    let idleFired = false;
    let firstContentFired = false;
    let gotContent = false;
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleFired = true; ac.abort(); }, idleTimeoutMs);
    };
    const firstContentTimer = setTimeout(() => {
      if (!gotContent) { firstContentFired = true; ac.abort(); }
    }, firstContentTimeoutMs);
    const wrappedDelta = (delta) => {
      if (!gotContent) { gotContent = true; clearTimeout(firstContentTimer); }
      if (onTextDelta) onTextDelta(delta);
    };
    const onCallerAbort = () => ac.abort();
    if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });
    armIdle();
    const timeoutError = (where) => new MgaLlmError(
      firstContentFired
        ? `${assistantLabel} stream produced no content within ${firstContentTimeoutMs}ms (${where}; heartbeats do not count)`
        : `${assistantLabel} stream inactivity timeout after ${idleTimeoutMs}ms (${where})`,
      { status: null, idleTimeout: true },
    );
    try {
      let res;
      try {
        res = await _fetchWithRetry(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creds.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        }, { logLabel: `mga-completions:${assistantLabel}` });
      } catch (err) {
        if (idleFired || firstContentFired) throw timeoutError('no response headers');
        throw new MgaLlmError(`Network error: ${err.message || String(err)}`, { status: null });
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        throw new MgaLlmError(
          `${assistantLabel} completions API error (${res.status}): ${errText.slice(0, 500)}`,
          { status: res.status },
        );
      }

      try {
        return await _readSseStream(res, wrappedDelta, armIdle);
      } catch (err) {
        if (idleFired || firstContentFired) throw timeoutError('mid-stream');
        throw err;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(firstContentTimer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  };

  // Transient transport failures worth ONE retry: the watchdog's idle
  // timeout, and mid-stream connection drops (undici surfaces these as
  // "terminated" / ECONNRESET / socket errors). Observed live: a
  // "terminated" on the frontend agent's third turn killed the whole scope
  // silently and cost a 12-minute blind rebuild through the fix pipeline.
  const isTransientStreamError = (err) => {
    if (err?.idleTimeout) return true;
    const msg = String(err?.message || '');
    const code = err?.cause?.code || err?.code || '';
    return /terminated|ECONNRESET|UND_ERR_SOCKET|other side closed/i.test(msg + ' ' + code);
  };
  let streamResult;
  try {
    streamResult = await attemptOnce();
  } catch (err) {
    const callerAborted = signal?.aborted;
    if (isTransientStreamError(err) && !callerAborted) {
      tlog('[llm] %s transient stream failure (%s) — retrying once (model=%s)',
        assistantLabel, err?.idleTimeout ? 'idle timeout' : String(err?.message || err).slice(0, 80), model);
      streamResult = await attemptOnce();
    } else {
      throw err;
    }
  }
  const { content, usage } = streamResult;

  await _appendDebugLog({
    kind: 'response',
    ts: new Date().toISOString(),
    endpoint: 'completions',
    assistant: assistantLabel,
    model,
    usage: usage || null,
    contentLen: content.length,
    content,
  });

  // Cost computation — Anthropic-shape usage (top-level cache_creation_input_tokens
  // and cache_read_input_tokens). prompt_tokens is the TOTAL including cached
  // portion; subtract cached to bill the uncached part at full rate and cached
  // at the cached rate. See MGA_ANTHROPIC_CACHING.md §4 / §8.
  const latencyMs = Date.now() - requestStartTs;
  let costUsd = null;
  if (usage) {
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const cachedRead = usage.cache_read_input_tokens || 0;
    const cachedWrite = usage.cache_creation_input_tokens || 0;
    // Bill: uncached prompt + write at full+25% + read at 0.1x. pricing.js
    // accepts (promptTokens, completionTokens, cachedTokens); the 1.25x write
    // surcharge isn't yet modeled there — we approximate by billing
    // cache_creation as full-rate prompt (slight underestimate; acceptable
    // for now since it's only on cold calls and the dominant cost is reads).
    const uncachedPrompt = Math.max(0, promptTokens - cachedRead - cachedWrite);
    costUsd = computeCost({
      promptTokens: uncachedPrompt + cachedWrite,
      completionTokens,
      cachedTokens: cachedRead,
      model,
    });
  }

  recordLlmCall({
    runContext, phase, scope,
    kind: 'response',
    assistant: assistantLabel,
    conversationId: null,
    content,
    usage,
    latencyMs,
    costUsd,
    model,
  });

  return { content, usage, latencyMs, costUsd, model };
}
