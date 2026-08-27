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

const server: HttpServer = createServer(app);
const io: SocketIOServer = new SocketIOServer(server, {
  cors: { origin: '*' },
});

io.on('connection', (socket: Socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// IMPORTANT: use server.listen(), not app.listen()
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

export { server, io };
