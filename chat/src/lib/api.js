const API_BASE = '/api';

export async function getAuthStatus() {
  const res = await fetch(`${API_BASE}/auth/status`);
  if (!res.ok) throw new Error(`Failed to load auth status (${res.status})`);
  return res.json();
}

export async function getAuthSettings() {
  const res = await fetch(`${API_BASE}/auth/settings`);
  if (!res.ok) throw new Error(`Failed to load auth settings (${res.status})`);
  return res.json();
}

export async function saveAuthConfig({ baseUrl, apiKey }) {
  const res = await fetch(`${API_BASE}/auth/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey }),
  });
  return res.json();
}

/**
 * Update baseUrl without re-providing the API key. Used when the user edits
 * Base URL only (no new API key typed). Model is no longer user-tunable
 * since LLM-orch mode dispatches via harness assistants whose models are
 * configured on the MGA side.
 */
export async function saveConnectionConfig({ baseUrl }) {
  const res = await fetch(`${API_BASE}/auth/config-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl }),
  });
  return res.json();
}

export async function getModels() {
  const res = await fetch(`${API_BASE}/auth/models`);
  if (!res.ok) throw new Error(`Failed to load models (${res.status})`);
  return res.json();
}

/** Fetch models from MGA / Bayer Chat API (via server proxy, uses stored creds) */
export async function getMgaModels() {
  const res = await fetch(`${API_BASE}/auth/mga-models`);
  if (!res.ok) throw new Error(`Failed to load MGA models (${res.status})`);
  return res.json();
}

/**
 * Fetch models from MGA using a specific API key (before saving).
 * Used in Settings panel to populate the model dropdown live.
 */
export async function getModelsForKey(apiKey) {
  const res = await fetch(`${API_BASE}/auth/models-for-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  return res.json();
}

/** Run health checks for LLM, assistant and MGA connectivity */
export async function getHealthStatus() {
  const res = await fetch(`${API_BASE}/auth/health`);
  if (!res.ok) throw new Error(`Failed to load health status (${res.status})`);
  return res.json();
}

export async function savePreferences({ mode, projectType }) {
  const res = await fetch(`${API_BASE}/auth/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, projectType }),
  });
  return res.json();
}

export async function startSession() {
  const res = await fetch(`${API_BASE}/session/start`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to start session');
  }
  return res.json();
}

export async function sendMessage(sessionId, message, uploads = null, displayMessage = null) {
  const body = { message };
  if (displayMessage && displayMessage !== message) body.displayMessage = displayMessage;
  if (Array.isArray(uploads) && uploads.length > 0) body.uploads = uploads;
  const res = await fetch(`${API_BASE}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send message');
  }
  return res.json();
}

/**
 * Upload a single file to the backend. The file lands in <workspace>/context/
 * and the returned metadata is what gets passed back to sendMessage() so the
 * router + Cline know which files the user attached.
 */
export async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
  return data;
}

export async function resetSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/reset`, {
    method: 'POST',
  });
  return res.json();
}

/**
 * User answered "yes" to the auto-start prompt. Server keeps the containers
 * running and records an app_ready event for history. Returns { url } so the
 * client can window.open the forwarded port.
 */
export async function confirmOpenApp(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/open-app`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to open app');
  }
  return res.json();
}

/** Deterministic app start — compose build + up + full post-compose
 *  verification (migrations, endpoint probe, visual check). No LLM. */
export async function startApp(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/start-app`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to start app');
  }
  return res.json();
}

/** User answered "no" — server runs docker-compose down and dismisses the prompt. */
export async function closeAutoStartedApp(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/close-app`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to stop app');
  }
  return res.json();
}

/** Cancel the current working task (kills process, goes idle, keeps history) */
export async function cancelSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/cancel`, {
    method: 'POST',
  });
  return res.json();
}

/** Confirm execution of a pending plan_preview */
export async function confirmPlan(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/confirm`, {
    method: 'POST',
  });
  return res.json();
}

/** Discard a pending plan_preview without executing */
export async function discardPlan(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/discard`, {
    method: 'POST',
  });
  return res.json();
}

/** Request changes to a pending plan before execution */
export async function revisePlan(sessionId, feedback) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback }),
  });
  return res.json();
}

/** Pause the active agent — kills active processes, stores paused state */
export async function pauseSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/pause`, {
    method: 'POST',
  });
  return res.json();
}

export async function cleanProject(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/clean`, {
    method: 'POST',
  });
  return res.json();
}

export async function listSessions() {
  const res = await fetch(`${API_BASE}/sessions`);
  return res.json();
}

/** Rename a conversation in the session index */
export async function renameSession(sessionId, title) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/rename`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to rename session');
  }
  return res.json();
}

/**
 * Fork a session at a given user turn. Server creates a new session seeded
 * with the transcript up to (but not including) that turn, and reverts the
 * workspace files to the snapshot captured just before the turn ran.
 * Returns { newSessionId, restored, snapshotSha }.
 */
export async function branchSession(sessionId, fromEventTs) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromEventTs }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to branch session');
  }
  return res.json();
}

/** Permanently delete a conversation and its transcript */
export async function deleteSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to delete session');
  }
  return res.json();
}

export async function resumeSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/resume`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to resume session');
  }
  return res.json();
}

export async function getEnvironment() {
  const res = await fetch(`${API_BASE}/environment`);
  return res.json();
}

export async function refreshEnvironment() {
  const res = await fetch(`${API_BASE}/environment/refresh`, { method: 'POST' });
  return res.json();
}

// ── App secrets ──────────────────────────────────────────────────────────
export async function getAppSecrets() {
  const res = await fetch(`${API_BASE}/app-secrets`);
  if (!res.ok) {
    return { slots: [], gh: { available: false } };
  }
  return res.json();
}
export async function setAppSecret(name, { value, description } = {}) {
  const body = {};
  if (typeof value === 'string') body.value = value;
  if (typeof description === 'string') body.description = description;
  const res = await fetch(`${API_BASE}/app-secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to save ${name}`);
  return data;
}
export async function syncAppSecret(name) {
  const res = await fetch(`${API_BASE}/app-secrets/${encodeURIComponent(name)}/sync`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed to sync ${name}`);
  return data;
}

export async function getDockerStatus() {
  try {
    const res = await fetch(`${API_BASE}/docker/status`);
    if (!res.ok) return { running: false };
    return res.json();
  } catch {
    return { running: false };
  }
}

/**
 * Connect to the session event stream via Socket.IO.
 *
 * Matches snippets/realtime/websocket-helper.js — Socket.IO negotiates
 * transport automatically and falls back to HTTP long-polling if the proxy
 * (e.g. Codespaces' private-port tunnel) rejects the WebSocket upgrade.
 *
 * Protocol:
 *   - Connect with `{ query: { sessionId } }`; server joins the socket
 *     to `session:<sessionId>` room.
 *   - Server emits one `history_batch` with the full transcript, then
 *     `event` for every subsequent session event or global meta tick.
 *
 * @param {string} sessionId
 * @param {function} onEvent - called for each event (history_batch included)
 * @param {function} onStatusChange - 'connected' | 'disconnected' | 'reconnecting'
 * @returns {{ close: function }}
 */
import { io as createSocket } from 'socket.io-client';

export function connectStream(sessionId, onEvent, onStatusChange) {
  // Codespaces' private-port tunnel rejects the WebSocket upgrade handshake,
  // so when we detect that hostname we skip the upgrade attempt entirely —
  // polling works fine and this keeps the console clean. Everywhere else we
  // still upgrade to WS when the proxy allows it.
  const isCodespacesTunnel = /\.(app|preview)\.github\.dev$/i.test(
    typeof window !== 'undefined' ? window.location.hostname : ''
  );

  const socket = createSocket({
    path: '/socket.io',
    query: { sessionId },
    // Start with polling — works through every HTTP proxy. Upgrade to WS
    // only when the environment is likely to support it.
    transports: isCodespacesTunnel ? ['polling'] : ['polling', 'websocket'],
    upgrade: !isCodespacesTunnel,
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15_000,
  });

  socket.on('connect', () => onStatusChange?.('connected'));
  socket.on('disconnect', () => onStatusChange?.('disconnected'));
  socket.io.on('reconnect_attempt', () => onStatusChange?.('reconnecting'));

  socket.on('history_batch', (batch) => {
    onEvent({ type: 'history_batch', events: batch?.events || [] });
  });
  socket.on('event', (event) => {
    onEvent(event);
  });

  return {
    close() {
      try { socket.disconnect(); } catch { /* already gone */ }
    },
  };
}
