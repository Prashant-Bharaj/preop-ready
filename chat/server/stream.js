import { WebSocketServer } from 'ws';
import { sessionEvents } from './session.js';
import { readTail } from './transcript.js';
import { getGitMeta } from './git-meta.js';

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const match = req.url?.match(/^\/api\/session\/([^/]+)\/stream/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionId = match[1];
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const sessionId = ws.sessionId;

    // Send recent transcript as a single batch so the frontend can
    // replace (not append) its events array — prevents duplication on reconnect.
    const history = readTail(sessionId, 200);
    safeSend(ws, { type: 'history_batch', events: history });

    const handler = (evtSessionId, event) => {
      if (evtSessionId === sessionId) safeSend(ws, event);
    };
    sessionEvents.on('event', handler);

    ws.on('close', () => sessionEvents.off('event', handler));
    ws.on('error', () => sessionEvents.off('event', handler));
  });

  // Git metadata polling every 5 seconds
  setInterval(() => {
    const meta = getGitMeta();
    const event = { ts: Date.now(), type: 'meta', payload: meta };
    for (const ws of wss.clients) {
      safeSend(ws, event);
    }
  }, 5000);

  return wss;
}

function safeSend(ws, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
