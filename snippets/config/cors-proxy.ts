/**
 * scopes: [backend]
 * flags: [cors-proxy]
 * description: Express CORS-safe proxy for external APIs the frontend cannot call directly.
 */

/**
 * CORS & Proxy Configuration (TypeScript)
 *
 * CORS middleware configuration for Express. Explains when CORS is and
 * isn't needed on the Vibe platform, and provides correct configuration
 * for the cases where it is.
 *
 * Dependencies:
 *   npm install cors
 *   npm install -D @types/cors
 *
 * Usage:
 *   import { configureCors } from './cors-proxy.js';
 *   app.use(configureCors());
 *
 * WHEN DO YOU NEED CORS?
 *
 *   In MOST cases on this platform, you do NOT need CORS configuration:
 *
 *   PRODUCTION (deployed):
 *     Frontend and backend share the same origin.
 *     Traefik routes / to frontend:8080 and /api/* to backend:3000.
 *     Same origin = no CORS headers needed.
 *
 *   LOCAL DEV (docker-compose):
 *     nginx.local.conf proxies /api/* to backend:3000.
 *     Both served from localhost:8080 = same origin = no CORS.
 *
 *   WHEN YOU DO NEED CORS:
 *     - Vite dev server (localhost:5173) calling backend directly (localhost:3000)
 *     - External services calling your API
 *     - Multiple frontends on different subdomains calling your backend
 *
 * COMMON MISTAKES:
 *   1. origin: '*' with credentials: true — blocked by browsers.
 *   2. Forgetting OPTIONS preflight — the cors middleware handles this automatically.
 *   3. Setting CORS headers manually AND using the cors middleware — picks duplicates.
 *   4. Adding CORS when same-origin — unnecessary overhead.
 */

import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';

export interface ConfigureCorsOptions {
  allowedOrigins?: string[];
  allowedMethods?: string[];
  allowedHeaders?: string[];
}

/**
 * Configure CORS middleware for Express.
 *
 * In production (NODE_ENV === 'production') returns a no-op middleware
 * because frontend + backend share the same origin behind Traefik.
 */
export function configureCors(options: ConfigureCorsOptions = {}): RequestHandler {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    return (_req, _res, next) => next();
  }

  const allowedOrigins = options.allowedOrigins || [
    'http://localhost:5173', // Vite dev server
    'http://localhost:8080', // nginx / docker-compose
    'http://localhost:3000', // Direct backend access
    'http://localhost:8888', // Chat UI
  ];

  const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
      // Allow requests with no origin (Postman, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked request from origin: ${origin}`);
        callback(new Error(`CORS: Origin ${origin} not allowed`));
      }
    },
    credentials: true,
    methods: options.allowedMethods || [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'OPTIONS',
    ],
    allowedHeaders: options.allowedHeaders || [
      'Content-Type',
      'Authorization',
      'x-api-key',
      'x-requested-with',
    ],
    maxAge: 3600,
  };

  return cors(corsOptions);
}
