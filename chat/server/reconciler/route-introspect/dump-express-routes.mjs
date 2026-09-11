// dump-express-routes.mjs — load a built Express backend and print its real
// route table as JSON. Run as: node dump-express-routes.mjs <entry-abs-path>
//
// The trick that avoids any "export your app" convention: a normal backend
// entry calls `app.listen(PORT)`, which internally does
// `http.createServer(app).listen(...)`. We stub http.Server.prototype.listen to
// a no-op that captures the request handler (the Express app) instead of
// binding a port. So importing the entry hands us the fully-configured app —
// every route registered, however it was declared — without starting a server.
//
// Everything is best-effort: on any failure we print nothing and exit non-zero,
// and the caller treats that as "introspection unavailable" (fail-open, never a
// false block).

import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { listEndpoints } from './list-endpoints.js';

const entry = process.argv[2];
if (!entry) process.exit(2);

let captured = null;

function looksLikeApp(h) {
  return !!h && (h._router || h.router || (typeof h === 'function' && typeof h.use === 'function' && typeof h.get === 'function'));
}

function capture(server) {
  try {
    const handler = server.listeners && server.listeners('request')[0];
    if (looksLikeApp(handler)) captured = captured || handler;
  } catch { /* ignore */ }
}

// Neuter both listen paths so importing the entry never binds a port or hangs.
// We do NOT invoke the listen callback — routes are all registered during app
// setup, before listen, so there's nothing to gain and the callback often has
// side effects (DB pings, intervals) we want to avoid.
http.Server.prototype.listen = function () {
  capture(this);
  return this;
};
net.Server.prototype.listen = http.Server.prototype.listen;

// The app freely writes to stdout (startup banners etc.). Keep OUR result
// unambiguous by emitting it behind a unique marker the caller greps for —
// anything the app prints is just ignored noise.
const MARKER = '__DD_ROUTES__';

// Some apps call app.listen() (express) which creates the server lazily; the
// createServer call registers the app as the 'request' handler, then our stub
// captures it. Others build `http.createServer(app)` explicitly — also covered.

const TIMEOUT_MS = 10_000;
const killer = setTimeout(() => finish(), TIMEOUT_MS);
killer.unref?.();

function finish() {
  clearTimeout(killer);
  try {
    if (captured) {
      const endpoints = listEndpoints(captured);
      process.stdout.write('\n' + MARKER + JSON.stringify(endpoints) + '\n');
      process.exit(0);
    }
  } catch { /* fall through */ }
  process.exit(1); // nothing captured → caller fails open
}

try {
  await import(pathToFileURL(entry).href);
  // Give a macrotask for any deferred listen() inside a resolved promise chain.
  setTimeout(finish, 50);
} catch {
  // Import threw (missing env, eager DB connect, etc.) — but the app may have
  // been captured before the throw. Try anyway, else fail open.
  finish();
}
