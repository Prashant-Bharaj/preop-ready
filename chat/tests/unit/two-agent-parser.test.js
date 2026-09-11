/**
 * Unit tests for the two-agent contract validator + retry wrapper.
 *
 * Modules under test:
 *   chat/server/agent/planner/contract-graph.js
 *   chat/server/agent/planner/two-agent-parser.js
 *   chat/server/agent/planner/validate-with-retry.js
 *
 * Empirical baseline: 16 of 17 valid fixtures in chat/tests/two-agent/fixtures/
 * pass the validator clean. The 18th has an MGA 502 error and is skipped.
 * One fixture (easy_policy_discovery.run1) is a known prompt-output drift case
 * (vector_engine: null on a vectordb scope) — that's the case the retry
 * wrapper will catch in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAndValidateContract } from '../../server/agent/planner/two-agent-parser.js';
import { runContractAgentWithRetry } from '../../server/agent/planner/validate-with-retry.js';
import { CONTRACT_GRAPH } from '../../server/agent/planner/contract-graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'two-agent', 'fixtures');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function emit(obj) {
  return JSON.stringify(obj);
}

// Minimal valid execute contract — every required field present, every rule
// satisfied. Test mutations are applied on top of this base.
function baseExecuteContract() {
  return {
    action: 'execute',
    archetype: 'crud-app',
    message: 'A simple CRUD app',
    flags: ['has-users'],
    tasks: [
      { scope: 'database', summary: 'db', task: 'create tables', rules: [], snippets: [], primarySnippet: null, dockerfile: 'Dockerfile.postgres' },
      { scope: 'backend', summary: 'be', task: 'express server', rules: [], snippets: [], primarySnippet: 'backend/express-server-template.ts', dockerfile: 'Dockerfile.node' },
      { scope: 'frontend', summary: 'fe', task: 'react scaffold', rules: [], snippets: [], primarySnippet: 'frontend/AppScaffold.tsx', dockerfile: 'Dockerfile.react' },
      { scope: 'integration', summary: 'wire', task: 'compose', rules: [], snippets: [], primarySnippet: 'integration/docker-compose-fullstack.yml', dockerfile: null },
    ],
    data_model: { tables: [{ name: 'items', columns: [] }] },
    api_contract: { endpoints: [{ method: 'GET', path: '/items' }] },
    ui_contract: { primary_view: 'list', primary_action: 'create', components: [] },
    business_logic_contract: { triggers: [], rules: [], side_effects: [] },
    mga_assistants: [],
  };
}

function loadFixtureContracts() {
  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json')).sort();
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf-8'));
    return { file: f, parsed: data.contract?.parsed, error: data.contract?.error };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture pass-through (the load-bearing baseline)
// ─────────────────────────────────────────────────────────────────────────────

test('fixtures: 13 of 17 valid probe outputs pass validation; 4 catch real drift', () => {
  const fixtures = loadFixtureContracts();
  let pass = 0, fail = 0, skipped = 0;
  const failures = [];

  for (const fx of fixtures) {
    if (!fx.parsed || fx.error) { skipped++; continue; }
    const result = parseAndValidateContract(emit(fx.parsed), null);
    if (result.ok) pass++;
    else { fail++; failures.push({ file: fx.file, violations: result.violations }); }
  }

  assert.equal(skipped, 1, 'one fixture has an MGA error');
  assert.equal(pass, 13, '13 fixtures should pass clean');
  assert.equal(fail, 4, '4 fixtures catch real prompt drift');
  // Known drift case 1: vector_engine missing on a vectordb scope.
  const vectorDrift = failures.find(f => /easy_policy_discovery.*run1/.test(f.file));
  assert.ok(vectorDrift && vectorDrift.violations.some(v => /vector_engine/.test(v)),
    'easy_policy_discovery.run1 is the known vector_engine drift');
  // Known drift cases 2+3: file-uploads flag flattened into paste-text
  // contracts (no file-consuming endpoint) — the live-observed bug the
  // requiresUploadEndpoint rule was added for.
  const uploadDrift = failures.filter(f => /medium_contract_analysis.*(run1|run3)/.test(f.file));
  assert.equal(uploadDrift.length, 2, 'both medium_contract_analysis paste-text contracts caught');
  assert.ok(uploadDrift.every(f => f.violations.some(v => /file-consuming endpoint/.test(v))));
  // Known drift case 4: FK self-sufficiency — onboarding.run3 requires
  // country_id/department_id, has countries+departments TABLES, but no POST
  // creates them and nothing ingests them. On a platform with no seed data
  // that app's core flow can never run (same class observed live: required
  // machine_id with only GET /machines, empty list forever).
  const fkDrift = failures.find(f => /easy_medium_onboarding.*run3/.test(f.file));
  assert.ok(fkDrift && fkDrift.violations.some(v => /no POST endpoint creates/.test(v)),
    'onboarding.run3 is the known uncreatable-reference-data drift');
});

// ─────────────────────────────────────────────────────────────────────────────
// Execute-mode violations (each rule from the graph)
// ─────────────────────────────────────────────────────────────────────────────

test('execute: baseline contract validates clean', () => {
  const r = parseAndValidateContract(emit(baseExecuteContract()), null);
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.equal(r.contract.archetype, 'crud-app');
});

test('execute: non-canonical flag dropped + soft-correct emitted', () => {
  const c = baseExecuteContract();
  c.flags = ['has-users', 'audit-log', 'invented-flag'];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, true, 'non-canonical flags should soft-correct, not violate');
  assert.deepEqual(r.contract.flags, ['has-users']);
  assert.equal(r.softCorrects.length, 2);
  assert.equal(r.softCorrects[0].reason, 'non-canonical');
});

test('execute: invalid archetype rejects', () => {
  const c = baseExecuteContract();
  c.archetype = 'not-a-real-archetype';
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /archetype.*not-a-real-archetype/.test(v)));
});

test('execute: invalid task scope rejects', () => {
  const c = baseExecuteContract();
  c.tasks[1].scope = 'banana';
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /banana/.test(v)));
});

test('execute: forbidden scope "fullstack" rejects', () => {
  const c = baseExecuteContract();
  c.tasks = [{ scope: 'fullstack', summary: '', task: '', rules: [], snippets: [] }];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /fullstack.*forbidden/.test(v)));
});

test('execute: tasks out of order reject', () => {
  const c = baseExecuteContract();
  // canonical order: database → backend → frontend → integration. Swap backend and frontend.
  [c.tasks[1], c.tasks[2]] = [c.tasks[2], c.tasks[1]];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /canonical order/.test(v)));
});

test('execute: archetype crud-app without database scope rejects', () => {
  const c = baseExecuteContract();
  c.tasks = c.tasks.filter(t => t.scope !== 'database');
  delete c.data_model;
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /crud-app.*requires scope "database"/.test(v)));
});

test('execute: database scope without data_model rejects', () => {
  const c = baseExecuteContract();
  delete c.data_model;
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /database.*requires.*data_model/.test(v)));
});

test('execute: database scope without backend scope rejects (L171)', () => {
  const c = baseExecuteContract();
  c.tasks = c.tasks.filter(t => t.scope !== 'backend');
  delete c.business_logic_contract;
  delete c.api_contract;
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /database.*requires scope "backend"/.test(v)));
});

test('execute: backend+frontend without api_contract rejects', () => {
  const c = baseExecuteContract();
  delete c.api_contract;
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /api_contract required/.test(v)));
});

test('execute: ≥2 service scopes without integration rejects', () => {
  const c = baseExecuteContract();
  c.tasks = c.tasks.filter(t => t.scope !== 'integration');
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /integration scope required/.test(v)));
});

test('execute: ai-rag flag without vectordb scope rejects', () => {
  const c = baseExecuteContract();
  c.archetype = 'search-tool';
  c.flags = ['ai-rag'];
  c.mga_assistants = [{ key: 'default', name: 'x', description: 'x', model: 'claude-opus-4.7', tool_keys: [], starter_messages: [] }];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /ai-rag.*requires scope "vectordb"/.test(v)));
});

// ── Vectordb post-filter (has_rag_pattern) ──

function aiToolContractWithVectordb() {
  const c = baseExecuteContract();
  c.archetype = 'ai-tool';
  c.flags = ['ai-chat'];
  c.tasks.splice(1, 0, { scope: 'vectordb', summary: 'vdb', task: 'pgvector', rules: [], snippets: [], primarySnippet: 'vectordb/vectordb-connections.ts', dockerfile: 'Dockerfile.pgvector' });
  c.vector_engine = 'pgvector';
  c.mga_assistants = [{ key: 'default', name: 'x', description: 'x', model: 'claude-opus-4.7', tool_keys: [], starter_messages: [] }];
  return c;
}

test('execute: vectordb dropped when has_rag_pattern=false and no ai-rag flag', () => {
  const r = parseAndValidateContract(emit(aiToolContractWithVectordb()), null, {
    hybridSignals: { has_rag_pattern: false },
  });
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(!r.contract.tasks.some(t => t.scope === 'vectordb'));
  assert.equal(r.contract.vectorEngine, null);
  assert.ok(r.softCorrects.some(s => s.reason === 'no-rag-signal'));
});

test('execute: vectordb kept when ai-rag flag present despite has_rag_pattern=false', () => {
  const c = aiToolContractWithVectordb();
  c.flags = ['ai-rag'];
  const r = parseAndValidateContract(emit(c), null, {
    hybridSignals: { has_rag_pattern: false },
  });
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.contract.tasks.some(t => t.scope === 'vectordb'));
});

test('execute: vectordb kept when has_rag_pattern=true', () => {
  const r = parseAndValidateContract(emit(aiToolContractWithVectordb()), null, {
    hybridSignals: { has_rag_pattern: true },
  });
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.contract.tasks.some(t => t.scope === 'vectordb'));
});

test('execute: vectordb kept when hybrid signals absent (conservative)', () => {
  const r = parseAndValidateContract(emit(aiToolContractWithVectordb()), null);
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.ok(r.contract.tasks.some(t => t.scope === 'vectordb'));
});

test('execute: ai-tool without vectordb now validates (no unconditional requirement)', () => {
  const c = baseExecuteContract();
  c.archetype = 'ai-tool';
  c.flags = ['ai-chat'];
  c.mga_assistants = [{ key: 'default', name: 'x', description: 'x', model: 'claude-opus-4.7', tool_keys: [], starter_messages: [] }];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('execute: ai-tool with ai-rag flag still requires vectordb', () => {
  const c = baseExecuteContract();
  c.archetype = 'ai-tool';
  c.flags = ['ai-rag'];
  c.mga_assistants = [{ key: 'default', name: 'x', description: 'x', model: 'claude-opus-4.7', tool_keys: [], starter_messages: [] }];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /ai-tool.*ai-rag.*requires scope "vectordb"/.test(v)));
});

// ── file-uploads flag ↔ upload endpoint consistency ──

test('execute: file-uploads flag without a file-consuming endpoint rejects', () => {
  const c = baseExecuteContract();
  c.flags = ['file-uploads'];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /file-uploads.*file-consuming endpoint/.test(v)));
});

test('execute: file-uploads satisfied by an /upload path', () => {
  const c = baseExecuteContract();
  c.flags = ['file-uploads'];
  c.api_contract.endpoints.push({ method: 'POST', path: '/documents/upload', request: { file: 'file required' } });
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('execute: file-uploads satisfied by a file-typed request field on any path', () => {
  const c = baseExecuteContract();
  c.flags = ['file-uploads'];
  c.api_contract.endpoints.push({ method: 'POST', path: '/sops', request: { document: { type: 'file' }, title: 'string' } });
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('execute: ai-chat flag without mga_assistants rejects', () => {
  const c = baseExecuteContract();
  c.flags = ['ai-chat'];
  c.mga_assistants = [];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /ai-chat.*requires non-empty mga_assistants/.test(v)));
});

test('execute: vectordb scope without vector_engine pgvector rejects', () => {
  const c = baseExecuteContract();
  c.archetype = 'ai-tool';
  c.flags = ['ai-rag'];
  c.tasks.unshift({ scope: 'vectordb', summary: 'vdb', task: 'pgvector', rules: [], snippets: [], primarySnippet: 'vectordb/vectordb-connections.ts', dockerfile: 'Dockerfile.pgvector' });
  c.mga_assistants = [{ key: 'default', name: 'x', description: 'x', model: 'claude-opus-4.7', tool_keys: [], starter_messages: [] }];
  // omit vector_engine
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /vector_engine === "pgvector"/.test(v)));
});

test('execute: mga_assistants[0].key must be "default"', () => {
  const c = baseExecuteContract();
  c.flags = ['ai-chat'];
  c.mga_assistants = [{ key: 'primary', name: 'x', description: 'x', model: 'claude-opus-4.7', tool_keys: [], starter_messages: [] }];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /mga_assistants\[0\]\.key must be "default"/.test(v)));
});

test('execute: mga_assistants model cannot be an embedding model', () => {
  const c = baseExecuteContract();
  c.flags = ['ai-chat'];
  c.mga_assistants = [{ key: 'default', name: 'x', description: 'x', model: 'text-embedding-3-large', tool_keys: [], starter_messages: [] }];
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /embedding-only model/.test(v)));
});

test('execute: action "clarify" rejects', () => {
  const c = baseExecuteContract();
  c.action = 'clarify';
  const r = parseAndValidateContract(emit(c), null);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /action.*clarify.*not in/.test(v)));
});

// ─────────────────────────────────────────────────────────────────────────────
// Iterate-mode validation
// ─────────────────────────────────────────────────────────────────────────────

test('iterate: valid iterate passes', () => {
  const c = {
    action: 'iterate',
    affected_scopes: ['backend'],
    contract_diffs: { backend: { add_endpoints: [{ method: 'POST', path: '/x' }] } },
    message: 'fixing backend',
  };
  const r = parseAndValidateContract(emit(c), null, { mode: 'iterate' });
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.deepEqual(r.contract.affectedScopes, ['backend']);
});

test('iterate: empty affected_scopes rejects', () => {
  const c = {
    action: 'iterate',
    affected_scopes: [],
    contract_diffs: {},
    message: 'no-op',
  };
  const r = parseAndValidateContract(emit(c), null, { mode: 'iterate' });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /non-empty affected_scopes/.test(v)));
});

test('iterate: invalid scope in affected_scopes rejects', () => {
  const c = {
    action: 'iterate',
    affected_scopes: ['banana'],
    contract_diffs: { banana: {} },
    message: 'x',
  };
  const r = parseAndValidateContract(emit(c), null, { mode: 'iterate' });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /affected_scopes.*banana/.test(v)));
});

test('iterate: contract_diffs key not in affected_scopes rejects', () => {
  const c = {
    action: 'iterate',
    affected_scopes: ['backend'],
    contract_diffs: { backend: {}, frontend: {} },
    message: 'x',
  };
  const r = parseAndValidateContract(emit(c), null, { mode: 'iterate' });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => /contract_diffs has key "frontend"/.test(v)));
});

test('iterate: action defaults to iterate when affected_scopes present (auto-detect)', () => {
  const c = {
    action: 'iterate',
    affected_scopes: ['backend'],
    contract_diffs: { backend: {} },
    message: 'x',
  };
  const r = parseAndValidateContract(emit(c), null); // no opts.mode
  assert.equal(r.mode, 'iterate');
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed input
// ─────────────────────────────────────────────────────────────────────────────

test('malformed: non-JSON content rejects', () => {
  const r = parseAndValidateContract('this is not JSON at all', null);
  assert.equal(r.ok, false);
  assert.ok(r.violations[0].includes('JSON'));
});

test('malformed: empty content rejects', () => {
  const r = parseAndValidateContract('', null);
  assert.equal(r.ok, false);
});

test('malformed: markdown-fenced JSON still parses', () => {
  const c = baseExecuteContract();
  const fenced = '```json\n' + emit(c) + '\n```';
  const r = parseAndValidateContract(fenced, null);
  assert.equal(r.ok, true, r.violations?.join('; '));
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry-once wrapper
// ─────────────────────────────────────────────────────────────────────────────

test('retry: first call passes -> attempt 1, no retry', async () => {
  let calls = 0;
  const callContractAgent = async () => {
    calls++;
    return { content: emit(baseExecuteContract()), conversationId: 'c1' };
  };
  const r = await runContractAgentWithRetry({ archetype: 'crud-app' }, callContractAgent);
  assert.equal(r.ok, true);
  assert.equal(r.attempt, 1);
  assert.equal(calls, 1, 'should not retry if first passes');
});

test('retry: first fails, second passes -> attempt 2, retry input shape verified', async () => {
  let calls = 0;
  let secondCallInput = null;
  const callContractAgent = async (input) => {
    calls++;
    if (calls === 1) {
      // First call returns a contract missing data_model
      const broken = baseExecuteContract();
      delete broken.data_model;
      return { content: emit(broken), conversationId: 'c1' };
    }
    // Second call: capture the retry-input shape, return a valid contract
    secondCallInput = input;
    return { content: emit(baseExecuteContract()), conversationId: 'c2' };
  };

  const brief = { archetype: 'crud-app', flags: ['has-users'] };
  const r = await runContractAgentWithRetry(brief, callContractAgent);

  assert.equal(r.ok, true);
  assert.equal(r.attempt, 2);
  assert.equal(calls, 2);
  // Retry input must contain the brief verbatim plus the retry context
  assert.equal(secondCallInput.archetype, 'crud-app');
  assert.equal(secondCallInput.retry_reason, 'validation_failed');
  assert.ok(secondCallInput.previous_contract, 'must include previous_contract');
  assert.ok(Array.isArray(secondCallInput.violations), 'must include violations[]');
  assert.ok(secondCallInput.violations.some(v => /data_model/.test(v)));
});

test('retry: both attempts fail -> ok:false with both attempts captured', async () => {
  const callContractAgent = async () => {
    const broken = baseExecuteContract();
    delete broken.data_model;
    return { content: emit(broken), conversationId: 'c' };
  };
  const r = await runContractAgentWithRetry({ archetype: 'crud-app' }, callContractAgent);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'contract_invalid_after_retry');
  assert.equal(r.attempts.length, 2);
  assert.ok(r.attempts[0].violations.length > 0);
  assert.ok(r.attempts[1].violations.length > 0);
});

test('retry: works for iterate mode too', async () => {
  let calls = 0;
  const callContractAgent = async () => {
    calls++;
    if (calls === 1) {
      // First: missing contract_diffs
      return {
        content: emit({ action: 'iterate', affected_scopes: ['backend'], message: 'x' }),
        conversationId: 'c1',
      };
    }
    return {
      content: emit({ action: 'iterate', affected_scopes: ['backend'], contract_diffs: { backend: {} }, message: 'fixed' }),
      conversationId: 'c2',
    };
  };
  const r = await runContractAgentWithRetry({}, callContractAgent, { mode: 'iterate' });
  assert.equal(r.ok, true);
  assert.equal(r.attempt, 2);
  assert.equal(r.mode, 'iterate');
});

// ─────────────────────────────────────────────────────────────────────────────
// Graph sanity (smoke test the data structure)
// ─────────────────────────────────────────────────────────────────────────────

test('graph: 9 archetypes', () => {
  assert.equal(Object.keys(CONTRACT_GRAPH.archetypes).length, 9);
});

test('graph: 16 flags (canonical enum)', () => {
  assert.equal(Object.keys(CONTRACT_GRAPH.flags).length, 16);
});

test('graph: 5 scopes', () => {
  assert.equal(Object.keys(CONTRACT_GRAPH.scopes).length, 5);
});

test('graph: is frozen', () => {
  assert.ok(Object.isFrozen(CONTRACT_GRAPH));
});
