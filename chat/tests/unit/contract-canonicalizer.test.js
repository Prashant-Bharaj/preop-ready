/**
 * Unit tests for write-time contract canonicalization.
 *
 * Module under test:
 *   chat/server/session/contract-canonicalizer.js
 *
 * Shapes mirror the live deviation-tracker contract from bench matrix pass 4
 * (scorecard 2026-07-15T11-59-44-119Z) — the run that motivated the module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeContracts } from '../../server/session/contract-canonicalizer.js';

const deviationEndpoint = () => ({
  method: 'POST',
  path: '/deviations',
  request: {
    plant_area_id: 'number required',
    equipment_id: 'number',
    root_cause_category_id: 'number',
    severity: 'string required',
    description: 'string required',
    photos: 'file[] optional',
  },
});

test('bare *_id fields become optional, bare non-id fields become required', () => {
  const { data, changes } = canonicalizeContracts({
    apiContract: { endpoints: [deviationEndpoint(), {
      method: 'POST', path: '/plant-areas', request: { name: 'string required', description: 'string' },
    }] },
  });
  const dev = data.apiContract.endpoints[0].request;
  assert.equal(dev.equipment_id, 'number optional');
  assert.equal(dev.root_cause_category_id, 'number optional');
  assert.equal(dev.plant_area_id, 'number required');
  assert.equal(dev.severity, 'string required');
  assert.equal(dev.photos, 'file[] optional');
  assert.equal(data.apiContract.endpoints[1].request.description, 'string required');
  assert.equal(changes.length, 3);
});

test('idempotent: canonical input passes through unchanged (same reference)', () => {
  const first = canonicalizeContracts({ apiContract: { endpoints: [deviationEndpoint()] } });
  const second = canonicalizeContracts(first.data);
  assert.equal(second.changes.length, 0);
  assert.equal(second.data, first.data);
});

test('snake_case dialect (api_contract) is canonicalized too', () => {
  const { data } = canonicalizeContracts({
    api_contract: { endpoints: [{ method: 'POST', path: '/items', request: { owner_id: 'number' } }] },
  });
  assert.equal(data.api_contract.endpoints[0].request.owner_id, 'number optional');
});

test('first-login trigger without roleClaim mention gains the clause', () => {
  const { data, changes } = canonicalizeContracts({
    businessLogicContract: { triggers: [
      { event: 'user_first_login', action: "Create users row from OIDC claims with default role 'operator'" },
      { event: 'deviation_created', action: 'Insert audit_log' },
    ] },
  });
  const action = data.businessLogicContract.triggers[0].action;
  assert.match(action, /roleClaim when present/);
  assert.match(action, /least-privileged/);
  assert.equal(data.businessLogicContract.triggers[1].action, 'Insert audit_log');
  assert.deepEqual(changes, ['trigger user_first_login: +roleClaim clause']);
});

test('first-login trigger already mentioning the role claim is untouched', () => {
  const input = { businessLogicContract: { triggers: [
    { event: 'user_first_login', action: 'create users row; role from roleClaim when present' },
  ] } };
  const { data, changes } = canonicalizeContracts(input);
  assert.equal(changes.length, 0);
  assert.equal(data, input);
});

test('non-object / missing kinds pass through without throwing', () => {
  assert.deepEqual(canonicalizeContracts(null).changes, []);
  assert.deepEqual(canonicalizeContracts({}).changes, []);
  assert.deepEqual(canonicalizeContracts({ apiContract: 'nonsense', businessLogicContract: 7 }).changes, []);
  const { changes } = canonicalizeContracts({ apiContract: { endpoints: [{ method: 'GET', path: '/x' }] } });
  assert.equal(changes.length, 0);
});

test('flat clause-string spec explodes to per-field map, meta-keys dropped', () => {
  const { data, changes } = canonicalizeContracts({
    apiContract: { endpoints: [{
      method: 'POST', path: '/deviations',
      request: {
        content_type: 'multipart/form-data required',
        fields: 'plant_area_id number required, equipment_id number optional, severity string required, description string required, photos file[] optional',
      },
    }] },
  });
  const req = data.apiContract.endpoints[0].request;
  assert.equal(req.content_type, undefined);
  assert.equal(req.fields, undefined);
  assert.equal(req.plant_area_id, 'number required');
  assert.equal(req.equipment_id, 'number optional');
  assert.equal(req.severity, 'string required');
  assert.equal(req.photos, 'file[] optional');
  assert.ok(changes.some((c) => c.includes('exploded to 5 fields')));
  // idempotent on the exploded output
  const again = canonicalizeContracts(data);
  assert.equal(again.changes.length, 0);
});

test('enum lists and prose with commas are NOT exploded', () => {
  const input = { apiContract: { endpoints: [{
    method: 'POST', path: '/items',
    request: { severity: "string required, one of 'low', 'high'" },
  }] } };
  const { data, changes } = canonicalizeContracts(input);
  assert.equal(changes.length, 0);
  assert.equal(data, input);
});

test('vector dims canonicalized to the platform dimension; embedding_model normalized', () => {
  const { data, changes } = canonicalizeContracts({
    dataModel: { tables: [{
      name: 'doc_chunks',
      columns: [
        { name: 'id', type: 'SERIAL PRIMARY KEY' },
        { name: 'embedding', type: 'HALFVEC(3072)' },
        { name: 'chunk_text', type: 'TEXT NOT NULL' },
      ],
    }] },
    businessLogicContract: { rag: { embedding_model: 'text-embedding-3-large', retrieval_top_k: 5 } },
  });
  const cols = data.dataModel.tables[0].columns;
  assert.equal(cols[1].type, 'VECTOR(1536)');
  assert.equal(cols[0].type, 'SERIAL PRIMARY KEY');
  assert.equal(data.businessLogicContract.rag.embedding_model, 'text-embedding-3-small');
  assert.equal(data.businessLogicContract.rag.retrieval_top_k, 5);
  assert.ok(changes.some((c) => /HALFVEC\(3072\) → VECTOR\(1536\)/.test(c)));
  // idempotent
  const again = canonicalizeContracts(data);
  assert.equal(again.changes.length, 0);
  assert.equal(again.data, data);
});

test('correct dims and model untouched (same reference)', () => {
  const input = {
    dataModel: { tables: [{ name: 't', columns: [{ name: 'embedding', type: 'VECTOR(1536)' }] }] },
    mgaAssistants: [{ key: 'default', embedding_model: 'text-embedding-3-small' }],
  };
  const { data, changes } = canonicalizeContracts(input);
  assert.equal(changes.length, 0);
  assert.equal(data, input);
});

test('object-dialect field specs are left alone', () => {
  const input = { apiContract: { endpoints: [{
    method: 'POST', path: '/items', request: { owner_id: { type: 'number', optional: true } },
  }] } };
  const { data, changes } = canonicalizeContracts(input);
  assert.equal(changes.length, 0);
  assert.equal(data, input);
});
// ── allowed_roles backfill (authz-gate reliability) ─────────────────────────

test('backfill: restrictive "only role=X can METHODS /path" rules stamp allowed_roles per route', () => {
  const { data, changes } = canonicalizeContracts({
    apiContract: { endpoints: [
      { method: 'POST', path: '/sops' }, { method: 'PUT', path: '/sops/:id' }, { method: 'DELETE', path: '/sops/:id' },
      { method: 'POST', path: '/questions' }, { method: 'GET', path: '/audit-logs' },
    ] },
    businessLogicContract: { rules: [
      "Only users with role='quality_team' can POST/PUT/DELETE /sops endpoints",
      'All authenticated users can POST /questions',
      "Only users with role='quality_team' can access /audit-logs endpoint",
    ] },
  });
  const byKey = Object.fromEntries(data.apiContract.endpoints.map((e) => [`${e.method} ${e.path}`, e.allowed_roles]));
  assert.deepEqual(byKey['POST /sops'], ['quality_team']);   // incl the multipart upload route
  assert.deepEqual(byKey['DELETE /sops/:id'], ['quality_team']);
  assert.deepEqual(byKey['GET /audit-logs'], ['quality_team']);
  assert.equal(byKey['POST /questions'], undefined);         // open endpoint — not stamped
  assert.ok(changes.some((c) => /POST \/sops: \+allowed_roles \[quality_team\]/.test(c)));
});

test('backfill: an explicit allowed_roles is left untouched (agent-emitted wins)', () => {
  const input = { apiContract: { endpoints: [
    { method: 'POST', path: '/sops', allowed_roles: ['quality_team', 'admin'] },
  ] }, businessLogicContract: { rules: ["Only users with role='quality_team' can POST /sops"] } };
  const { data, changes } = canonicalizeContracts(input);
  assert.deepEqual(data.apiContract.endpoints[0].allowed_roles, ['quality_team', 'admin']);
  assert.ok(!changes.some((c) => c.includes('allowed_roles')));
});

test('backfill: no role= rules / no rules → nothing stamped (idempotent, no false gates)', () => {
  const noRules = canonicalizeContracts({ apiContract: { endpoints: [{ method: 'POST', path: '/sops' }] }, businessLogicContract: { rules: [] } });
  assert.equal(noRules.data.apiContract.endpoints[0].allowed_roles, undefined);
  // A rule with no role='X' and no vocab match stamps nothing (canonicalizer can't guess the role).
  const vague = canonicalizeContracts({ apiContract: { endpoints: [{ method: 'POST', path: '/sops' }] }, businessLogicContract: { rules: ['Only supervisors can POST /sops'] } });
  assert.equal(vague.data.apiContract.endpoints[0].allowed_roles, undefined);
});
