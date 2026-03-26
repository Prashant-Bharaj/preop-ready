/**
 * SNIPPET: CORS & Proxy Configuration
 * CATEGORY: Configuration
 * LANGUAGE: JavaScript (Node.js / Express)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   CORS middleware configuration for Express. Explains when CORS is and
 *   isn't needed on the Vibe platform, and provides correct configuration
 *   for the cases where it is.
 *
 * DEPENDENCIES:
 *   npm install cors
 *
 * USAGE:
 *   const { configureCors } = require('./cors-proxy');
 *   app.use(configureCors());
 *
 * IMPORTANT — WHEN DO YOU NEED CORS?
 *
 *   In MOST cases on this platform, you do NOT need CORS configuration:
 *
 *   PRODUCTION (deployed):
 *     Frontend and backend share the same origin (https://myapp.vibe.intranet.cnb).
 *     Traefik routes / to frontend:8080 and /api/* to backend:3000.
 *     Same origin = no CORS headers needed.
 *
 *   LOCAL DEV (docker-compose):
 *     nginx.local.conf proxies /api/* to backend:3000.
 *     Both served from localhost:8080 = same origin = no CORS.
 *
 *   WHEN YOU DO NEED CORS:
 *     - Vite dev server (localhost:5173) calling backend directly (localhost:3000)
 *     - External services calling your API (M2M via API Gateway handles this)
 *     - Multiple frontends on different subdomains calling your backend
 *
 * COMMON MISTAKES:
 *
 *   1. Using origin: '*' with credentials: true
 *      This is BLOCKED by browsers. You must specify exact origins.
 *
 *   2. Forgetting preflight (OPTIONS) requests
 *      Browsers send OPTIONS before POST/PUT/DELETE with custom headers.
 *      The cors middleware handles this automatically.
 *
 *   3. Setting CORS headers manually AND using the cors middleware
 *      Pick one approach. Doubling up causes duplicate headers.
 *
 *   4. Adding CORS when not needed
 *      If frontend and backend are on the same origin (production + docker-compose),
 *      CORS headers are unnecessary overhead. Only add when you actually get CORS errors.
 */

const cors = require('cors');

/**
 * Configure CORS middleware for Express.
 *
 * @param {object} options - Override defaults
 * @param {string[]} options.allowedOrigins - Allowed origins (default: common local dev origins)
 * @param {string[]} options.allowedMethods - Allowed HTTP methods
 * @param {string[]} options.allowedHeaders - Allowed headers
 * @returns {Function} Express middleware
 */
function configureCors(options = {}) {
  const isProduction = process.env.NODE_ENV === 'production';

  // In production, same-origin — no CORS needed.
  // Return a no-op middleware.
  if (isProduction) {
    return (req, res, next) => next();
  }

  // Local development — allow common dev server origins
  const allowedOrigins = options.allowedOrigins || [
    'http://localhost:5173', // Vite dev server
    'http://localhost:8080', // nginx / docker-compose
    'http://localhost:3000', // Direct backend access
    'http://localhost:8888', // Chat UI
  ];

  return cors({
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
    credentials: true, // Allow cookies and auth headers
    methods: options.allowedMethods || ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: options.allowedHeaders || [
      'Content-Type',
      'Authorization',
      'x-api-key',
      'x-requested-with',
    ],
    // Cache preflight response for 1 hour (reduces OPTIONS requests)
    maxAge: 3600,
  });
}

module.exports = { configureCors };
