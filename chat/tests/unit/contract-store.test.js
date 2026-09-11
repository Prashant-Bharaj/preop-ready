// contract-store.test.js — merge semantics for the contract envelope store.
//
// The store is the single merge path for iterate contract diffs. These tests
// pin the upsert keys (endpoints by method+path, components by name, tables/
// columns by name, triggers by event, rules/side_effects by identity) and
// the regression the store exists to prevent: a diff-added UI view must
// survive into the merged contract so later rewrites cannot drop it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  mergeContractDiffs,
  mergeAndPersistIterateDiffs,
  nextRevisions,
} from '../../server/agent/coordinator/contract-store.js';

const baseContract = () => ({
  dataModel: {
    tables: [
      { name: 'users', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }, { name: 'role', type: 'VARCHAR(50)' }] },
    ],
  },
  apiContract: {
    version: 1,
    endpoints: [
      { method: 'GET', path: '/whoami', response: { status: 200 } },
      { method: 'GET', path: '/deviations', response: { status: 200 } },
    ],
  },
  vectorEngine: null,
  uiContract: {
    primary_view: 'list of deviations',
    secondary_views: ['dashboard'],
    components: [{ name: 'DeviationList', role: 'list' }, { name: 'NavBar', role: 'nav' }],
  },
  businessLogicContract: {
    triggers: [{ event: 'deviation_created', action: 'call MGA' }],
    rules: ['operators see own deviations only'],
    side_effects: ['audit log on create'],
  },
});

test('no diffs → contract unchanged, no changes reported', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), null);
  assert.equal(changes.length, 0);
  assert.equal(merged.apiContract.endpoints.length, 2);
});

test('endpoints upsert by method+path: adds new, replaces same-key', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    api_contract: {
      endpoints: [
        { method: 'GET', path: '/whoami', response: { status: 200, body: 'extended' } },
        { method: 'POST', path: '/prompt-templates', request: {} },
      ],
    },
  });
  assert.equal(merged.apiContract.endpoints.length, 3);
  const whoami = merged.apiContract.endpoints.find((e) => e.path === '/whoami');
  assert.equal(whoami.response.body, 'extended');
  assert.ok(changes.some((c) => c.startsWith('api_contract')));
});

test('ui components upsert by name — a diff-added view survives the merge', () => {
  const { merged } = mergeContractDiffs(baseContract(), {
    ui_contract: {
      components: [{ name: 'PromptTemplateManager', role: 'admin CRUD for prompt templates' }],
      secondary_views: ['prompt template management for QA leads', 'dashboard'],
    },
  });
  const names = merged.uiContract.components.map((c) => c.name);
  assert.deepEqual(names, ['DeviationList', 'NavBar', 'PromptTemplateManager']);
  // secondary_views union: 'dashboard' not duplicated
  assert.deepEqual(merged.uiContract.secondary_views,
    ['dashboard', 'prompt template management for QA leads']);
  // untouched keys preserved
  assert.equal(merged.uiContract.primary_view, 'list of deviations');
});

test('existing component merges fields instead of losing them', () => {
  const { merged } = mergeContractDiffs(baseContract(), {
    ui_contract: { components: [{ name: 'NavBar', badge: 'role-pill' }] },
  });
  const nav = merged.uiContract.components.find((c) => c.name === 'NavBar');
  assert.equal(nav.role, 'nav');
  assert.equal(nav.badge, 'role-pill');
});

test('tables upsert by name, columns upsert within existing table', () => {
  const { merged } = mergeContractDiffs(baseContract(), {
    data_model: {
      tables: [
        { name: 'users', columns: [{ name: 'role', type: 'VARCHAR(100)' }, { name: 'email', type: 'TEXT' }] },
        { name: 'prompt_templates', columns: [{ name: 'template_key', type: 'VARCHAR(100)' }] },
      ],
    },
  });
  assert.equal(merged.dataModel.tables.length, 2);
  const users = merged.dataModel.tables.find((t) => t.name === 'users');
  assert.equal(users.columns.length, 3);
  assert.equal(users.columns.find((c) => c.name === 'role').type, 'VARCHAR(100)');
  assert.equal(users.columns.find((c) => c.name === 'id').type, 'SERIAL PRIMARY KEY');
});

test('business logic: triggers by event, rules/side_effects union', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    business_logic_contract: {
      triggers: [{ event: 'deviation_created', action: 'call MGA with severity context' }],
      rules: ['operators see own deviations only', 'qa_lead can edit templates'],
      side_effects: ['audit log on template change'],
    },
  });
  const bl = merged.businessLogicContract;
  assert.equal(bl.triggers.length, 1);
  assert.equal(bl.triggers[0].action, 'call MGA with severity context');
  assert.deepEqual(bl.rules, ['operators see own deviations only', 'qa_lead can edit templates']);
  assert.equal(bl.side_effects.length, 2);
  assert.ok(changes.some((c) => c.startsWith('business_logic_contract')));
});

test('camelCase diff keys accepted', () => {
  const { merged } = mergeContractDiffs(baseContract(), {
    apiContract: { endpoints: [{ method: 'DELETE', path: '/deviations/:id' }] },
    uiContract: { components: [{ name: 'DeleteButton', role: 'delete' }] },
  });
  assert.equal(merged.apiContract.endpoints.length, 3);
  assert.equal(merged.uiContract.components.length, 3);
});

test('inputs are not mutated', () => {
  const contract = baseContract();
  const snapshot = JSON.stringify(contract);
  mergeContractDiffs(contract, {
    api_contract: { endpoints: [{ method: 'POST', path: '/x' }] },
    ui_contract: { components: [{ name: 'X', role: 'x' }] },
    data_model: { tables: [{ name: 'users', columns: [{ name: 'id', type: 'BIGINT' }] }] },
  });
  assert.equal(JSON.stringify(contract), snapshot);
});

test('nextRevisions appends and caps; passthrough without a revision', () => {
  assert.deepEqual(nextRevisions(null, null), []);
  const prior = [{ ts: 1, summary: 'a', kinds: ['all'] }];
  assert.equal(nextRevisions(prior, null), prior);
  const appended = nextRevisions(prior, { ts: 2, summary: 'b', kinds: ['ui_contract'] });
  assert.equal(appended.length, 2);
  const many = Array.from({ length: 60 }, (_, i) => ({ ts: i, summary: `r${i}`, kinds: [] }));
  assert.equal(nextRevisions(many, { ts: 99, summary: 'z', kinds: [] }).length, 50);
});

test('mergeAndPersistIterateDiffs updates envelope, preserves other keys, appends revision', () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'contract-store-'));
  mkdirSync(path.join(ws, '.harness'), { recursive: true });
  writeFileSync(path.join(ws, '.harness', 'contracts.json'), JSON.stringify({
    version: 1,
    data: {
      ...baseContract(),
      fileStructure: { backend: ['src/index.ts'] },
      tasksByScope: { backend: { scope: 'backend' } },
      revisions: [{ ts: 1, summary: 'contract finalized', kinds: ['all'] }],
    },
  }));

  const { changes } = mergeAndPersistIterateDiffs(ws, {
    ui_contract: { components: [{ name: 'PromptTemplateManager', role: 'admin CRUD' }] },
  }, { summary: 'add prompt templates page' });
  assert.equal(changes.length, 1);

  const envelope = JSON.parse(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8'));
  const names = envelope.data.uiContract.components.map((c) => c.name);
  assert.ok(names.includes('PromptTemplateManager'));
  // non-contract envelope keys preserved
  assert.deepEqual(envelope.data.fileStructure, { backend: ['src/index.ts'] });
  assert.ok(envelope.data.tasksByScope.backend);
  // revision appended
  assert.equal(envelope.data.revisions.length, 2);
  assert.equal(envelope.data.revisions[1].summary, 'add prompt templates page');
});

test('mergeAndPersistIterateDiffs is a no-op without an envelope or without changes', () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'contract-store-empty-'));
  const r1 = mergeAndPersistIterateDiffs(ws, { ui_contract: { components: [{ name: 'X' }] } });
  assert.equal(r1.merged, null);

  mkdirSync(path.join(ws, '.harness'), { recursive: true });
  writeFileSync(path.join(ws, '.harness', 'contracts.json'),
    JSON.stringify({ version: 1, data: baseContract() }));
  const before = readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8');
  const r2 = mergeAndPersistIterateDiffs(ws, null);
  assert.equal(r2.changes.length, 0);
  assert.equal(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8'), before);
});

// ── Scope-keyed (contract-agent ITERATE) dialect ─────────────────────────
// The concierge iterate path emits {backend: {add_endpoints}, frontend:
// {add_components}, database: {change_tables}} per contract-agent.md § 11.
// Before normalizeContractDiffs NOTHING consumed this shape — diffs were
// decorative and the envelope stayed stale (root cause of every
// lost-feature incident). These tests pin the dialect conversion.

import { normalizeContractDiffs } from '../../server/agent/coordinator/contract-store.js';

test('normalize: scope-keyed verb diffs fold into kind-keyed', () => {
  const norm = normalizeContractDiffs({
    backend: {
      add_endpoints: [{ method: 'GET', path: '/prompt-template' }, { method: 'PUT', path: '/prompt-template' }],
      rules: ['only quality_team can edit the prompt'],
    },
    frontend: { add_components: [{ name: 'PromptTemplateEditor', role: 'edit the Q&A prompt' }] },
    database: { change_tables: [{ name: 'prompt_templates', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }] }] },
  });
  assert.equal(norm.api_contract.endpoints.length, 2);
  assert.equal(norm.ui_contract.components[0].name, 'PromptTemplateEditor');
  assert.equal(norm.data_model.tables[0].name, 'prompt_templates');
  assert.deepEqual(norm.business_logic_contract.rules, ['only quality_team can edit the prompt']);
});

test('normalize: kind-keyed input passes through unchanged', () => {
  const kindKeyed = { api_contract: { endpoints: [{ method: 'GET', path: '/x' }] } };
  assert.deepEqual(normalizeContractDiffs(kindKeyed), kindKeyed);
});

test('normalize: endpoints from multiple scopes concatenate', () => {
  const norm = normalizeContractDiffs({
    backend: { add_endpoints: [{ method: 'GET', path: '/a' }] },
    integration: { add_endpoints: [{ method: 'GET', path: '/b' }] },
  });
  assert.equal(norm.api_contract.endpoints.length, 2);
});

test('mergeContractDiffs accepts the scope-keyed dialect end-to-end', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    backend: { add_endpoints: [{ method: 'GET', path: '/prompt-template' }] },
    frontend: { add_components: [{ name: 'PromptTemplateEditor', role: 'editor' }] },
  });
  assert.equal(merged.apiContract.endpoints.length, 3);
  assert.ok(merged.uiContract.components.some((c) => c.name === 'PromptTemplateEditor'));
  assert.equal(changes.length, 2);
});

// ── Contract adoption (reconciler-legitimate extras → envelope) ──────────

import { adoptLegitimateExtras } from '../../server/agent/coordinator/contract-store.js';

function tmpWorkspaceWithEnvelope(data) {
  const ws = mkdtempSync(path.join(tmpdir(), 'contract-adopt-'));
  mkdirSync(path.join(ws, '.harness'), { recursive: true });
  writeFileSync(path.join(ws, '.harness', 'contracts.json'), JSON.stringify({ version: 1, data }));
  return ws;
}

test('adoption: legitimate backend-extra-routes land in the envelope with a revision', () => {
  const ws = tmpWorkspaceWithEnvelope(baseContract());
  const { adopted } = adoptLegitimateExtras(ws, [
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'get', path: '/export/csv' },
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'POST', path: '/audit-log' },
  ]);
  assert.equal(adopted, 2);
  const env = JSON.parse(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8')).data;
  const eps = env.apiContract.endpoints;
  assert.ok(eps.some((e) => e.method === 'GET' && e.path === '/export/csv' && e.adopted === true));
  assert.ok(eps.some((e) => e.method === 'POST' && e.path === '/audit-log'));
  assert.equal(env.revisions.at(-1).summary.startsWith('adoption:'), true);
});

test('adoption: never clobbers an existing richer endpoint entry', () => {
  const ws = tmpWorkspaceWithEnvelope(baseContract());
  const before = JSON.parse(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8'))
    .data.apiContract.endpoints.find((e) => e.path === '/whoami');
  const { adopted } = adoptLegitimateExtras(ws, [
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'GET', path: '/whoami' },
  ]);
  assert.equal(adopted, 0);
  const after = JSON.parse(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8'))
    .data.apiContract.endpoints.find((e) => e.path === '/whoami');
  assert.deepEqual(after, before);
});

test('adoption: ignores noise/mismatch verdicts and coverage-gap kinds', () => {
  const ws = tmpWorkspaceWithEnvelope(baseContract());
  const { adopted } = adoptLegitimateExtras(ws, [
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'noise', method: 'GET', path: '/junk' },
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'mismatch:GET /whoami', method: 'GET', path: '/who-am-i' },
    { kind: 'coverage-gap-ui-component', scope: 'frontend', judgment: 'legitimate', component: 'MissingThing' },
    { kind: 'coverage-gap-backend', scope: 'backend', judgment: 'legitimate', method: 'GET', path: '/contract-only' },
  ]);
  assert.equal(adopted, 0);
});

test('adoption: idempotent across repeated passes and no-envelope safe', () => {
  const ws = tmpWorkspaceWithEnvelope(baseContract());
  const extras = [{ kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'GET', path: '/export/csv' }];
  assert.equal(adoptLegitimateExtras(ws, extras).adopted, 1);
  assert.equal(adoptLegitimateExtras(ws, extras).adopted, 0);
  const bare = mkdtempSync(path.join(tmpdir(), 'contract-adopt-bare-'));
  assert.equal(adoptLegitimateExtras(bare, extras).adopted, 0);
});

// ── Explicit removal (remove_* verbs) ────────────────────────────────────
// Removal is explicit-only: it happens solely when a well-formed remove_*
// entry names an existing item by its exact merge key. These tests pin the
// safety invariant — a partial, confused, or absent diff never deletes
// anything — plus traceability (a `-N` arm in changes → revisions).

import { diffHasRemovals } from '../../server/agent/coordinator/contract-store.js';

test('removal: endpoint retired by method+path with a -1 change arm', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    api_contract: { remove_endpoints: [{ method: 'GET', path: '/deviations' }] },
  });
  assert.equal(merged.apiContract.endpoints.length, 1);
  assert.ok(!merged.apiContract.endpoints.some((e) => e.path === '/deviations'));
  assert.deepEqual(changes, ['api_contract(-1 endpoints)']);
});

test('removal: scope-keyed dialect, string form, and /api prefix normalize to the same key', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    backend: { remove_endpoints: ['get /api/deviations'] },
  });
  assert.ok(!merged.apiContract.endpoints.some((e) => e.path === '/deviations'));
  assert.deepEqual(changes, ['api_contract(-1 endpoints)']);
});

test('removal: add-only or unknown-verb diffs remove nothing', () => {
  const { merged: m1 } = mergeContractDiffs(baseContract(), {
    backend: { add_endpoints: [{ method: 'POST', path: '/deviations' }] },
  });
  assert.equal(m1.apiContract.endpoints.length, 3);
  const { merged: m2, changes: c2 } = mergeContractDiffs(baseContract(), {
    backend: { nuke_endpoints: [{ method: 'GET', path: '/deviations' }] },
  });
  assert.equal(m2.apiContract.endpoints.length, 2);
  assert.equal(c2.length, 0);
});

test('removal: an unmatched key is a no-op with no change reported', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    api_contract: { remove_endpoints: [{ method: 'DELETE', path: '/nope' }] },
  });
  assert.equal(merged.apiContract.endpoints.length, 2);
  assert.equal(changes.length, 0);
});

test('removal: a key both changed and removed in one diff keeps the item', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    api_contract: {
      endpoints: [{ method: 'GET', path: '/deviations', response: { status: 200, body: 'v2' } }],
      remove_endpoints: [{ method: 'GET', path: '/deviations' }],
    },
  });
  const ep = merged.apiContract.endpoints.find((e) => e.path === '/deviations');
  assert.equal(ep.response.body, 'v2');
  assert.deepEqual(changes, ['api_contract(+0/~1 endpoints)']);
});

test('removal: remove_tables is rejected — the table survives', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    database: { remove_tables: ['users'] },
  });
  assert.equal(merged.dataModel.tables.length, 1);
  assert.equal(changes.length, 0);
});

test('removal: components, views, triggers, and rules retire by their merge keys', () => {
  const { merged, changes } = mergeContractDiffs(baseContract(), {
    frontend: {
      remove_components: ['NavBar'],
      remove_views: ['dashboard'],
    },
    backend: {
      remove_triggers: ['deviation_created'],
      remove_rules: ['operators see own deviations only'],
    },
  });
  assert.deepEqual(merged.uiContract.components.map((c) => c.name), ['DeviationList']);
  assert.deepEqual(merged.uiContract.secondary_views, []);
  assert.equal(merged.businessLogicContract.triggers.length, 0);
  assert.deepEqual(merged.businessLogicContract.rules, []);
  assert.ok(changes.some((c) => c.includes('-1 components') && c.includes('-1 views')));
  assert.ok(changes.some((c) => c.includes('-1 triggers') && c.includes('-1 rules')));
});

test('removal: persisted removal lands in the envelope and its revision', () => {
  const ws = tmpWorkspaceWithEnvelope({ ...baseContract(), revisions: [{ ts: 1, summary: 'contract finalized', kinds: ['all'] }] });
  const { changes } = mergeAndPersistIterateDiffs(ws, {
    backend: { remove_endpoints: [{ method: 'GET', path: '/deviations' }] },
  }, { summary: 'remove deviations listing' });
  assert.deepEqual(changes, ['api_contract(-1 endpoints)']);
  const env = JSON.parse(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8')).data;
  assert.ok(!env.apiContract.endpoints.some((e) => e.path === '/deviations'));
  assert.equal(env.revisions.at(-1).summary, 'remove deviations listing');
  assert.deepEqual(env.revisions.at(-1).kinds, ['api_contract(-1 endpoints)']);
});

test('removal: inputs are not mutated', () => {
  const contract = baseContract();
  const snapshot = JSON.stringify(contract);
  mergeContractDiffs(contract, {
    api_contract: { remove_endpoints: [{ method: 'GET', path: '/deviations' }] },
    ui_contract: { remove_components: ['NavBar'] },
  });
  assert.equal(JSON.stringify(contract), snapshot);
});

test('removal: diffHasRemovals detects remove_* payloads in either dialect', () => {
  assert.equal(diffHasRemovals({ backend: { remove_endpoints: [{ method: 'GET', path: '/x' }] } }), true);
  assert.equal(diffHasRemovals({ api_contract: { remove_endpoints: [{ method: 'GET', path: '/x' }] } }), true);
  assert.equal(diffHasRemovals({ backend: { add_endpoints: [{ method: 'GET', path: '/x' }] } }), false);
  assert.equal(diffHasRemovals(null), false);
});

test('adoption: normalizes /api prefix and skips dynamic/wildcard paths', () => {
  const ws = tmpWorkspaceWithEnvelope(baseContract());
  const { adopted } = adoptLegitimateExtras(ws, [
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'POST', path: '/api/chat/stream' },
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'GET', path: '/files/*' },
    { kind: 'backend-extra-route', scope: 'backend', judgment: 'legitimate', method: 'GET', path: '/x/${dynamic}' },
  ]);
  assert.equal(adopted, 1);
  const env = JSON.parse(readFileSync(path.join(ws, '.harness', 'contracts.json'), 'utf-8')).data;
  const ep = env.apiContract.endpoints.find((e) => e.adopted);
  assert.equal(ep.path, '/chat/stream');
});
