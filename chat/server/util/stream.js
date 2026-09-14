import { Server as IOServer } from 'socket.io';
import { sessionEvents } from '../session/events.js';
import { readAll } from '../session/transcript.js';
import { getGitMeta } from './git-meta.js';

// Live session state the transcript alone can't answer. `plan_preview` is
// persisted, but whether the user has since confirmed/discarded/revised it
// lives only on the in-memory session (routes.js owns that map). routes.js
// registers a checker at startup; without one, no plan is ever reported.
let pendingPlanCheck = null;
export function setPendingPlanCheck(fn) { pendingPlanCheck = typeof fn === 'function' ? fn : null; }

/**
 * The plan the UI must show a confirm card for on (re)connect: the payload
 * of the LAST plan_preview in the transcript, when the session still holds
 * it pending. Null otherwise. Observed live: a page reload (or a Codespaces
 * port-forward reconnect) replayed the transcript but dropped the card, so
 * the server waited for a confirmation the user could no longer give.
 */
export function pendingPlanFromHistory(events, stillPending) {
  if (!stillPending || !Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'plan_preview' && ev.payload) return ev.payload;
  }
  return null;
}

/**
 * Event delivery via Socket.IO, matching the pattern from
 * snippets/realtime/websocket-helper.ts.
 *
 * Socket.IO negotiates transport automatically: WebSocket when the proxy
 * allows the upgrade, HTTP long-polling when it doesn't (e.g. Codespaces'
 * private-port tunnel). The client sees a single unified API; the transport
 * switch is invisible.
 *
 * Protocol:
 *   - Client connects with `{ query: { sessionId } }`.
 *   - Server puts the socket in room `session:<sessionId>`, then emits one
 *     `history_batch` with the full transcript.
 *   - Subsequent events from `sessionEvents` are forwarded to the socket's
 *     session room as `event` emissions.
 *   - A 5s git-meta broadcast is sent to every room.
 */
let ioRef = null;

/** Send an event to every connected client, whatever session it is in. */
export function broadcastEvent(event) {
  ioRef?.emit('event', event);
}

/** Number of browser tabs currently connected. */
export function connectedClientCount() {
  return ioRef?.engine?.clientsCount || 0;
}

export function attachSocketIO(httpServer) {
  const io = new IOServer(httpServer, {
    // Same-origin in production; localhost-dev needs explicit allowlist.
    cors: {
      origin: (origin, cb) => cb(null, true),
      credentials: true,
    },
    // Polling first, upgrade to websocket only if available. This is the
    // reverse of Socket.IO's default ('websocket','polling') and matches
    // locked-down tunnels better — we skip the failed upgrade attempt.
    transports: ['polling', 'websocket'],
    // Keep connections alive through idle proxies.
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.on('connection', (socket) => {
    const sessionId = socket.handshake.query?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      socket.emit('error', { message: 'sessionId query param is required' });
      socket.disconnect(true);
      return;
    }

    const room = `session:${sessionId}`;
    socket.join(room);
    socket.data.sessionId = sessionId;

    // Initial full-transcript replay so the UI can paint from empty, plus
    // the one piece of live state the transcript can't carry (see above).
    const events = readAll(sessionId);
    let stillPending = false;
    try { stillPending = Boolean(pendingPlanCheck && pendingPlanCheck(sessionId)); } catch { stillPending = false; }
    socket.emit('history_batch', { events, pendingPlan: pendingPlanFromHistory(events, stillPending) });
  });

  // Forward persisted + ephemeral session events to whoever is listening.
  sessionEvents.on('event', (sessionId, event) => {
    io.to(`session:${sessionId}`).emit('event', event);
  });

  // Git metadata broadcast — sent to every connected room.
  setInterval(() => {
    const meta = getGitMeta();
    const event = { ts: Date.now(), type: 'meta', payload: meta };
    // Emit to ALL sockets; each client only handles events for its session.
    io.emit('event', event);
  }, 5000);

  ioRef = io;
  return io;
}
