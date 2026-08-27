/**
 * scopes: [backend]
 * flags: [real-time]
 * description: WebSocket helper (TypeScript) for broadcasting events to connected clients.
 */

/**
 * WebSocket Helper (Socket.IO) — TypeScript
 *
 * Server-side Socket.IO setup for real-time features. Includes
 * authentication via OIDC headers, room management, and authorization hooks.
 *
 * Dependencies:
 *   Server: npm install socket.io
 *   Client: npm install socket.io-client (or use CDN)
 *
 * Environment variables: none required. Uses existing OIDC headers from ALB.
 *
 * Usage (server, e.g. backend/src/index.ts):
 *   import { createSocketServer } from './websocket-helper.js';
 *   const io = createSocketServer(server);
 *
 * IMPORTANT:
 *   WebSocket connections go through Traefik on the same domain.
 *   Use window.location.origin for the connection URL (no CORS issues).
 *   When the ALB OIDC session expires (1 hour), the WebSocket will
 *   disconnect. Handle reconnection with a page reload fallback on the client.
 *
 * For the client-side helper, see the commented block at the bottom of this file
 * — copy into frontend/src/socket.ts.
 */

import { Server, type Socket, type ServerOptions } from 'socket.io';
import type { Server as HttpServer } from 'http';

export interface AuthenticatedUser {
  userId: string;
  email: string | null;
  name: string | null;
  isLocalDev: boolean;
}

// Augment Socket type so socket.user is typed.
declare module 'socket.io' {
  interface Socket {
    user?: AuthenticatedUser;
  }
}

export type AuthorizeRoom = (
  socket: Socket,
  roomName: string
) => boolean | Promise<boolean>;

export interface CreateSocketServerOptions extends Partial<ServerOptions> {
  authorizeRoom?: AuthorizeRoom;
}

/**
 * Create a Socket.IO server attached to an HTTP server.
 */
export function createSocketServer(
  httpServer: HttpServer,
  options: CreateSocketServerOptions = {}
): Server {
  const { authorizeRoom, ...socketOptions } = options;
  const io = new Server(httpServer, {
    cors: {
      origin:
        process.env.NODE_ENV === 'development'
          ? [
              'http://localhost:8080',
              'http://localhost:5173',
              'http://localhost:3000',
            ]
          : false, // Same origin in production
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    ...socketOptions,
  });

  // --- Authentication middleware ---
  io.use((socket, next) => {
    const user = extractUserFromSocket(socket);
    if (!user) {
      return next(new Error('Authentication required'));
    }
    socket.user = user;
    next();
  });

  // --- Connection handler ---
  io.on('connection', (socket: Socket) => {
    const user = socket.user as AuthenticatedUser;
    console.log(`[WS] Connected: ${user.email || user.userId} (${socket.id})`);

    socket.join(`user:${user.userId}`);

    socket.on('join-room', async (roomName: unknown) => {
      if (
        typeof roomName !== 'string' ||
        roomName.length > 100 ||
        !/^[a-zA-Z0-9_:-]+$/.test(roomName)
      ) {
        socket.emit('error', { message: 'Invalid room name' });
        return;
      }
      if (authorizeRoom) {
        try {
          const allowed = await authorizeRoom(socket, roomName);
          if (!allowed) {
            socket.emit('error', { message: 'Not authorized to join this room' });
            return;
          }
        } catch (err) {
          console.error(`[WS] Room auth error for ${roomName}:`, err);
          socket.emit('error', { message: 'Authorization check failed' });
          return;
        }
      }
      socket.join(roomName);
      console.log(`[WS] ${user.email} joined room: ${roomName}`);
      socket.to(roomName).emit('user-joined', {
        userId: user.userId,
        name: user.name,
        room: roomName,
      });
    });

    socket.on('leave-room', (roomName: string) => {
      socket.leave(roomName);
      console.log(`[WS] ${user.email} left room: ${roomName}`);
      socket.to(roomName).emit('user-left', {
        userId: user.userId,
        name: user.name,
        room: roomName,
      });
    });

    socket.on(
      'message',
      ({ room, content }: { room?: string; content?: string }) => {
        if (!room || !content) return;
        io.to(room).emit('message', {
          from: { userId: user.userId, name: user.name },
          content,
          timestamp: new Date().toISOString(),
        });
      }
    );

    socket.on('disconnect', (reason: string) => {
      console.log(`[WS] Disconnected: ${user.email} (${reason})`);
    });
  });

  return io;
}

/**
 * Extract user identity from Socket.IO handshake headers.
 * The ALB injects OIDC headers on the initial WebSocket upgrade request.
 */
function extractUserFromSocket(socket: Socket): AuthenticatedUser | null {
  const headers = socket.handshake.headers;
  const rawOidcData = headers['x-amzn-oidc-data'];
  const rawOidcIdentity = headers['x-amzn-oidc-identity'];
  const oidcData = Array.isArray(rawOidcData) ? rawOidcData[0] : rawOidcData;
  const oidcIdentity = Array.isArray(rawOidcIdentity)
    ? rawOidcIdentity[0]
    : rawOidcIdentity;

  if (!oidcData && !oidcIdentity) {
    if (process.env.NODE_ENV === 'development') {
      return {
        userId: 'local-dev-user',
        email: 'developer@bayer.com',
        name: 'Local Developer',
        isLocalDev: true,
      };
    }
    return null;
  }

  if (oidcData) {
    try {
      const parts = oidcData.split('.');
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64').toString('utf8')
      ) as {
        sub?: string;
        email?: string;
        name?: string;
        given_name?: string;
        family_name?: string;
      };
      return {
        userId: payload.sub || oidcIdentity || 'unknown',
        email: payload.email || null,
        name:
          payload.name ||
          `${payload.given_name || ''} ${payload.family_name || ''}`.trim() ||
          null,
        isLocalDev: false,
      };
    } catch {
      return {
        userId: oidcIdentity || 'unknown',
        email: null,
        name: null,
        isLocalDev: false,
      };
    }
  }
  return {
    userId: oidcIdentity || 'unknown',
    email: null,
    name: null,
    isLocalDev: false,
  };
}

/**
 * Send a message to a specific user by their OIDC user ID.
 */
export function sendToUser(
  io: Server,
  userId: string,
  event: string,
  data: unknown
): void {
  io.to(`user:${userId}`).emit(event, data);
}

// =============================================================================
// CLIENT SIDE — copy into frontend/src/socket.ts
// =============================================================================
// import { io, type Socket } from 'socket.io-client';
//
// let socket: Socket | null = null;
// let reconnectAttempts = 0;
// const MAX_RECONNECT_ATTEMPTS = 10;
//
// export function createSocketClient(): Socket {
//   if (socket?.connected) return socket;
//   socket = io(window.location.origin, {
//     path: '/socket.io',
//     reconnection: true,
//     reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
//     reconnectionDelay: 1000,
//     reconnectionDelayMax: 10000,
//     transports: ['websocket', 'polling'],
//   });
//
//   socket.on('connect', () => {
//     console.log('[WS] Connected:', socket?.id);
//     reconnectAttempts = 0;
//   });
//
//   socket.on('disconnect', (reason) => {
//     console.log('[WS] Disconnected:', reason);
//     if (reason === 'io server disconnect') {
//       window.location.reload();
//     }
//   });
//
//   socket.on('connect_error', (error) => {
//     reconnectAttempts++;
//     console.error(`[WS] Connection error (attempt ${reconnectAttempts}):`, error.message);
//     if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
//       window.location.reload();
//     }
//   });
//
//   return socket;
// }
//
// export function joinRoom(roomName: string)  { socket?.emit('join-room',  roomName); }
// export function leaveRoom(roomName: string) { socket?.emit('leave-room', roomName); }
// export function sendMessage(room: string, content: string) { socket?.emit('message', { room, content }); }
// export function disconnect() { socket?.disconnect(); socket = null; }
