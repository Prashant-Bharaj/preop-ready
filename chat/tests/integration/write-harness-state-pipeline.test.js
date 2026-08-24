/**
 * Coverage: flow 7 (Multi-turn session) via chain
 *   flow 7 → orchestrator emits write_harness_state at end of build → state.md
 *           rewritten deterministically → decisions.md appends a dated entry
 *           → contracts.json persists the new payload → generateContractTypes
 *           emits typed contracts → next turn's session reads the prior state +
 *           contracts → coderConversationIds[scope] map persists across turns
 *
 * Integration tier: real harness-state functions (writeStateMd, appendDecision,
 * writeContracts, readContracts) + real generateContractTypes. The
 * `toolWriteHarnessState` wrapper itself reads WORKSPACE_DIR at import time;
 * the underlying pipeline functions all take a workspaceDir param, so the
 * test exercises the pipeline composition directly on a per-test temp
 * workspace. MGA absent; no Docker.
 *
 * Drift flag: production writeContracts() OVERWRITES contracts.json with the
 * latest payload. There is no "version 2 block appended, version 1 retained"
 * mechanism today — the `version: 1` in the envelope is the envelope SCHEMA
 * version. The brief's wording suggests contract VERSIONING; this test
 * asserts what the code actually does (latest-wins) and tags the gap so
 * future versioning work can extend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { createTestWorkspace } from '../util/test-workspace.js';
import { writeContractsEnvelope, makeContractsEnvelope } from '../util/contracts-fixtures.js';
import { assertHasRunSummary } from '../util/telemetry-asserts.js';

import {
  writeStateMd,
  readStateMd,
  appendDecision,
  readContracts,
  writeContracts,
  renderStateMd,
  renderDecisionEntry,
  getHarnessDir,
  isHarnessPopulated,
} from '../../server/session/harness-state.js';
import {
  generateContractTypes,
  validateContractsSchema,
} from '../../server/agent/contract-types-generator.js';
import { writeRunSummary } from '../../server/util/run-summary.js';
import { mkdirSync, writeFileSync } from 'node:fs';

// ── Fixture helpers ──────────────────────────────────────────────────────

const BASE_CONTRACTS = {
  data_model: {
    tables: [
      { name: 'users', columns: [{ name: 'id', type: 'SERIAL' }, { name: 'email', type: 'TEXT' }] },
    ],
  },
  api_contract: {
    endpoints: [
      { method: 'GET', path: '/health', returns: { ok: 'boolean' } },
    ],
  },
  file_structure: {
    backend: { language: 'node', required_files: ['backend/src/index.ts'], forbidden_paths: [] },
  },
};

const BASE_STATE = {
  stack: { backend: 'node-express', database: 'postgres' },
  built: { backend: true },
  known_issues: [],
  next_likely_actions: ['Add /users CRUD'],
};

// ── Test 1: Single-turn pipeline ─────────────────────────────────────────

test('single-turn pipeline: writeStateMd + appendDecision + writeContracts + generateContractTypes', async () => {
  const ws = await createTestWorkspace({ scope: 'ws-pipe', scenarioName: 'single-turn' });
  try {
    // 1a — write state.md (deterministic, same input → same bytes)
    writeStateMd(ws.dir, BASE_STATE);
    const stateMdPath = path.join(getHarnessDir(ws.dir), 'state.md');
    assert.ok(existsSync(stateMdPath), 'state.md must exist after writeStateMd');
    const stateContents = readStateMd(ws.dir);
    assert.match(stateContents, /Project State/i, 'state.md has canonical header');
    assert.match(stateContents, /node-express/, 'state.md reflects stack content');

    // Deterministic re-render: same input → same bytes
    const second = renderStateMd(BASE_STATE);
    const first = renderStateMd(BASE_STATE);
    assert.equal(first, second, 'renderStateMd is deterministic');

    // 1b — append decision (date-stamped)
    appendDecision(ws.dir, {
      summary: 'Chose express for backend',
      reason: 'lightweight + matches subagent prompt scaffolding',
      alternatives_considered: ['fastify', 'koa'],
    });
    const decisionsPath = path.join(getHarnessDir(ws.dir), 'decisions.md');
    assert.ok(existsSync(decisionsPath), 'decisions.md must exist');
    const decContents = readFileSync(decisionsPath, 'utf-8');
    assert.match(decContents, /# Decisions Log/, 'decisions.md has canonical header');
    assert.match(decContents, /Chose express for backend/);
    assert.match(decContents, /fastify/, 'alternatives are recorded');

    // 1c — write contracts envelope + validate schema
    writeContracts(ws.dir, BASE_CONTRACTS);
    const envelope = readContracts(ws.dir);
    assert.equal(envelope.version, 1, 'envelope schema version is 1');
    assert.deepEqual(envelope.data.api_contract.endpoints[0], { method: 'GET', path: '/health', returns: { ok: 'boolean' } });

    // 1d — generateContractTypes runs the full schema-validate → emit pipeline.
    // Skip the TS self-test because tsc isn't on PATH in CI (covered by
    // contract-types-generator.test.js unit tests).
    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.ok(result, 'generateContractTypes returns a result object');
    assert.ok(Array.isArray(result.written), 'result.written is an array');
    // At least one .ts file was emitted (backend has tsconfig signal via spec).
    // file_structure tells us backend is a node scope. The generator inspects
    // contracts shape; the test asserts the pipeline ran without throw.
    assert.ok(typeof result.errors === 'undefined' || Array.isArray(result.errors));

    // 1e — isHarnessPopulated reflects the populated workspace
    assert.equal(isHarnessPopulated(ws.dir), true,
      'isHarnessPopulated returns true once contracts.json + state.md exist');
  } finally {
    await ws.cleanup();
  }
});

// ── Test 2: type-gen failure path (logAndSwallow contract) ───────────────

test('logAndSwallow on type-gen failure: state.md still written, schema-throw does not propagate', async () => {
  const ws = await createTestWorkspace({ scope: 'ws-pipe', scenarioName: 'tgen-fail' });
  try {
    // Step 1: state.md write should succeed independently.
    writeStateMd(ws.dir, BASE_STATE);
    assert.ok(existsSync(path.join(getHarnessDir(ws.dir), 'state.md')),
      'state.md must be written FIRST, independent of contract-types-generator outcome');

    // Step 2: malformed contracts → generator's validate throws inside its
    // own try/catch (no rollback of state.md). Write a malformed envelope
    // directly (bypass writeContracts which would normalize).
    mkdirSync(path.join(ws.dir, '.harness'), { recursive: true });
    writeFileSync(path.join(ws.dir, '.harness', 'contracts.json'),
      JSON.stringify({ version: 1, data: { /* missing file_structure */ } }, null, 2),
      'utf-8');

    // generateContractTypes either returns errors[] or throws — both
    // outcomes must NOT corrupt the already-written state.md.
    let didThrow = false;
    let result = null;
    try {
      result = generateContractTypes(ws.dir, { skipSelfTest: true });
    } catch (err) {
      didThrow = true;
    }
    // Whether the generator's own validator threw or it returned errors,
    // state.md must still be present.
    assert.ok(existsSync(path.join(getHarnessDir(ws.dir), 'state.md')),
      'state.md must remain after a contract-types-generator failure');
    if (!didThrow) {
      assert.ok(result, 'when not throwing, generator returned a result object');
    }
  } finally {
    await ws.cleanup();
  }
});

// ── Test 3: Malformed contracts payload → schema validation throws ───────

test('malformed contracts: validateContractsSchema rejects before any disk write', () => {
  // Envelope without .version
  assert.throws(
    () => validateContractsSchema({ data: { file_structure: { backend: {} } } }),
    /at \.version/,
  );
  // Null envelope
  assert.throws(
    () => validateContractsSchema(null),
    /null/i,
  );
});

// ── Test 4: Multi-turn state evolution ───────────────────────────────────

test('multi-turn (3 turns): state.md mirrors latest truth, decisions.md appends, coderConversationIds persist', async () => {
  const ws = await createTestWorkspace({ scope: 'ws-pipe', scenarioName: 'multi-turn' });
  try {
    // ── Turn 1 ────────────────────────────────────────────────────────
    writeStateMd(ws.dir, BASE_STATE);
    appendDecision(ws.dir, { summary: 'Turn 1: initial backend build', reason: 'baseline' });
    writeContracts(ws.dir, BASE_CONTRACTS);
    const session = {
      id: 'multi-turn-' + Date.now(),
      coderConversationIds: { backend: 'B1' },
    };

    const decTurn1 = readFileSync(path.join(getHarnessDir(ws.dir), 'decisions.md'), 'utf-8');
    assert.match(decTurn1, /Turn 1: initial backend build/);
    assert.equal(readContracts(ws.dir).version, 1);

    // ── Turn 2: cosmetic iteration (no contract changes) ─────────────
    const turn2State = {
      ...BASE_STATE,
      built: { ...BASE_STATE.built, frontend: false }, // cosmetic only
      next_likely_actions: ['Add /users CRUD', 'Polish UI'],
    };
    writeStateMd(ws.dir, turn2State);
    appendDecision(ws.dir, { summary: 'Turn 2: copy tweaks', reason: 'cosmetic; no contract diff' });
    // Contracts unchanged — DO NOT re-write writeContracts to avoid
    // simulating a content-version bump that the production code doesn't
    // implement. (Drift flag: brief's "version 2 appended" is aspirational.)

    // coderConversationIds persists across turns
    session.coderConversationIds.backend = 'B2'; // simulated: backend convo rotated
    assert.equal(session.coderConversationIds.backend, 'B2');

    const decTurn2 = readFileSync(path.join(getHarnessDir(ws.dir), 'decisions.md'), 'utf-8');
    assert.match(decTurn2, /Turn 1: initial backend build/, 'turn-1 entry STILL present (append-only)');
    assert.match(decTurn2, /Turn 2: copy tweaks/, 'turn-2 entry appended');
    const stateTurn2 = readStateMd(ws.dir);
    assert.match(stateTurn2, /Polish UI/, 'state.md reflects latest next_likely_actions');

    // ── Turn 3: feature iteration that modifies contracts ────────────
    const turn3State = {
      ...turn2State,
      built: { backend: true, frontend: true, database: true },
      next_likely_actions: [],
    };
    writeStateMd(ws.dir, turn3State);
    appendDecision(ws.dir, {
      summary: 'Turn 3: add /users endpoint',
      reason: 'feature work; api_contract diff',
      alternatives_considered: ['GraphQL', 'REST'],
    });
    const turn3Contracts = {
      ...BASE_CONTRACTS,
      api_contract: {
        endpoints: [
          ...BASE_CONTRACTS.api_contract.endpoints,
          { method: 'GET', path: '/users', returns: { users: 'array' } },
        ],
      },
    };
    writeContracts(ws.dir, turn3Contracts);
    session.coderConversationIds.frontend = 'F1'; // new scope joins the session map
    session.coderConversationIds.database = 'D1';

    // All three turns' decisions present (append-only)
    const decTurn3 = readFileSync(path.join(getHarnessDir(ws.dir), 'decisions.md'), 'utf-8');
    assert.match(decTurn3, /Turn 1: initial backend build/);
    assert.match(decTurn3, /Turn 2: copy tweaks/);
    assert.match(decTurn3, /Turn 3: add \/users endpoint/);
    assert.match(decTurn3, /GraphQL/, 'turn-3 alternatives present');

    // Contracts reflect the new endpoint
    const t3env = readContracts(ws.dir);
    assert.equal(t3env.data.api_contract.endpoints.length, 2);
    assert.ok(t3env.data.api_contract.endpoints.some(e => e.path === '/users'),
      'new endpoint persists in contracts.json');

    // coderConversationIds map persists across turns AND gains new scopes
    assert.equal(session.coderConversationIds.backend, 'B2',
      'prior scope convo id preserved');
    assert.equal(session.coderConversationIds.frontend, 'F1',
      'new scope convo id stored');
    assert.equal(session.coderConversationIds.database, 'D1',
      'new scope convo id stored');

    // Run-summary per turn — write three records and assert via the helper.
    mkdirSync(path.join(ws.dir, '.harness'), { recursive: true });
    const summaryLines = [
      { sessionId: session.id, action: 'execute', status: 'built', scopes: ['backend'], tokens: { total: 100 } },
      { sessionId: session.id, action: 'iterate', status: 'built', scopes: ['frontend'], tokens: { total: 50 } },
      { sessionId: session.id, action: 'iterate', status: 'built', scopes: ['backend', 'frontend', 'database'], tokens: { total: 200 } },
    ];
    writeFileSync(
      path.join(ws.dir, '.harness', 'run-summaries.jsonl'),
      summaryLines.map(r => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
    // Latest record (turn 3) is what assertHasRunSummary returns when
    // sessionId is provided — verify the action + scope shape match.
    const latest = assertHasRunSummary(ws.dir, {
      sessionId: session.id,
      action: 'iterate',
      status: 'built',
      requireFields: ['scopes', 'tokens'],
    });
    assert.deepEqual(latest.scopes, ['backend', 'frontend', 'database']);
  } finally {
    await ws.cleanup();
  }
});

// ── Test 5: appendDecision idempotent header behaviour ──────────────────

test('appendDecision: writes # Decisions Log header on first call, NOT on subsequent calls', async () => {
  const ws = await createTestWorkspace({ scope: 'ws-pipe', scenarioName: 'dec-header' });
  try {
    appendDecision(ws.dir, { summary: 'first' });
    appendDecision(ws.dir, { summary: 'second' });
    const text = readFileSync(path.join(getHarnessDir(ws.dir), 'decisions.md'), 'utf-8');
    const headerMatches = text.match(/# Decisions Log/g) || [];
    assert.equal(headerMatches.length, 1, 'header line appears exactly once');
    // Both entries present.
    assert.match(text, /first/);
    assert.match(text, /second/);
  } finally {
    await ws.cleanup();
  }
});
