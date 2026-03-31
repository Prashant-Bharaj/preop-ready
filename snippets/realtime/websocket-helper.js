/**
 * SNIPPET: WebSocket Helper (Socket.IO)
 * CATEGORY: Realtime
 * LANGUAGE: JavaScript (Node.js + Browser)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Server and client Socket.IO setup for real-time features.
 *   Includes authentication via OIDC headers, room management,
 *   and reconnect logic with exponential backoff.
 *
 * DEPENDENCIES:
 *   Server: npm install socket.io
 *   Client: npm install socket.io-client (or use CDN)
 *
 * ENVIRONMENT VARIABLES:
 *   None required. Uses existing OIDC headers from ALB for authentication.
 *
 * USAGE:
 *   // Server (backend/src/index.js)
 *   const { createSocketServer } = require('./websocket-helper');
 *   const io = createSocketServer(server);
 *
 *   // Client (frontend)
 *   import { createSocketClient } from './websocket-helper-client';
 *   const socket = createSocketClient();
 *
 * RELATED:
 *   - auth/user-identity.js (extractUserIdentity for socket auth)
 *   - auth/token-refresh.js (session expiry causes socket disconnect)
 *
 * IMPORTANT:
 *   WebSocket connections go through Traefik on the same domain.
 *   Use window.location.origin for the connection URL (no CORS issues).
 *   When the ALB OIDC session expires (1 hour), the WebSocket will
 *   disconnect. Handle reconnection with a page reload fallback.
 */

// =============================================================================
// SERVER SIDE — Add to your backend (e.g. backend/src/index.js)
// =============================================================================

const { Server } = require('socket.io');

/**
 * Create a Socket.IO server attached to an HTTP server.
 *
 * @param {http.Server} httpServer - The HTTP server instance
 * @param {object} options - Additional Socket.IO options
 * @param {function} [options.authorizeRoom] - Optional async callback (socket, roomName) => boolean.
 *   If provided, called before allowing a user to join a room. Return true to allow, false to deny.
 *   Example: (socket, room) => room.startsWith(`project:${socket.user.projectId}`)
 * @returns {Server} Socket.IO server instance
 */
function createSocketServer(httpServer, options = {}) {
  const { authorizeRoom, ...socketOptions } = options;
  const io = new Server(httpServer, {
    // In production, Traefik handles routing — same origin, no CORS needed.
    // For local dev with docker-compose, nginx proxies WebSocket too.
    cors: {
      origin: process.env.NODE_ENV === 'development'
        ? ['http://localhost:8080', 'http://localhost:5173', 'http://localhost:3000']
        : false, // Same origin in production
      credentials: true,
    },
    // Ping every 25s, timeout after 20s — keeps connection alive through proxies
    pingInterval: 25000,
    pingTimeout: 20000,
    ...socketOptions,
  });

  // --- Authentication middleware ---
  // Extract user identity from OIDC headers (same as REST endpoints)
  io.use((socket, next) => {
    const user = extractUserFromSocket(socket);
    if (!user) {
      return next(new Error('Authentication required'));
    }
    socket.user = user;
    next();
  });

  // --- Connection handler ---
  io.on('connection', (socket) => {
    console.log(`[WS] Connected: ${socket.user.email || socket.user.userId} (${socket.id})`);

    // Join user to their personal room (for targeted messages)
    socket.join(`user:${socket.user.userId}`);

    // --- Room management ---
    socket.on('join-room', async (roomName) => {
      // Validate room name (prevent injection)
      if (typeof roomName !== 'string' || roomName.length > 100 || !/^[a-zA-Z0-9_:-]+$/.test(roomName)) {
        socket.emit('error', { message: 'Invalid room name' });
        return;
      }
      // Authorization check (if provided)
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
      console.log(`[WS] ${socket.user.email} joined room: ${roomName}`);
      socket.to(roomName).emit('user-joined', {
        userId: socket.user.userId,
        name: socket.user.name,
        room: roomName,
      });
    });

    socket.on('leave-room', (roomName) => {
      socket.leave(roomName);
      console.log(`[WS] ${socket.user.email} left room: ${roomName}`);
      socket.to(roomName).emit('user-left', {
        userId: socket.user.userId,
        name: socket.user.name,
        room: roomName,
      });
    });

    // --- Example: broadcast message to a room ---
    socket.on('message', ({ room, content }) => {
      if (!room || !content) return;
      io.to(room).emit('message', {
        from: { userId: socket.user.userId, name: socket.user.name },
        content,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WS] Disconnected: ${socket.user.email} (${reason})`);
    });
  });

  return io;
}

/**
 * Extract user identity from Socket.IO handshake headers.
 * The ALB injects OIDC headers on the initial WebSocket upgrade request.
 */
function extractUserFromSocket(socket) {
  const headers = socket.handshake.headers;
  const oidcData = headers['x-amzn-oidc-data'];
  const oidcIdentity = headers['x-amzn-oidc-identity'];

  if (!oidcData && !oidcIdentity) {
    // Local development fallback
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

  try {
    const parts = oidcData.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return {
      userId: payload.sub || oidcIdentity,
      email: payload.email,
      name: payload.name || `${payload.given_name || ''} ${payload.family_name || ''}`.trim(),
      isLocalDev: false,
    };
  } catch {
    return { userId: oidcIdentity, email: null, name: null, isLocalDev: false };
  }
}

/**
 * Send a message to a specific user by their OIDC user ID.
 *
 * @param {Server} io - Socket.IO server instance
 * @param {string} userId - Target user's OIDC subject ID
 * @param {string} event - Event name
 * @param {*} data - Event data
 */
function sendToUser(io, userId, event, data) {
  io.to(`user:${userId}`).emit(event, data);
}

module.exports = { createSocketServer, sendToUser };


// =============================================================================
// CLIENT SIDE — Add to your frontend (e.g. frontend/src/socket.js)
// =============================================================================
// Copy the code below into a separate file for the frontend.
//
// import { io } from 'socket.io-client';
//
// let socket = null;
// let reconnectAttempts = 0;
// const MAX_RECONNECT_ATTEMPTS = 10;
//
// /**
//  * Create and return a Socket.IO client connection.
//  * Uses the same origin (Traefik routes WebSocket traffic).
//  */
// export function createSocketClient() {
//   if (socket?.connected) return socket;
//
//   // Connect to same origin — Traefik handles routing
//   socket = io(window.location.origin, {
//     // Path must match what Traefik expects
//     path: '/socket.io',
//     // Let Socket.IO handle reconnection
//     reconnection: true,
//     reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
//     reconnectionDelay: 1000,
//     reconnectionDelayMax: 10000,
//     // Start with WebSocket, fall back to polling if needed
//     transports: ['websocket', 'polling'],
//   });
//
//   socket.on('connect', () => {
//     console.log('[WS] Connected:', socket.id);
//     reconnectAttempts = 0;
//   });
//
//   socket.on('disconnect', (reason) => {
//     console.log('[WS] Disconnected:', reason);
//     // If server closed connection (likely session expired), reload page
//     if (reason === 'io server disconnect') {
//       console.log('[WS] Server disconnected — session may have expired. Reloading...');
//       window.location.reload();
//     }
//   });
//
//   socket.on('connect_error', (error) => {
//     reconnectAttempts++;
//     console.error(`[WS] Connection error (attempt ${reconnectAttempts}):`, error.message);
//     // After max attempts, reload page (session likely expired)
//     if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
//       console.log('[WS] Max reconnect attempts reached. Reloading page...');
//       window.location.reload();
//     }
//   });
//
//   return socket;
// }
//
// /** Join a room */
// export function joinRoom(roomName) {
//   socket?.emit('join-room', roomName);
// }
//
// /** Leave a room */
// export function leaveRoom(roomName) {
//   socket?.emit('leave-room', roomName);
// }
//
// /** Send a message to a room */
// export function sendMessage(room, content) {
//   socket?.emit('message', { room, content });
// }
//
// /** Disconnect and cleanup */
// export function disconnect() {
//   socket?.disconnect();
//   socket = null;
// }
