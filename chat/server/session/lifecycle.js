import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { appendEvent, readAll } from './transcript.js';
import { sessionEvents } from './events.js';

/**
 * Restore the in-memory token accumulator from the transcript's last
 * token_metrics event. `session.coderTokenTotals` is in-memory only, so a
 * resumed session — or one re-created after a server restart — would otherwise
 * start at 0 and the next continuation would RESET the UI token chip (which
 * shows session-cumulative cost). This mirrors the frontend's own
 * restore-from-history on reload. No-op if already populated or no prior totals.
 */
export function restoreCoderTokenTotals(session) {
  if (!session?.id || session.coderTokenTotals) return;
  let events;
  try { events = readAll(session.id); } catch { return; }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const t = ev?.type === 'token_metrics' ? ev.payload?.totals : null;
    if (t && (t.promptTokens || t.completionTokens || t.cachedTokens || t.apiCalls)) {
      session.coderTokenTotals = {
        promptTokens: t.promptTokens || 0,
        completionTokens: t.completionTokens || 0,
        cachedTokens: t.cachedTokens || 0,
        apiCalls: t.apiCalls || 0,
        truncations: 0,
      };
      return;
    }
  }
}

/**
 * Accumulate a runCustomAgent result's per-run token totals into the
 * session-level running totals. Lazy-initializes session.coderTokenTotals.
 * The accumulator is what subsequent runCustomAgent calls pass in as
 * priorTokenTotals, so agent.js can emit session-cumulative token_metrics
 * (the UI's token chip shows session-wide cost, not per-prompt cost).
 *
 * Also stashes the latest VirtualHistoryManager on the session so the
 * manual summarize endpoint can feed it to the Summarizer assistant
 * without re-reading transcript events. Per-run overwrite is fine for
 * Phase 2b; Phase 3 will replace this with history spanning the whole
 * MGA conversation.
 */
export function accumulateAgentTotals(session, result) {
  const t = result?.runTokenTotals;
  if (t) {
    if (!session.coderTokenTotals) {
      // Carry forward prior session cost (resume / restart) before this run's
      // delta, so a continuation grows the chip instead of resetting it.
      restoreCoderTokenTotals(session);
    }
    if (!session.coderTokenTotals) {
      session.coderTokenTotals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, apiCalls: 0, truncations: 0 };
    }
    session.coderTokenTotals.promptTokens += t.promptTokens || 0;
    session.coderTokenTotals.completionTokens += t.completionTokens || 0;
    session.coderTokenTotals.cachedTokens += t.cachedTokens || 0;
    session.coderTokenTotals.apiCalls += t.apiCalls || 0;
    session.coderTokenTotals.truncations = (session.coderTokenTotals.truncations || 0) + (t.truncations || 0);

    // Emit an AUTHORITATIVE session-wide token_metrics from the accumulator.
    // Per-agent emits in agent.js use a stale priorTotals snapshot, so with
    // parallel scopes the UI chip would otherwise show only one agent's
    // cumulative (last-writer-wins). This is the single chokepoint every agent
    // run passes through, so emitting the true running total here keeps the
    // chip honest across the whole fan-out (replay-safe: the UI overwrites).
    const c = session.coderTokenTotals;
    const authoritative = {
      delta: {
        promptTokens: t.promptTokens || 0,
        completionTokens: t.completionTokens || 0,
        cachedTokens: t.cachedTokens || 0,
        apiCalls: t.apiCalls || 0,
      },
      totals: {
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
        cachedTokens: c.cachedTokens,
        apiCalls: c.apiCalls,
      },
      scope: null, // session-wide, not attributed to a single scope
    };
    const evt = appendEvent(session.id, 'token_metrics', authoritative);
    sessionEvents.emit('event', session.id, evt);
  }
  if (result?.virtualHistory) {
    session.lastCoderHistory = result.virtualHistory;
  }
}

/**
 * Validate and sanitise the `uploads` array that comes in on POST /message.
 * We re-stringify the fields rather than trusting the client blob to ensure
 * the router/prompt-builder never sees an unexpected shape.
 */
export function sanitiseUploadsPayload(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const u of raw) {
    if (!u || typeof u !== 'object') continue;
    const filename = typeof u.filename === 'string' ? u.filename.slice(0, 200) : null;
    const relativePath = typeof u.relativePath === 'string' ? u.relativePath.slice(0, 400) : null;
    if (!filename || !relativePath) continue;
    out.push({
      filename,
      relativePath,
      size: typeof u.size === 'number' ? u.size : 0,
      mime: typeof u.mime === 'string' ? u.mime.slice(0, 120) : 'application/octet-stream',
      parsed: (u.parsed && typeof u.parsed === 'object') ? {
        preview: typeof u.parsed.preview === 'string' ? u.parsed.preview : '',
        summary: typeof u.parsed.summary === 'string' ? u.parsed.summary : '',
        structure: (u.parsed.structure && typeof u.parsed.structure === 'object') ? u.parsed.structure : null,
        mime: typeof u.parsed.mime === 'string' ? u.parsed.mime : null,
      } : null,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Read `.template-manifest.yml` and extract every path declared as part of
 * the template (auto_update + merge_update + check_only sections). Used by
 * the Clean endpoint as a whitelist: anything under an AI-editable scope
 * folder that ISN'T in this list is AI-generated and gets wiped on reset.
 *
 * Crude YAML parsing — we only need the `- path: "..."` lines from specific
 * top-level sections. If the manifest is missing or malformed, returns an
 * empty set (Clean will fall back to removing everything in scope folders).
 *
 * Paths ending with `/` represent directory ownership — we strip the slash
 * and also record the path WITHOUT the slash so both exact-match and
 * ancestor-check work.
 */
export function loadTemplateWhitelist(workspaceDir) {
  const manifestPath = path.join(workspaceDir, '.template-manifest.yml');
  if (!existsSync(manifestPath)) return new Set();

  let text;
  try { text = readFileSync(manifestPath, 'utf-8'); }
  catch { return new Set(); }

  const paths = new Set();
  // Only `auto_update` (template-owned, overwritten on sync) and `merge_update`
  // (config merged with template) represent files that should survive Clean.
  // `check_only` entries like `backend/Dockerfile` / `frontend/Dockerfile` are
  // user-created copies of the template originals — those SHOULD be removed
  // on Clean so the model starts fresh.
  const SECTIONS_TO_PARSE = new Set(['auto_update', 'merge_update']);
  let currentSection = null;
  const sectionHeaderRe = /^([a-z_]+):\s*$/;
  const pathLineRe = /^\s*-\s*path:\s*"([^"]+)"\s*$/;

  for (const line of text.split('\n')) {
    const secMatch = line.match(sectionHeaderRe);
    if (secMatch) {
      currentSection = SECTIONS_TO_PARSE.has(secMatch[1]) ? secMatch[1] : null;
      continue;
    }
    if (!currentSection) continue;
    const pathMatch = line.match(pathLineRe);
    if (pathMatch) {
      let p = pathMatch[1].replace(/\/$/, ''); // strip trailing slash
      if (p) paths.add(p);
    }
  }

  return paths;
}

/**
 * Kill all active Cline child processes for a session and clear the set.
 * Used by cancel, pause, reset, clean, and session-switch (resume).
 */
export function killAllProcs(session) {
  if (!session?.activeProcs) return;
  for (const p of session.activeProcs) {
    try { p.kill(); } catch { /* already dead */ }
  }
  session.activeProcs.clear();
}

/**
 * Cancel all in-flight scoped phases for a session.
 * Sets a cancellation flag that the orchestrator's spawn handlers check
 * during their dispatch loop, and emits scope_status:cancelled for any
 * scopes that were still running or not yet started.
 */
export function cancelScopedPhases(session) {
  if (!session) return;
  session.cancelled = true;
}

/**
 * Persist a scope_status event to the transcript and broadcast it.
 * Without persisting, the UI can't rehydrate scope state on resume — the
 * quick-actions bar (which gates on "any scope completed") would stay hidden
 * after the page reloads because history_batch contains none of these.
 */
export function emitScopeStatus(sessionId, payload) {
  const event = appendEvent(sessionId, 'scope_status', payload);
  sessionEvents.emit('event', sessionId, event);
}
