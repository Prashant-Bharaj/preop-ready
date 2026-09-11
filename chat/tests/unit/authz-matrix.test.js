/**
 * authz-matrix — behavioral security fingerprint + posture diff.
 *
 * Shape mirrors the live incident: an iterate silently removed a role gate
 * (operator POST on an admin surface went 403 → 201) and no layer noticed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { buildAuthzMatrix, diffAuthzMatrix, formatAuthzDiff } from '../../server/reconciler/authz-matrix.js';

function roleOf(req) {
  try {
    const payload = String(req.headers['x-amzn-oidc-data'] || '').split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString()).role;
  } catch { return null; }
}

function startApp({ gateOpen = false } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const role = roleOf(req);
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/api/whoami') return send(200, { id: 1, role, devMode: true, availableRoles: ['operator', 'admin'] });
      if (req.url === '/api/items' && req.method === 'GET') return send(200, []);
      if (req.url === '/api/plant-areas' && req.method === 'POST') {
        if (role !== 'admin' && !gateOpen) return send(403, { error: 'Forbidden' });
        return send(201, { id: 7 });
      }
      send(404, { error: 'NotFound' });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const CONTRACT = { endpoints: [
  { method: 'GET', path: '/whoami' },
  { method: 'GET', path: '/items' },
  { method: 'POST', path: '/plant-areas', request: { name: 'string required' } },
] };

test('matrix: roles from whoami; gated endpoint denied for operator, reachable for admin', async () => {
  const { server, url } = await startApp();
  try {
    const m = await buildAuthzMatrix({ baseUrl: url, apiContract: CONTRACT });
    assert.deepEqual(m.roles, ['operator', 'admin']);
    assert.equal(m.entries['POST /plant-areas'].operator, 'denied');
    assert.equal(m.entries['POST /plant-areas'].admin, 'reachable');
    assert.equal(m.entries['GET /items'].operator, 'reachable');
    assert.equal(m.entries['GET /whoami'], undefined, 'whoami itself is not fingerprinted');
  } finally { server.close(); }
});

test('diff: gate removal surfaces as a privilege EXPANSION (the live incident)', async () => {
  const gated = await startApp({ gateOpen: false });
  const open = await startApp({ gateOpen: true });
  try {
    const before = await buildAuthzMatrix({ baseUrl: gated.url, apiContract: CONTRACT });
    const after = await buildAuthzMatrix({ baseUrl: open.url, apiContract: CONTRACT });
    const diff = diffAuthzMatrix(before, after);
    assert.deepEqual(diff.expansions, [{ endpoint: 'POST /plant-areas', role: 'operator' }]);
    assert.equal(diff.tightenings.length, 0);
    assert.match(formatAuthzDiff(diff), /PRIVILEGE EXPANSION.*plant-areas.*operator/);
    // Reverse direction = tightening, not expansion.
    const rev = diffAuthzMatrix(after, before);
    assert.deepEqual(rev.tightenings, [{ endpoint: 'POST /plant-areas', role: 'operator' }]);
    assert.equal(rev.expansions.length, 0);
  } finally { gated.server.close(); open.server.close(); }
});

test('diff: added/removed endpoints carry their posture; unchanged is empty', async () => {
  const { server, url } = await startApp();
  try {
    const m = await buildAuthzMatrix({ baseUrl: url, apiContract: CONTRACT });
    const same = diffAuthzMatrix(m, m);
    assert.equal(same.expansions.length + same.tightenings.length + same.added.length + same.removed.length, 0);
    assert.equal(formatAuthzDiff(same), '');

    const withExtra = await buildAuthzMatrix({
      baseUrl: url,
      apiContract: { endpoints: [...CONTRACT.endpoints, { method: 'DELETE', path: '/items/:id' }] },
    });
    const diff = diffAuthzMatrix(m, withExtra);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].endpoint, 'DELETE /items/:id');
    const rem = diffAuthzMatrix(withExtra, m);
    assert.deepEqual(rem.removed, [{ endpoint: 'DELETE /items/:id' }]);
  } finally { server.close(); }
});

test('route deletion → unserved, NOT a privilege expansion (the false-positive class)', async () => {
  const { server, url } = await startApp();
  try {
    const before = await buildAuthzMatrix({ baseUrl: url, apiContract: CONTRACT });
    // Same contract, but the app no longer serves /plant-areas: probing a
    // second server without the route simulates the removal iterate that
    // deleted /equipment wholesale (404 for every role).
    const bare = await new Promise((resolve) => {
      const s2 = http.createServer((req, res) => {
        const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/api/whoami') return send(200, { id: 1, role: roleOf(req), devMode: true, availableRoles: ['operator', 'admin'] });
        if (req.url === '/api/items' && req.method === 'GET') return send(200, []);
        send(404, { error: 'NotFound' });
      });
      s2.listen(0, '127.0.0.1', () => resolve({ server: s2, url: `http://127.0.0.1:${s2.address().port}` }));
    });
    try {
      const after = await buildAuthzMatrix({ baseUrl: bare.url, apiContract: CONTRACT });
      assert.equal(after.entries['POST /plant-areas'].operator, 'absent');
      const diff = diffAuthzMatrix(before, after);
      assert.equal(diff.expansions.length, 0, 'route deletion must not read as expansion');
      assert.deepEqual(diff.unserved, [{ endpoint: 'POST /plant-areas' }]);
      assert.match(formatAuthzDiff(diff), /no longer served.*plant-areas/);
      // Restoration direction: served again → surfaces via added(restored).
      const back = diffAuthzMatrix(after, before);
      assert.equal(back.expansions.length, 0);
      assert.ok(back.added.some((a) => a.endpoint === 'POST /plant-areas' && a.restored));
    } finally { bare.server.close(); }
  } finally { server.close(); }
});

test('no whoami in contract → null matrix (feature degrades silently)', async () => {
  const { server, url } = await startApp();
  try {
    const m = await buildAuthzMatrix({ baseUrl: url, apiContract: { endpoints: [{ method: 'GET', path: '/items' }] } });
    assert.equal(m, null);
  } finally { server.close(); }
});

// ── rules-derived expectation + baseline verification (the sop authz hole) ──

import { deriveExpectedRoles, verifyAuthzAgainstRules, formatAuthzViolations } from '../../server/reconciler/authz-matrix.js';

const SOP_CONTRACT = { endpoints: [
  { method: 'POST', path: '/sops' }, { method: 'PUT', path: '/sops/:id' }, { method: 'DELETE', path: '/sops/:id' },
  { method: 'POST', path: '/questions' }, { method: 'GET', path: '/questions' }, { method: 'GET', path: '/audit-logs' },
] };
const SOP_RULES = { rules: [
  "Only users with role='quality_team' can POST/PUT/DELETE /sops endpoints",
  'All authenticated users can POST /questions and GET their own question history',
  "Only users with role='quality_team' can access /audit-logs endpoint",
  'Technicians can only see their own questions in /questions list',
] };
const SOP_ROLES = ['technician', 'quality_team'];

test('derive: slash-joined methods (POST/PUT/DELETE /sops) still yield /sops as the path', () => {
  const exp = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: SOP_RULES, roles: SOP_ROLES });
  assert.deepEqual([...(exp.get('POST /sops') || [])], ['quality_team']);
  assert.deepEqual([...(exp.get('DELETE /sops/:id') || [])], ['quality_team']);
});

test('derive: "all authenticated users" opens to every role; ownership rules add nothing', () => {
  const exp = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: SOP_RULES, roles: SOP_ROLES });
  assert.deepEqual([...(exp.get('POST /questions') || [])].sort(), ['quality_team', 'technician']);
  assert.deepEqual([...(exp.get('GET /audit-logs') || [])], ['quality_team']);
});

test('verify: technician reachable on a quality_team-only endpoint → GATE MISSING (the live hole)', () => {
  const exp = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: SOP_RULES, roles: SOP_ROLES });
  const matrix = { roles: SOP_ROLES, entries: {
    'POST /sops': { technician: 'reachable', quality_team: 'reachable' },
    'PUT /sops/:id': { technician: 'denied', quality_team: 'reachable' },
    'POST /questions': { technician: 'reachable', quality_team: 'reachable' },
    'GET /audit-logs': { technician: 'denied', quality_team: 'reachable' },
  } };
  const v = verifyAuthzAgainstRules(matrix, exp);
  assert.deepEqual(v.violations, [{ endpoint: 'POST /sops', role: 'technician' }]);
  assert.match(formatAuthzViolations(v), /GATE MISSING.*technician.*POST \/sops/);
});

test('verify: correctly-gated app has zero violations (no false positive)', () => {
  const exp = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: SOP_RULES, roles: SOP_ROLES });
  const matrix = { roles: SOP_ROLES, entries: {
    'POST /sops': { technician: 'denied', quality_team: 'reachable' },
    'PUT /sops/:id': { technician: 'denied', quality_team: 'reachable' },
    'POST /questions': { technician: 'reachable', quality_team: 'reachable' },
    'GET /audit-logs': { technician: 'denied', quality_team: 'reachable' },
  } };
  const v = verifyAuthzAgainstRules(matrix, exp);
  assert.equal(v.violations.length, 0);
  assert.equal(formatAuthzViolations(v), '');
});

test('verify: an allowed role denied → over-restriction (lower severity, separate bucket)', () => {
  const exp = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: SOP_RULES, roles: SOP_ROLES });
  const matrix = { roles: SOP_ROLES, entries: {
    'POST /sops': { technician: 'denied', quality_team: 'denied' },
  } };
  const v = verifyAuthzAgainstRules(matrix, exp);
  assert.equal(v.violations.length, 0);
  assert.deepEqual(v.overRestrictions, [{ endpoint: 'POST /sops', role: 'quality_team' }]);
});

test('derive: no rules / vague rules → empty expectation → verifier is a no-op', () => {
  assert.equal(deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: { rules: [] }, roles: SOP_ROLES }).size, 0);
  const vague = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: { rules: ['Keep an audit trail', 'Validate all inputs'] }, roles: SOP_ROLES });
  assert.equal(vague.size, 0);
  assert.deepEqual(verifyAuthzAgainstRules({ roles: SOP_ROLES, entries: {} }, vague).violations, []);
});

test('verify: error/absent postures are never violations', () => {
  const exp = deriveExpectedRoles({ apiContract: SOP_CONTRACT, businessLogic: SOP_RULES, roles: SOP_ROLES });
  const matrix = { roles: SOP_ROLES, entries: { 'POST /sops': { technician: 'error', quality_team: 'absent' } } };
  assert.equal(verifyAuthzAgainstRules(matrix, exp).violations.length, 0);
});

// ── e2e: the repair-loop cycle (detect a gate hole → fix → re-probe clean) ──
// Proves the mechanics the live repair loop relies on: build the observed
// posture against a real app, verify it against the rules-derived/explicit
// expectation, and confirm a fix (here: the app re-served with the gate
// enforced) resolves the violation on re-probe. The live loop's dispatch is
// the same proven pattern as the probe/visual/compose-up repair loops; this
// pins the detect→resolve half deterministically.

function startSopApp({ gated }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const role = roleOf(req);
      const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/api/whoami') return send(200, { id: 1, role, devMode: true, availableRoles: ['technician', 'quality_team'] });
      if (req.url === '/api/questions' && req.method === 'POST') return send(201, { id: 1 });
      if (req.url === '/api/sops' && req.method === 'POST') {
        if (gated && role !== 'quality_team') return send(403, { error: 'Forbidden' });
        return send(201, { id: 1 }); // ungated when !gated — the hole
      }
      send(404, { error: 'NotFound' });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// POST /sops carries an explicit allowed_roles (as the canonicalizer stamps it).
const SOP_API = { endpoints: [
  { method: 'GET', path: '/whoami' },
  { method: 'POST', path: '/questions' },
  { method: 'POST', path: '/sops', request: { name: 'string required' }, allowed_roles: ['quality_team'] },
] };

test('e2e: technician reaching POST /sops is detected, and enforcing the gate resolves it on re-probe', async () => {
  const holed = await startSopApp({ gated: false });
  let violationsWhenHoled;
  try {
    const m1 = await buildAuthzMatrix({ baseUrl: holed.url, apiContract: SOP_API });
    assert.equal(m1.entries['POST /sops'].technician, 'reachable', 'the hole: technician can POST /sops');
    const exp = deriveExpectedRoles({ apiContract: SOP_API, businessLogic: { rules: [] }, roles: m1.roles });
    // explicit allowed_roles drives the expectation even with no prose rules
    assert.deepEqual([...exp.get('POST /sops')], ['quality_team']);
    const v1 = verifyAuthzAgainstRules(m1, exp);
    violationsWhenHoled = v1.violations;
    assert.deepEqual(v1.violations, [{ endpoint: 'POST /sops', role: 'technician' }]);
    assert.match(formatAuthzViolations(v1), /GATE MISSING.*technician.*POST \/sops/);
  } finally { holed.server.close(); }

  // The "repair": the app is re-served with the gate enforced (what the fix
  // agent + rebuild produce). Re-probe must now be clean.
  const fixed = await startSopApp({ gated: true });
  try {
    const m2 = await buildAuthzMatrix({ baseUrl: fixed.url, apiContract: SOP_API });
    assert.equal(m2.entries['POST /sops'].technician, 'denied', 'after fix: technician denied');
    const exp = deriveExpectedRoles({ apiContract: SOP_API, businessLogic: { rules: [] }, roles: m2.roles });
    const v2 = verifyAuthzAgainstRules(m2, exp);
    assert.equal(v2.violations.length, 0, 'gate hole resolved on re-probe');
    assert.equal(formatAuthzViolations(v2), '');
  } finally { fixed.server.close(); }

  assert.ok(violationsWhenHoled.length === 1); // the cycle detected then cleared exactly one violation
});

// ── ownership rules must NOT be read as role gates (the deviation false-positive) ──

test('derive: ownership rule ("operators can only view their own …") restricts nothing', () => {
  const api = { endpoints: [
    { method: 'POST', path: '/deviations' }, { method: 'GET', path: '/deviations/mine' },
    { method: 'GET', path: '/deviations/:id' }, { method: 'PUT', path: '/deviations/:id/status', allowed_roles: ['qa_lead', 'admin'] },
  ] };
  const rules = { rules: [
    'All authenticated users can create deviations',
    'Operators can only view their own deviations via /deviations/mine',
    'QA leads and admins can view all deviations via /deviations',
    'Only QA leads and admins can change deviation status',
  ] };
  const exp = deriveExpectedRoles({ apiContract: api, businessLogic: rules, roles: ['operator', 'qa_lead', 'admin'] });
  // The ownership rule must NOT restrict any /deviations endpoint...
  assert.equal(exp.has('POST /deviations'), false);
  assert.equal(exp.has('GET /deviations/mine'), false);
  assert.equal(exp.has('GET /deviations/:id'), false);
  // ...but the explicit stamp on the status endpoint stands.
  assert.deepEqual([...exp.get('PUT /deviations/:id/status')].sort(), ['admin', 'qa_lead']);

  // And with the real live posture (qa_lead/admin reachable on the ownership
  // endpoints, as they should be), there are ZERO violations.
  const matrix = { roles: ['operator', 'qa_lead', 'admin'], entries: {
    'POST /deviations': { operator: 'reachable', qa_lead: 'reachable', admin: 'reachable' },
    'GET /deviations/mine': { operator: 'reachable', qa_lead: 'reachable', admin: 'reachable' },
    'GET /deviations/:id': { operator: 'reachable', qa_lead: 'reachable', admin: 'reachable' },
    'PUT /deviations/:id/status': { operator: 'denied', qa_lead: 'reachable', admin: 'reachable' },
  } };
  assert.equal(verifyAuthzAgainstRules(matrix, exp).violations.length, 0);
});

test('canonicalizer: ownership rule does not stamp allowed_roles (via imported deriver parity)', () => {
  // Path-less "only <role> can <verb>" (no slash) also yields no gate.
  const exp = deriveExpectedRoles({
    apiContract: { endpoints: [{ method: 'PUT', path: '/x/:id/status' }] },
    businessLogic: { rules: ['Only QA leads can change status'] }, // no path token → unmappable
    roles: ['operator', 'qa_lead'],
  });
  assert.equal(exp.size, 0);
});
