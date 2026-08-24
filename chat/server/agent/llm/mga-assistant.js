/**
 * MGA assistant lifecycle — create / attach tools / delete / list-orphans.
 *
 * Used by /confirm in session/routes.js to pre-stage a per-app MGA assistant
 * when the router emits `task.mgaAssistant`. Mirrors the proven pattern
 * in chat/scripts/create-orchestrator-assistants.js:106-131 (FormData +
 * Blob + 67-byte placeholder PNG) — extracted into a shared module so
 * both the bootstrap script (once) and /confirm (per session) use the
 * same code path.
 *
 * Design notes:
 *   - Names are tagged `<name> [harness:<sessionId>]` so listHarnessAssistants
 *     can find orphans for cleanup without colliding with hand-managed ones.
 *   - attachTools is non-fatal — if /assistants/{id}/tools fails (permission,
 *     unknown tool, etc.) we log and continue. Assistant works without tools.
 *   - DELETE 404 is treated as success (assistant already gone).
 */

import { ATTACHABLE_TOOLS } from './mga-platform-config.js';
import { logAndSwallow } from '../../util/log-helpers.js';

/**
 * 68-byte 1x1 transparent PNG. Same constant used by the orchestrator
 * bootstrap script. MGA's POST /assistants requires a non-empty
 * `assistant_logo` multipart part; we don't surface logo customization
 * to user apps yet (out of scope per plan).
 */
export const PLACEHOLDER_LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

// MGA's POST /assistants validator restricts `name` to:
//   A-Z a-z 0-9 _ space - / &
// No square brackets, no colons. We tag harness-created assistants with a
// suffix using only allowed chars so the orphan-cleanup script can find them.
const HARNESS_NAME_PREFIX = ' - harness-';

function joinUrl(baseUrl, suffix) {
  return baseUrl.replace(/\/$/, '') + suffix;
}

/**
 * Create a new MGA assistant from a router spec.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {string} spec.instructions  — full system prompt
 * @param {string} spec.model         — must be in ALLOWED_MODEL_IDS
 * @param {string} [spec.sessionId]   — appended to name as ` - harness-<id>` for orphan cleanup
 * @param {string} [spec.access='private']
 * @param {string} [spec.reasoningEffort='low']
 * @param {object} secrets — { baseUrl, apiKey }
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl=fetch] — injectable for tests
 * @returns {Promise<string>} assistant id (UUID)
 */
export async function createAssistant(spec, secrets, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = joinUrl(secrets.baseUrl, '/assistants');

  const taggedName = spec.sessionId
    ? `${spec.name}${HARNESS_NAME_PREFIX}${spec.sessionId}`
    : spec.name;

  const fd = new FormData();
  fd.append('name', taggedName);
  fd.append('description', spec.description || '');
  // Default defensively: a spec without a model (e.g. the runtime-synthesized
  // fallback spec) previously reached MGA as the literal string "undefined"
  // → HTTP 404 "Model undefined not found". claude-opus-4.7 is the
  // contract-agent default for app assistants.
  fd.append('model', spec.model || 'claude-opus-4.7');
  fd.append('access', spec.access || 'private');
  fd.append('reasoning_effort', spec.reasoningEffort || 'low');
  fd.append('instructions', spec.instructions);
  fd.append('assistant_logo', new Blob([PLACEHOLDER_LOGO_PNG], { type: 'image/png' }), 'logo.png');

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${secrets.apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST /assistants failed: HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  if (!data.id) {
    throw new Error(`POST /assistants returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.id;
}

/**
 * Attach tools to an existing assistant. Filters out chat-agent default
 * tools (document_question_answering, document_summarizer, uploaded_docs)
 * since those are surfaced for free at runtime and don't need attachment.
 *
 * Errors are non-fatal — caller logs and continues. The assistant works
 * without tools attached; the user just won't get tool-augmented replies.
 *
 * @param {string} assistantId
 * @param {string[]} toolKeys
 * @param {object} secrets
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl=fetch]
 * @returns {Promise<{attached: string[], failed: string[]}>}
 */
export async function attachTools(assistantId, toolKeys, secrets, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const attachable = (toolKeys || []).filter(k => ATTACHABLE_TOOLS.includes(k));
  if (attachable.length === 0) {
    return { attached: [], failed: [] };
  }
  const url = joinUrl(secrets.baseUrl, `/assistants/${assistantId}/tools`);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secrets.apiKey}`,
      },
      body: JSON.stringify({ tool_keys: attachable }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[mga-assistant] attachTools failed: HTTP ${res.status}: ${txt.slice(0, 200)}`);
      return { attached: [], failed: attachable };
    }
    return { attached: attachable, failed: [] };
  } catch (err) {
    return logAndSwallow(err, '[mga-assistant] attachTools threw', { attached: [], failed: attachable });
  }
}

/**
 * Delete an assistant. 404 is treated as success (already gone).
 *
 * @param {string} assistantId
 * @param {object} secrets
 * @param {object} [opts]
 * @returns {Promise<{deleted: boolean, status: number}>}
 */
export async function deleteAssistant(assistantId, secrets, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = joinUrl(secrets.baseUrl, `/assistants/${assistantId}`);
  const res = await fetchImpl(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${secrets.apiKey}` },
  });
  if (res.ok || res.status === 404) {
    return { deleted: true, status: res.status };
  }
  const txt = await res.text().catch(() => '');
  throw new Error(`DELETE /assistants/${assistantId} failed: HTTP ${res.status}: ${txt.slice(0, 200)}`);
}

/**
 * List harness-created orphan assistants — those whose name ends with the
 * suffix ` - harness-<sessionId>`. Used by the manual cleanup script when
 * sessions get pruned without their cleanup hook firing.
 *
 * @param {object} secrets
 * @param {object} [opts]
 * @returns {Promise<Array<{id, name, sessionId}>>}
 */
export async function listHarnessAssistants(secrets, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = joinUrl(secrets.baseUrl, '/assistants');
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${secrets.apiKey}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GET /assistants failed: HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.items || data.data || []);
  const orphans = [];
  // Match " - harness-<id>" at end of name. Session id is a uuid; charset is
  // [a-f0-9-] but we're permissive (the name allowed-charset narrows it).
  const tagRe = / - harness-([a-zA-Z0-9-]+)$/;
  for (const a of list) {
    if (typeof a?.name !== 'string') continue;
    const match = a.name.match(tagRe);
    if (!match) continue;
    orphans.push({ id: a.id, name: a.name, sessionId: match[1] });
  }
  return orphans;
}
