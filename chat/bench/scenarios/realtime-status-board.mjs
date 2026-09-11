/**
 * Realtime class — Socket.IO through the frontend proxy. The platform's
 * critical rule (`/socket.io/*` routes to backend, clients connect via
 * window.location.origin) had ZERO end-to-end coverage before this scenario.
 * 3-action test: REST status change works → a socket.io client connects
 * through :8080 → a second status change is pushed to the connected client
 * without polling. Plus history keeps the changes.
 */

import { io } from 'socket.io-client';
import { APP_URL, api, apiSmart, discoverEp, fill } from '../lib/app-client.mjs';

function firstId(body) {
  if (body == null || typeof body !== 'object') return null;
  if (Array.isArray(body)) { for (const v of body) { const id = firstId(v); if (id != null) return id; } return null; }
  if (body.id != null) return body.id;
  for (const v of Object.values(body)) { if (v && typeof v === 'object') { const id = firstId(v); if (id != null) return id; } }
  return null;
}

export default {
  name: 'realtime-status-board',
  prompt: 'Build a live production line status board. Operators set a line\'s status (running, blocked, down) and everyone watching the board sees the change instantly without refreshing. Keep a history of status changes.',

  answerClarify() {
    return [
      'Single role: operator — everyone can set and view.',
      'The lines are a fixed set configured once (e.g. three lines) — the app only changes their status, it does not create or delete lines.',
      'Statuses are exactly: running, blocked, down.',
      'Instant updates must be pushed over websockets (Socket.IO), not polling.',
      'History shows line, old status, new status, and timestamp. No extras.',
    ].join(' ');
  },

  expectations: { aiApp: false },

  async threeAction(marker) {
    const actions = [];

    // A line to work with. Lines are a fixed reference set in most builds
    // (no create route) — the harness pre-seeds them, so read the first id
    // from the list like a user would; create one only when the API offers it.
    const lineEp = discoverEp('POST', /^\/[^:]*line[^:]*$/i);
    const line = lineEp
      ? await apiSmart('POST', lineEp.path, { role: 'operator', spec: lineEp.request, marker, overrides: { name: `Bench Line ${marker}` } })
      : { status: -1, json: null, text: 'no line-creation endpoint in contract' };
    let lineId = line.json?.id ?? null;
    if (lineId == null) {
      const listEp = discoverEp('GET', /^\/[^:]*line[^:]*$/i);
      const list = listEp ? await api('GET', listEp.path, { role: 'operator' }) : null;
      lineId = firstId(list?.json) ?? 1;
    }

    // 1. REST: set a status.
    const statusEp = discoverEp('PUT', /status/i) || discoverEp('PATCH', /status/i) || discoverEp('POST', /status/i)
      || discoverEp('PUT', /line/i) || discoverEp('PATCH', /line/i);
    const set = statusEp
      ? await apiSmart(statusEp.method, fill(statusEp.path, { id: lineId }), { role: 'operator', spec: statusEp.request, marker, overrides: { status: 'blocked' } })
      : { status: -1, text: 'no status endpoint in contract' };
    actions.push({
      name: 'operator sets a line status (REST)',
      ok: set.status >= 200 && set.status < 300,
      detail: `HTTP ${set.status} ${(set.text || '').slice(0, 80)}`,
    });

    // 2+3. Socket.IO through the frontend proxy: connect, then a status
    // change must be PUSHED to the already-connected client.
    let socket = null;
    let connected = false;
    let pushed = null;
    try {
      socket = io(APP_URL, { transports: ['websocket', 'polling'], timeout: 8000, reconnection: false });
      connected = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 10_000);
        socket.on('connect', () => { clearTimeout(t); resolve(true); });
        socket.on('connect_error', () => { clearTimeout(t); resolve(false); });
      });
      if (connected) {
        const gotEvent = new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 12_000);
          socket.onAny((event, ...args) => {
            const payload = JSON.stringify(args);
            if (payload.includes(String(lineId)) || payload.includes(marker) || /status/i.test(event)) {
              clearTimeout(t);
              resolve({ event, payload: payload.slice(0, 120) });
            }
          });
        });
        // Trigger a second change AFTER subscribing.
        if (statusEp) {
          await apiSmart(statusEp.method, fill(statusEp.path, { id: lineId }), { role: 'operator', spec: statusEp.request, marker, overrides: { status: 'down' } });
        }
        pushed = await gotEvent;
      }
    } catch { /* assertions record the failure */ } finally {
      try { socket?.close(); } catch { /* ignore */ }
    }
    actions.push({
      name: 'socket.io client connects through the frontend proxy',
      ok: connected,
      detail: connected ? `connected via ${APP_URL}/socket.io` : 'connect failed/timed out — /socket.io/* routing broken',
    });
    actions.push({
      name: 'status change is pushed to connected clients',
      ok: Boolean(pushed),
      detail: pushed ? `event=${pushed.event} ${pushed.payload}` : 'no matching event within 12s of the change',
    });

    // 4. History keeps the changes.
    const histEp = discoverEp('GET', /hist|change|log/i);
    const hist = histEp
      ? await api('GET', fill(histEp.path, { id: lineId }), { role: 'operator' })
      : { status: -1, text: 'no history endpoint in contract' };
    const histBody = JSON.stringify(hist.json || hist.text || '');
    const histOk = hist.status === 200 && (histBody.includes(String(lineId)) || histBody.includes(marker)) && /blocked|down/.test(histBody);
    actions.push({
      name: 'history records the status changes',
      ok: histOk,
      detail: `HTTP ${hist.status} hasLine=${histBody.includes(String(lineId))} hasStatus=${/blocked|down/.test(histBody)}`,
    });

    return actions;
  },
};