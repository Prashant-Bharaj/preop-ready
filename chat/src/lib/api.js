const API_BASE = '/api';

export async function getAuthStatus() {
  const res = await fetch(`${API_BASE}/auth/status`);
  return res.json();
}

export async function saveAuthConfig({ baseUrl, apiKey, model }) {
  const res = await fetch(`${API_BASE}/auth/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey, model }),
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
  return res.json();
}

export async function resetSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}/reset`, {
    method: 'POST',
  });
  return res.json();
}

export function connectStream(sessionId, onEvent) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/session/${sessionId}/stream`);

  ws.onmessage = (evt) => {
    try {
      const event = JSON.parse(evt.data);
      onEvent(event);
    } catch {
      // ignore malformed
    }
  };

  ws.onerror = (err) => console.error('[ws] error', err);

  return ws;
}
