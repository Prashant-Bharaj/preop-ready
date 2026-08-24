import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mountAuthRoutes } from './core/auth.js';
import { mountSessionRoutes } from './session/routes.js';
import { mountEnvironmentRoutes } from './core/environment.js';
import { mountUploadRoutes } from './routes/uploads.js';
import { mountAppSecretsRoutes } from './routes/app-secrets.js';
import { ensureBackendEnvScaffold } from './core/app-secrets-scaffold.js';
import { startValidatorInBackground } from './reconciler/sql-validation-db.js';
import { attachSocketIO } from './util/stream.js';
import path from 'node:path';
import { STATIC_DIR, WORKSPACE_DIR } from './core/paths.js';

const PORT = process.env.PORT || 5050;

const ALLOWED_ORIGINS = (
  process.env.CHAT_ALLOWED_ORIGINS ||
  'http://localhost:8888,http://localhost:5173,http://localhost:5050,http://127.0.0.1:8888,http://127.0.0.1:5050'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Codespaces port-forward URLs are dynamic — derive them from env.
if (process.env.CODESPACE_NAME) {
  const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  ALLOWED_ORIGINS.push(`https://${process.env.CODESPACE_NAME}-8888.${domain}`);
  ALLOWED_ORIGINS.push(`https://${process.env.CODESPACE_NAME}-5050.${domain}`);
}

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

// Baseline security headers (chat is dev-time only, but still apply the minimum).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// API routes
mountAuthRoutes(app);
mountSessionRoutes(app);
mountEnvironmentRoutes(app);
mountUploadRoutes(app);
mountAppSecretsRoutes(app);

// Scaffold backend/.env once per boot (idempotent — skipped if file exists
// or backend/ doesn't exist yet).
const scaffold = ensureBackendEnvScaffold(WORKSPACE_DIR);
if (scaffold.created) {
  console.log(`[runner] Scaffolded ${scaffold.created} with predefined slots`);
}

// Serve docs folder (example prompts, etc.)
const docsDir = path.join(WORKSPACE_DIR, 'docs');
if (existsSync(docsDir)) {
  app.use('/docs', express.static(docsDir));
}

// In production (Docker), serve the built frontend
if (existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  // SPA fallback — serve index.html for non-API routes
  app.get('*', (_req, res) => {
    res.sendFile('index.html', { root: STATIC_DIR });
  });
}

const server = createServer(app);
attachSocketIO(server);

server.listen(PORT, () => {
  console.log(`[runner] Chat service on port ${PORT}`);
  console.log(`[runner] Workspace: ${WORKSPACE_DIR}`);
  if (existsSync(STATIC_DIR)) {
    console.log(`[runner] Serving static files from ${STATIC_DIR}`);
  }
  // Pre-warm the SQL-validation Postgres (used by the reconciler's PREPARE gate)
  // so the first build doesn't pay a cold container boot. Fully best-effort —
  // never blocks startup; the gate fails open if it isn't ready.
  startValidatorInBackground();
});
