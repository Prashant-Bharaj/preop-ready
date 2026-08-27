/**
 * scopes: [backend]
 * flags: []
 * description: Baseline Express server (TypeScript) with CORS, JSON body parsing, /health, port 3000. Starting point for any Node.js backend.
 *
 * Express Server Template (TypeScript)
 *
 * Basic Express server with CORS, JSON parsing, and health endpoint.
 * Routes are defined WITHOUT /api prefix — nginx/Traefik strips it.
 * Frontend calls /api/items → backend defines /items.
 *
 * Port: 3000 (fixed, do not change)
 *
 * Save this file to backend/src/index.ts. Dockerfile.node builds with `tsc`
 * (multi-stage) so the runtime CMD is `node dist/index.js`.
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';

// TODO (Phase 1 — W1.TYPES.GEN): once the contract type generator lands,
// pull endpoint request/response interfaces from the generated module:
//   import type { GetItemsResponse } from '../generated/contracts.js';
// The generator emits this file from .harness/contracts.json after every
// successful build/iterate. Until W1.TYPES.GEN ships, hand-write the shapes
// inline (see ItemsResponse below) or leave them as `unknown` / `any`.

interface HealthResponse {
  status: 'ok';
}

interface ItemsResponse {
  items: unknown[];
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check (REQUIRED — do not remove)
app.get('/health', (_req: Request, res: Response<HealthResponse>) =>
  res.json({ status: 'ok' })
);

// Routes — NO /api prefix! Frontend calls /api/X, backend defines /X
app.get('/items', (_req: Request, res: Response<ItemsResponse>) =>
  res.json({ items: [] })
);

// 4-arg error handler (REQUIRED — keep as the LAST app.use)
app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  res.status(500).json({ error: 'InternalServerError', message: err.message, statusCode: 500 });
});

// Express 4 does NOT route async rejections to the error middleware — these
// guards are the actual crash stopper. Log, never exit (REQUIRED).
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

const PORT: number = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
