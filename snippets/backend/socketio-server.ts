/**
 * scopes: [backend]
 * flags: [real-time]
 * description: Socket.IO WebSocket server (TypeScript) with room management and presence.
 */

/**
 * Socket.IO Server Setup (TypeScript)
 *
 * WebSocket support for real-time features (live updates, notifications, chat).
 * IMPORTANT: use server.listen(), NOT app.listen() — wraps Express with HTTP server.
 *
 * Dependencies: socket.io (add to package.json)
 * Frontend connects with: const socket = io(window.location.origin);
 * nginx.local.conf already proxies /socket.io/ to backend:3000/socket.io/
 */

import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { Express } from 'express';

// Wrap your Express app
declare const app: Express; // expected to be defined in the entry file scope
declare const PORT: number;

// Lock WebSocket CORS to the app's own origin. `origin: '*'` disables the WS
// origin check, letting a malicious intranet page open a socket as the
// logged-in victim (cross-site WebSocket hijacking) and drive any
// socket-triggered action. Set APP_ORIGIN in production, e.g.
// APP_ORIGIN=https://<repo>.vibe.intranet.cnb (comma-separate for multiple).
const ALLOWED_ORIGINS: string[] = (process.env.APP_ORIGIN || 'http://localhost:8080')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const server: HttpServer = createServer(app);
const io: SocketIOServer = new SocketIOServer(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
});

io.on('connection', (socket: Socket) => {
  // Defense in depth: reject a handshake whose Origin isn't allowlisted.
  const origin = socket.handshake.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.disconnect(true);
    return;
  }
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ── Broadcasting on a state change (the point of real-time) ─────────────────
// A socket that only handles `connection` pushes NOTHING to clients. For a live
// app you MUST emit whenever data changes — from your REST handlers, AFTER the
// write succeeds — so clients update without polling. Example: a route that
// updates a row and then broadcasts it.
//
//   app.put('/lines/:id/status', async (req, res) => {
//     const { rows } = await pool.query(
//       'UPDATE lines SET status = $1 WHERE id = $2 RETURNING *',
//       [req.body.status, req.params.id],
//     );
//     if (!rows[0]) return res.status(404).json({ error: 'NOT_FOUND', message: 'Line not found', statusCode: 404 });
//     broadcast('status-changed', rows[0]);   // ← push to every connected client
//     res.json(rows[0]);
//   });
//
// Room-scoped variant (when sockets join rooms): io.to(`line:${id}`).emit(...).
export function broadcast<T>(event: string, payload: T): void {
  io.emit(event, payload);
}

// IMPORTANT: use server.listen(), not app.listen()
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

export { server, io };
