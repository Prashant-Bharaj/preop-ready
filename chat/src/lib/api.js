const API_BASE = '/api';

export async function getAuthStatus() {
  const res = await fetch(`${API_BASE}/auth/status`);
  return res.json();
}

export async function getAuthSettings() {
  const res = await fetch(`${API_BASE}/auth/settings`);
  return res.json();
}

export async function saveAuthConfig({ baseUrl, apiKey, model, assistantId }) {
  const res = await fetch(`${API_BASE}/auth/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey, model, assistantId }),
  });
  return res.json();
}

export async function getModels() {
  const res = await fetch(`${API_BASE}/auth/models`);
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

export async function sendMessage(sessionId, message) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send message');
  }
  return res.json();
}

export async function resetSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/reset`, {
    method: 'POST',
  });
  return res.json();
}

export async function listSessions() {
  const res = await fetch(`${API_BASE}/sessions`);
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

/**
 * Connect to the event stream WebSocket with auto-reconnect.
 * @param {string} sessionId
 * @param {function} onEvent - called for each parsed event
 * @param {function} onStatusChange - called with 'connected' | 'disconnected' | 'reconnecting'
 * @returns {{ close: function }} - call close() to permanently disconnect
 */
export function connectStream(sessionId, onEvent, onStatusChange) {
  let ws = null;
  let closed = false;
  let retries = 0;
  const MAX_RETRIES = 20;
  const BASE_DELAY = 1000;

  function connect() {
    if (closed) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/api/session/${sessionId}/stream`);

    ws.onopen = () => {
      retries = 0;
      onStatusChange?.('connected');
    };

    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data);
        onEvent(event);
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      if (closed) return;
      onStatusChange?.('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    if (closed || retries >= MAX_RETRIES) return;
    retries++;
    const delay = Math.min(BASE_DELAY * Math.pow(1.5, retries - 1), 15000);
    onStatusChange?.('reconnecting');
    setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}
