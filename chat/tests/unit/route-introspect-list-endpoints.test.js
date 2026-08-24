/**
 * list-endpoints — walk an Express router stack into { method, path }.
 *
 * The walker is the part that turns the live router table into the flat list
 * the comparator matches against. We test it with synthetic stacks shaped like
 * Express's internal layers, so no real express install is needed. The full
 * load-and-capture path is exercised end-to-end by the smoke run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEndpoints } from '../../server/reconciler/route-introspect/list-endpoints.js';

const routeLayer = (path, methods) => ({ route: { path, methods } });
const fakeApp = (stack) => ({ _router: { stack } });

test('flattens direct route layers (incl. multi-method)', () => {
  const app = fakeApp([
    routeLayer('/health', { get: true }),
    routeLayer('/items', { get: true, post: true }),
  ]);
  const eps = listEndpoints(app);
  assert.deepEqual(eps.sort((a, b) => (a.method + a.path).localeCompare(b.method + b.path)), [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/items' },
    { method: 'POST', path: '/items' },
  ]);
});

test('a helper-mounted route is just a normal route layer at runtime (the ex-mediumhard case)', () => {
  // mountCsvExport(app, '/admin/export/qa-logs', fn) calls app.get internally,
  // so by runtime it IS a plain route layer — invisible to regex, visible here.
  const app = fakeApp([routeLayer('/admin/export/qa-logs', { get: true })]);
  assert.deepEqual(listEndpoints(app), [{ method: 'GET', path: '/admin/export/qa-logs' }]);
});

test('recurses into a mounted sub-router and prefixes its path', () => {
  const app = fakeApp([
    routeLayer('/health', { get: true }),
    {
      name: 'router',
      regexp: /^\/api\/?(?=\/|$)/i,
      handle: { stack: [routeLayer('/users', { get: true }), routeLayer('/users/:id', { delete: true })] },
    },
  ]);
  const paths = listEndpoints(app).map((e) => `${e.method} ${e.path}`).sort();
  assert.deepEqual(paths, ['DELETE /api/users/:id', 'GET /api/users', 'GET /health']);
});

test('Express 5 app.router stack is also read', () => {
  const app = { router: { stack: [routeLayer('/ping', { get: true })] } };
  assert.deepEqual(listEndpoints(app), [{ method: 'GET', path: '/ping' }]);
});

test('de-dupes repeated method+path and skips the _all sentinel', () => {
  const app = fakeApp([
    routeLayer('/x', { get: true, _all: true }),
    routeLayer('/x', { get: true }),
  ]);
  assert.deepEqual(listEndpoints(app), [{ method: 'GET', path: '/x' }]);
});

test('no router / null app → [] (never throws)', () => {
  assert.deepEqual(listEndpoints(null), []);
  assert.deepEqual(listEndpoints({}), []);
});
