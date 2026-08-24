// list-endpoints.js — walk a live Express app's router table into a flat list
// of { method, path }. This is the "real authority": by the time the app is
// loaded, every route IS registered on the router stack regardless of HOW it
// was declared (app.get, a mounted Router, or a helper like
// `mountCsvExport(app, '/p', fn)`), so it cannot miss helper-mounted routes the
// way static parsing (regex/AST) did.
//
// Pure + dependency-free so it can be unit-tested with synthetic stacks and
// imported by the dumper script that runs in the backend's own process.

// Recover a mounted sub-router's path prefix from its layer.regexp. Express
// stores the mount path as a regexp (e.g. /^\/api\/?(?=\/|$)/i); this is
// best-effort — when we can't decode it we return '' and rely on the loose
// matching in the comparator (never a false "missing route").
function mountPrefix(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  const s = layer.regexp.toString();
  // /^\/api\/?(?=\/|$)/i  →  /api      (single static segment, the common case)
  const m = s.match(/^\/\^\\\/((?:[\w\-.~%]|\\\/)*?)\\\/\?\(\?=/);
  if (!m) return '';
  return '/' + m[1].replace(/\\\//g, '/');
}

function pushRoute(out, prefix, route) {
  const paths = Array.isArray(route.path) ? route.path : [route.path];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const full = (prefix + p).replace(/\/{2,}/g, '/') || '/';
    const methods = route.methods || {};
    for (const m of Object.keys(methods)) {
      if (methods[m] && m !== '_all') out.push({ method: m.toUpperCase(), path: full });
    }
  }
}

function walk(stack, prefix, out, depth) {
  if (!Array.isArray(stack) || depth > 8) return;
  for (const layer of stack) {
    if (layer.route) {
      pushRoute(out, prefix, layer.route);
    } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), out, depth + 1);
    }
  }
}

/**
 * @param {object} app — an Express application (or Router) instance.
 * @returns {Array<{method:string, path:string}>}
 */
export function listEndpoints(app) {
  if (!app) return [];
  // Express 4 exposes app._router; Express 5 exposes app.router; a Router
  // instance exposes its own .stack.
  const stack =
    app._router?.stack || app.router?.stack || (Array.isArray(app.stack) ? app.stack : null);
  const out = [];
  walk(stack, '', out, 0);
  // De-dupe (a route can register the same method twice).
  const seen = new Set();
  return out.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
