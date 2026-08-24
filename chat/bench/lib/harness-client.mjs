/**
 * harness-client — drives the LIVE dev server exactly like a user's browser:
 * same HTTP endpoints, same event stream (read from the transcript jsonl on
 * disk, which the server appends in real time).
 *
 * Deliberately targets the running server + real workspace rather than a
 * sandboxed one: the bench exists to automate the hand-test playbook, so it
 * must exercise the same paths a human does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..', '..'); // workspace root
export const BASE_URL = process.env.BENCH_BASE_URL || 'http://localhost:5050';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(pathname, body = {}) {
  // One retry on transport-level failures (server mid-warmup ECONNRESET
  // killed a whole pass on its first request).
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST ${pathname} → HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return await res.json().catch(() => ({}));
    } catch (err) {
      const transient = /fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(String(err?.cause?.code || err?.message || err));
      if (attempt >= 1 || !transient) throw err;
      await sleep(5000);
    }
  }
}

export async function startSession() {
  const { sessionId } = await post('/api/session/start');
  return sessionId;
}

export const sendMessage = (sessionId, message) => post(`/api/session/${sessionId}/message`, { message });
export const confirmPlan = (sessionId) => post(`/api/session/${sessionId}/confirm`);
export const cleanProject = (sessionId) => post(`/api/session/${sessionId}/clean`);

export function readEvents(sessionId) {
  const p = path.join(ROOT, '.chat', 'transcripts', `${sessionId}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Poll the transcript until `predicate(event)` matches an event with index
 * >= sinceIndex. Returns { event, index }. Throws on timeout.
 */
export async function waitFor(sessionId, predicate, { timeoutMs = 300_000, sinceIndex = 0, label = 'event' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = readEvents(sessionId);
    for (let i = sinceIndex; i < events.length; i++) {
      if (predicate(events[i])) return { event: events[i], index: i, total: events.length };
    }
    await sleep(2000);
  }
  throw new Error(`timeout (${Math.round(timeoutMs / 1000)}s) waiting for ${label}`);
}

export const isClarify = (e) => e?.type === 'cline' && Array.isArray(e?.payload?.questions) && e.payload.questions.length > 0;
export const isPlanPreview = (e) => e?.type === 'plan_preview';
export const isAppReady = (e) => e?.type === 'app_ready_prompt';
export const isIdle = (e) => e?.type === 'status' && e?.payload?.status === 'idle';

// Terminal build failure the harness surfaces to chat when compose can't
// build/start. Without matching it, a dead build makes the bench sit out its
// full app_ready timeout (observed: 22 wasted minutes after the harness had
// already said "Couldn't start containers").
export const isBuildFailed = (e) => e?.type === 'cline' && typeof e?.payload?.text === 'string'
  && /Couldn't start containers|Build failed\. Try \*\*Run locally\*\*/.test(e.payload.text);

/** app_ready OR terminal build failure — callers throw on the latter. */
export const isAppReadyOrFailed = (e) => isAppReady(e) || isBuildFailed(e);

/**
 * Full fresh-build drive: prompt → clarify rounds (scenario answers) →
 * plan confirm → app ready. Returns collected checkpoints for scoring.
 */
export async function driveFreshBuild(sessionId, scenario, log = console.error) {
  const t0 = Date.now();
  await sendMessage(sessionId, scenario.prompt);
  log(`[bench] prompt sent`);

  let cursor = 0;
  let clarifyRounds = 0;
  // Clarify (0..2 rounds) then plan preview.
  for (let round = 0; round < 3; round++) {
    const hit = await waitFor(sessionId, (e) => isClarify(e) || isPlanPreview(e),
      { sinceIndex: cursor, timeoutMs: 300_000, label: 'clarify or plan' });
    cursor = hit.index + 1;
    if (isPlanPreview(hit.event)) {
      log(`[bench] plan preview after ${round} clarify round(s)`);
      break;
    }
    const answer = scenario.answerClarify(hit.event.payload.questions);
    clarifyRounds++;
    log(`[bench] clarify round ${round + 1} → answering`);
    await sendMessage(sessionId, answer);
  }

  await confirmPlan(sessionId);
  log(`[bench] plan confirmed — building (this takes minutes)`);

  const ready = await waitFor(sessionId, isAppReadyOrFailed,
    { sinceIndex: cursor, timeoutMs: 30 * 60_000, label: 'app_ready' });
  if (isBuildFailed(ready.event)) {
    throw new Error(`build failed before app_ready: ${(ready.event.payload.text || '').slice(0, 200)}`);
  }

  const events = readEvents(sessionId);
  const buildMs = Date.now() - t0;

  // Harness honesty signals for containment scoring.
  const probeDone = [...events].reverse().find((e) => e.type === 'endpoint_probe_done');
  const uiSanity = [...events].reverse().find((e) => e.type === 'ui_sanity_result');
  const reportEvent = [...events].reverse().find((e) =>
    e.type === 'cline' && typeof e.payload?.text === 'string' && e.payload.text.includes('--- BUILD REPORT ---'));
  const reportStatus = reportEvent ? (/\*\*?Status:\*\*? *(\w+)/.exec(reportEvent.payload.text)?.[1] || 'unknown') : 'missing';

  return {
    buildMs,
    clarifyRounds,
    reportStatus,
    probe: probeDone?.payload || null,
    visual: uiSanity?.payload || null,
    appReadyText: ready.event?.payload?.message || '',
  };
}
/**
 * Drive one ITERATE on an existing session: message → next app_ready.
 * Returns the same honesty signals as driveFreshBuild.
 */
export async function driveIterate(sessionId, message, log = console.error) {
  const cursor = readEvents(sessionId).length;
  const t0 = Date.now();
  await sendMessage(sessionId, message);
  const readyIt = await waitFor(sessionId, isAppReadyOrFailed, { sinceIndex: cursor, timeoutMs: 25 * 60_000, label: 'iterate app_ready' });
  if (isBuildFailed(readyIt.event)) {
    throw new Error(`iterate build failed before app_ready: ${(readyIt.event.payload.text || '').slice(0, 200)}`);
  }
  const events = readEvents(sessionId).slice(cursor);
  const probeDone = [...events].reverse().find((e) => e.type === 'endpoint_probe_done');
  const reportEvent = [...events].reverse().find((e) =>
    e.type === 'cline' && typeof e.payload?.text === 'string' && e.payload.text.includes('--- BUILD REPORT ---'));
  const reportStatus = reportEvent ? (/\*\*?Status:\*\*? *(\w+)/.exec(reportEvent.payload.text)?.[1] || 'unknown') : 'missing';
  log(`[bench] iterate done in ${Math.round((Date.now() - t0) / 1000)}s — report=${reportStatus}`);
  return { iterateMs: Date.now() - t0, reportStatus, probe: probeDone?.payload || null };
}
