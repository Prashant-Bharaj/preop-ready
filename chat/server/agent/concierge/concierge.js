/**
 * Concierge runtime entry — calls the concierge MGA assistant to handle a
 * user message and returns the parsed decision object.
 *
 * The concierge prompt (chat/prompts/concierge.md, ported unchanged from
 * the validated experiment in /Users/alen/www/bayer/deployment/concierge-experiment/)
 * emits a single JSON action per call:
 *
 *   { action: "respond" | "clarify" | "dispatch_iterate" | "add_to_todo"
 *           | "interrupt" | "multi",
 *     ...action-specific fields }
 *
 * This module:
 *   1. Builds the session_state via buildSessionState
 *   2. Serializes { session_state, user_message } as the user message
 *   3. Calls MGA via /chat/completions with cache_control on the system
 *      prompt (instructions fetched from getAssistantConfig). The system
 *      prefix is identical across turns, so the prompt cache hits from
 *      turn 2 onward within Anthropic's 5-min TTL.
 *   4. Parses the response JSON (lenient — strips markdown fences if present)
 *   5. Returns the parsed action
 *
 * It does NOT execute the action — that's the caller's responsibility (see
 * routes.js wiring + the per-action runtime handlers). Concierge runtime is
 * thin: build input, call MGA, parse output.
 *
 * Per-turn fresh context: no conversation_id reuse — the runtime injects
 * current session_state into every input. State that needs to persist
 * across turns (todoList, recent decisions) lives on `session` and is
 * picked up by buildSessionState on the next call.
 */

import { tlog } from '../../util/timestamped-log.js';
import { logAndSwallow } from '../../util/log-helpers.js';
import { buildImageBlocks } from '../shared/image-blocks.js';
import { buildSessionState } from './session-state.js';
import { getCredentials } from '../../core/auth.js';
import { callMgaCompletions } from '../llm/llm.js';
import { pickModel } from '../llm/model-picker.js';
import { loadPrompt } from '../prompts/disk-prompt.js';
import { WORKSPACE_DIR } from '../../core/paths.js';

const VALID_ACTIONS = new Set([
  'respond',
  'clarify',
  'dispatch_iterate',
  'add_to_todo',
  'interrupt',
  'multi',
  // `diagnose` routes a post-build "it's broken" report to the read-only
  // investigator (reads container logs + code, emits a structured root-cause
  // report → auto-fix or surface) instead of a blind dispatch_iterate.
  'diagnose',
]);

/**
 * Build the user-message content for one concierge turn. Returns either a
 * string (text-only, the common case) or a multimodal content array (when
 * any upload's mime starts with `image/`).
 *
 * Multimodal layout (OpenAI image_url shape — the only one MGA accepts;
 * Anthropic-style { type:'image', source } 422s — see shared/image-blocks.js):
 *   [
 *     { type: 'text', text: '<JSON {session_state, user_message, attached_uploads?}>' },
 *     { type: 'image_url', image_url: { url: 'data:<mime>;base64,<b64>', detail: 'high' } },
 *     ...one per image upload
 *   ]
 *
 * Non-image uploads (PDFs, text files, etc.) are surfaced via the
 * `attached_uploads` array inside the JSON text block — their parsed
 * `preview` field carries the extracted text content. callMgaCompletions
 * ships the multimodal array verbatim through /chat/completions; the
 * vision-capable model reads the image blocks alongside the text.
 *
 * Falls back to text-only (the prior string-content shape) when there are
 * no image uploads, preserving back-compat for every existing call.
 *
 * @param {object} sessionState - the {build_phase, completed_scopes, ...} payload
 * @param {string} userMessage - the user's raw text
 * @param {Array} uploads - sanitised uploads array (see sanitiseUploadsPayload)
 * @param {string} workspaceDir - where to resolve relativePath for image bytes
 * @returns {string | Array<object>}
 */
function buildConciergeUserContent(sessionState, userMessage, uploads, workspaceDir) {
  const safeUploads = Array.isArray(uploads) ? uploads : [];
  const attachedMeta = safeUploads.map(u => ({
    filename: u.filename,
    relative_path: u.relativePath,
    mime: u.mime,
    size: u.size,
    // Preview is the parser's text extraction (PDF text, image dims line,
    // etc.). For images, callers should rely on the image block instead;
    // for text/PDF, the preview IS the content the model should reason on.
    preview: u.parsed?.preview || null,
  }));

  const payload = {
    session_state: sessionState,
    user_message: userMessage,
  };
  if (attachedMeta.length > 0) payload.attached_uploads = attachedMeta;
  const textBlock = { type: 'text', text: JSON.stringify(payload, null, 2) };

  const imageBlocks = buildImageBlocks(safeUploads, workspaceDir, 'concierge');

  if (imageBlocks.length === 0) {
    // No images — preserve the prior string-content shape so any non-vision
    // back-end / proxy still parses the request the same way.
    return textBlock.text;
  }
  return [textBlock, ...imageBlocks];
}

/**
 * Invoke the concierge for one user-message turn.
 *
 * @param {object} session - the session record (used for state derivation + id)
 * @param {string} userMessage - the user's raw message text
 * @param {Array} [uploads] - sanitised uploads (see sanitiseUploadsPayload).
 *   When any upload has an image mime, the user message becomes multimodal
 *   (text JSON block + base64 image blocks). Non-image uploads surface
 *   through the `attached_uploads` JSON field with their text preview.
 * @param {string} [workspaceDir] - where to read uploaded image bytes from
 *   (defaults to WORKSPACE_DIR). Passed explicitly for unit-testability.
 * @returns {Promise<{
 *   ok: true,
 *   decision: { action: string, ...fields },
 *   raw: { content: string },
 *   sessionState: object,
 *   latencyMs: number,
 * } | {
 *   ok: false,
 *   error: string,
 *   raw?: { content?: string },
 * }>}
 */
export async function runConciergeTurn(session, userMessage, uploads = [], workspaceDir = WORKSPACE_DIR) {
  const sessionState = buildSessionState(session);
  const userMessageContent = buildConciergeUserContent(sessionState, userMessage, uploads, workspaceDir);

  const creds = getCredentials();
  if (!creds) {
    return { ok: false, error: 'concierge: no MGA credentials configured (set OPENAI_COMPAT_BASE_URL/API_KEY or .chat/secrets.json)' };
  }
  const assistantId = creds.conciergeAssistantId;
  if (!assistantId) {
    return { ok: false, error: 'concierge: assistant_id not configured (set CONCIERGE_ASSISTANT_ID env var or conciergeAssistantId in assistants.json)' };
  }

  const imageCount = Array.isArray(uploads)
    ? uploads.filter(u => typeof u?.mime === 'string' && u.mime.startsWith('image/') && u.mime !== 'image/svg+xml').length
    : 0;
  tlog('[concierge] turn for session=%s build_phase=%s user_msg_len=%d uploads=%d images=%d',
    session.id, sessionState.build_phase, userMessage.length,
    Array.isArray(uploads) ? uploads.length : 0, imageCount);

  const t0 = Date.now();
  let content;
  try {
    // Instructions come from disk (chat/prompts/concierge.md). Model is resolved
    // from config via pickModel — no getAssistantConfig / assistant lookup.
    // CONCIERGE has no pinned phase rule, so it resolves to DEFAULT_MODEL
    // (override per-scope with MGA_MODEL_OVERRIDE_CONCIERGE).
    let instructions;
    try {
      instructions = loadPrompt('concierge.md');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    // cache_control on the system block — the concierge instructions are
    // identical across every turn within a session, so the prefix hits
    // Anthropic's prompt cache from turn 2 onward (5-min TTL).
    const messages = [
      { role: 'system', content: [{
          type: 'text',
          text: instructions,
          cache_control: { type: 'ephemeral' },
      }]},
      { role: 'user', content: userMessageContent },
    ];
    const picked = pickModel({ phase: 'CONCIERGE', scope: 'concierge' });
    tlog('[concierge] (/chat/completions): assistant=%s model=%s%s',
      assistantId, picked.model, picked.source);
    const result = await callMgaCompletions({
      messages,
      model: picked.model,
      assistantLabel: 'Concierge',
      phase: 'CONCIERGE',
      scope: 'concierge',
    });
    content = result.content || '';
  } catch (err) {
    logAndSwallow(err, '[concierge] MGA call threw');
    return { ok: false, error: `mga call failed: ${err.message}` };
  }
  const latencyMs = Date.now() - t0;

  const decision = tryParseJSON(content);

  if (!decision || typeof decision !== 'object') {
    return {
      ok: false,
      error: 'concierge response did not parse as JSON',
      raw: { content },
    };
  }
  if (!VALID_ACTIONS.has(decision.action)) {
    return {
      ok: false,
      error: `concierge emitted invalid action "${decision.action}" (expected one of ${[...VALID_ACTIONS].join(', ')})`,
      raw: { content },
    };
  }

  tlog('[concierge] decision action=%s latency=%dms', decision.action, latencyMs);

  return {
    ok: true,
    decision,
    raw: { content },
    sessionState,
    latencyMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — lenient JSON parse (mirrors other parsers in repo)
// ─────────────────────────────────────────────────────────────────────────────

function tryParseJSON(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const trimmed = content.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      else if (trimmed[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { /* fall through */ }
          break;
        }
      }
    }
  }
  return null;
}
