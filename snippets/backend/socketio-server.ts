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

// IMPORTANT: use server.listen(), not app.listen()
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

export { server, io };
