/**
 * Unit tests for the local-dev persona machinery (synthetic OIDC design —
 * reference/user-identity.md).
 *
 * Modules under test:
 *   chat/server/agent/coordinator/api-client-generator.js (devPersonaHeaders)
 *   chat/server/agent/coordinator/dev-role-switcher-generator.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateApiClient } from '../../server/agent/coordinator/api-client-generator.js';
import { generateDevRoleSwitcher } from '../../server/agent/coordinator/dev-role-switcher-generator.js';

const CONTRACT = { endpoints: [{ method: 'GET', path: '/whoami' }] };

test('api-client emits devPersonaHeaders with synthetic x-amzn-oidc-data', () => {
  const out = generateApiClient(CONTRACT);
  assert.match(out.source, /export function devPersonaHeaders\(\)/);
  assert.match(out.source, /'x-amzn-oidc-data'/);
  assert.match(out.source, /localStorage\.getItem\('dev-role'\)/);
  assert.match(out.source, /dev: true/);
  // The emitted base64url regexes must keep their escapes (template-literal
  // escaping regression: /\+/g once degraded to the invalid /+/g).
  assert.ok(out.source.includes("replace(/\\+/g, '-')"), 'plus-sign regex escaped');
  assert.ok(out.source.includes("replace(/\\//g, '_')"), 'slash regex escaped');
  // Every wrapped call carries the persona headers.
  assert.match(out.source, /\.\.\.devPersonaHeaders\(\)/);
});

test('emitted synthetic token decodes to the persona payload', () => {
  const out = generateApiClient(CONTRACT);
  // Extract the emitted function body and run it with a stubbed localStorage.
  const start = out.source.indexOf('export function devPersonaHeaders');
  const end = out.source.indexOf('\n}', start) + 2;
  const body = out.source.slice(start, end)
    .replace('export function', 'function')
    .replace(': Record<string, string>', '')
    .replace('(o: object)', '(o)');
  const fn = new Function('localStorage', 'btoa', `${body}; return devPersonaHeaders();`);
  const headers = fn(
    { getItem: (k) => (k === 'dev-role' ? 'qa_lead' : null) },
    (s) => Buffer.from(s, 'binary').toString('base64'),
  );
  const token = headers['x-amzn-oidc-data'];
  assert.ok(token, 'token emitted');
  const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(payload.role, 'qa_lead');
  assert.equal(payload.dev, true);
  assert.equal(payload.email, 'dev+qa_lead@localhost');
});

test('switcher component: renders from whoami, mounts via api-client headers', () => {
  const out = generateDevRoleSwitcher(CONTRACT);
  assert.match(out.source, /import { devPersonaHeaders } from '\.\/api-client\.js'/);
  assert.match(out.source, /export default function DevRoleSwitcher/);
  assert.match(out.source, /whoami\?\.devMode/);
  assert.match(out.source, /roles\.length < 2/);
  assert.match(out.source, /localStorage\.setItem\('dev-roles'/);
  assert.match(out.source, /localStorage\.setItem\('dev-role'/);
  assert.match(out.source, /window\.location\.reload\(\)/);
});

test('switcher not emitted without endpoints', () => {
  assert.equal(generateDevRoleSwitcher(null), null);
  assert.equal(generateDevRoleSwitcher({ endpoints: [] }), null);
});
