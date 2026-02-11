import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mountAuthRoutes } from './auth.js';
import { mountSessionRoutes } from './session.js';
import { mountEnvironmentRoutes } from './environment.js';
import { attachWebSocket } from './stream.js';
import { STATIC_DIR, WORKSPACE_DIR } from './paths.js';

const PORT = process.env.PORT || 5050;

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// API routes
mountAuthRoutes(app);
mountSessionRoutes(app);
mountEnvironmentRoutes(app);

// In production (Docker), serve the built frontend
if (existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  // SPA fallback — serve index.html for non-API routes
  app.get('*', (_req, res) => {
    res.sendFile('index.html', { root: STATIC_DIR });
  });
}

const server = createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log(`[runner] Chat service on port ${PORT}`);
  console.log(`[runner] Workspace: ${WORKSPACE_DIR}`);
  if (existsSync(STATIC_DIR)) {
    console.log(`[runner] Serving static files from ${STATIC_DIR}`);
  }
});
