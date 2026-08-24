/**
 * Coverage: flows 3, 4, 7 via the chain
 *   flow 3 (new feature) → contract diff emission → generator emits
 *                          updated TS/Pydantic
 *   flow 4 (breaking change) → schema validation → emitter must catch
 *                              malformed contracts before they reach
 *                              the cascade
 *   flow 7 (multi-turn)   → contracts versioning → generator reads the
 *                           current envelope shape correctly
 *
 * This file tests the contract types generator's public API surface in
 * isolation: schema validation, TS/Pydantic emission, atomic writes,
 * tsc-fallback resolution. The full `generateContractTypes` orchestration
 * is tested at the integration tier; here we cover the primitives.
 *
 * If you change tests in this file: confirm the chain link is still valid.
 * If you remove a test: confirm no chain dependency disappears with it.
 *
 * Module under test: chat/server/agent/contract-types-generator.js (851 LoC).
 * Public surface (per the module docstring):
 *   generateContractTypes(workspaceDir, opts)
 *   emitTsContracts(envelope, { scope })
 *   emitPydanticModels(envelope)
 *   validateContractsSchema(envelope)
 *   selfTestTs(source, label, workspaceDir)
 *
 * Notes on tsc availability:
 * In this CI environment `tsc` is NOT on PATH and the workspace
 * `node_modules/.bin/tsc` are not pre-populated. The `selfTestTs`
 * fallback chain is therefore tested by:
 *  (a) staged stub `node_modules/.bin/tsc` shell scripts to assert
 *      `resolveTscCommand` discovers them
 *  (b) `skipSelfTest: true` for emission tests so they pass without tsc
 *  (c) explicit "no tsc reachable" case asserts soft-skip return shape
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  mkdir,
  writeFile,
  readFile,
  chmod,
  stat,
} from 'node:fs/promises';

import { createTestWorkspace } from '../util/test-workspace.js';
import { makeContractsEnvelope as envelope } from '../util/contracts-fixtures.js';
import {
  emitTsContracts,
  emitPydanticModels,
  validateContractsSchema,
  selfTestTs,
  generateContractTypes,
} from '../../server/agent/contract-types-generator.js';

// ── Fixture helpers ──────────────────────────────────────────────────────

// A complete-enough contracts envelope used by emission tests.
function mkEnvelope({ tables = [], endpoints = [], components = [], fileStructure = {}, vectorEngine = null } = {}) {
  const data = {
    data_model: tables.length ? { tables } : undefined,
    api_contract: endpoints.length ? { endpoints } : undefined,
    ui_contract: components.length ? { components } : undefined,
    file_structure: fileStructure,
  };
  if (vectorEngine !== null) data.vector_engine = vectorEngine;
  return envelope(data);
}

// ── validateContractsSchema: happy + failure paths ───────────────────────

test('validateContractsSchema: empty data with only required file_structure passes', () => {
  const env = envelope({ file_structure: { backend: { language: 'node' } } });
  // Should NOT throw.
  validateContractsSchema(env);
});

test('validateContractsSchema: null envelope throws with precise path', () => {
  assert.throws(
    () => validateContractsSchema(null),
    /contracts envelope is null/i,
  );
});

test('validateContractsSchema: missing version throws on .version path', () => {
  assert.throws(
    () => validateContractsSchema({ data: { file_structure: { backend: {} } } }),
    (err) => {
      assert.match(err.message, /at \.version/);
      return true;
    },
  );
});

test('validateContractsSchema: unsupported version surfaces the version number', () => {
  assert.throws(
    () => validateContractsSchema({ version: 999, data: { file_structure: { backend: {} } } }),
    /unsupported version 999/i,
  );
});

test('validateContractsSchema: missing data throws on .data path', () => {
  assert.throws(
    () => validateContractsSchema({ version: 1 }),
    (err) => {
      assert.equal(err.path, '.data');
      return true;
    },
  );
});

test('validateContractsSchema: data_model table missing name → precise path', () => {
  const env = envelope({
    file_structure: { backend: {} },
    data_model: { tables: [{ columns: [{ name: 'id', type: 'INTEGER' }] }] },
  });
  assert.throws(
    () => validateContractsSchema(env),
    (err) => {
      assert.match(err.path, /\.data\.data_model\.tables\[0\]\.name/);
      return true;
    },
  );
});

test('validateContractsSchema: api_contract endpoint missing method → precise path', () => {
  const env = envelope({
    file_structure: { backend: {} },
    api_contract: { endpoints: [{ path: '/users' }] },
  });
  assert.throws(
    () => validateContractsSchema(env),
    (err) => {
      assert.match(err.path, /\.data\.api_contract\.endpoints\[0\]\.method/);
      return true;
    },
  );
});

test('validateContractsSchema: invalid vector_engine value is rejected', () => {
  const env = envelope({
    file_structure: { backend: {} },
    vector_engine: 'qdrant', // retired
  });
  assert.throws(
    () => validateContractsSchema(env),
    /unsupported value 'qdrant'/,
  );
});

test('validateContractsSchema: vector_engine "pgvector" is accepted', () => {
  const env = envelope({
    file_structure: { backend: {} },
    vector_engine: 'pgvector',
  });
  validateContractsSchema(env); // no throw
});

// ── emitTsContracts: SQL type mappings ───────────────────────────────────

test('emitTsContracts: INTEGER → number', () => {
  const env = mkEnvelope({ tables: [{ name: 'users', columns: [{ name: 'id', type: 'INTEGER' }] }] });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /export interface User \{/);
  assert.match(source, /id: number;/);
});

test('emitTsContracts: SERIAL PRIMARY KEY → number', () => {
  const env = mkEnvelope({ tables: [{ name: 'tasks', columns: [{ name: 'id', type: 'SERIAL PRIMARY KEY' }] }] });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /id: number;/);
});

test('emitTsContracts: VARCHAR / TEXT / UUID → string', () => {
  const env = mkEnvelope({
    tables: [{
      name: 'people',
      columns: [
        { name: 'name', type: 'VARCHAR(255)' },
        { name: 'bio', type: 'TEXT' },
        { name: 'uid', type: 'UUID' },
      ],
    }],
  });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /name: string;/);
  assert.match(source, /bio: string;/);
  assert.match(source, /uid: string;/);
});

test('emitTsContracts: BOOLEAN → boolean', () => {
  const env = mkEnvelope({ tables: [{ name: 'flags', columns: [{ name: 'enabled', type: 'BOOLEAN' }] }] });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /enabled: boolean;/);
});

test('emitTsContracts: TIMESTAMPTZ / DATE / TIME → string (ISO-formatted)', () => {
  const env = mkEnvelope({
    tables: [{
      name: 'logs',
      columns: [
        { name: 'created_at', type: 'TIMESTAMPTZ DEFAULT NOW()' },
        { name: 'birthday', type: 'DATE' },
        { name: 'when_at', type: 'TIME' },
      ],
    }],
  });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /created_at: string;/);
  assert.match(source, /birthday: string;/);
  assert.match(source, /when_at: string;/);
});

test('emitTsContracts: JSONB / JSON → Record<string, unknown>', () => {
  const env = mkEnvelope({ tables: [{ name: 'configs', columns: [{ name: 'data', type: 'JSONB' }] }] });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /data: Record<string, unknown>;/);
});

test('emitTsContracts: VECTOR(1536) → number[]', () => {
  const env = mkEnvelope({ tables: [{ name: 'embeddings', columns: [{ name: 'vec', type: 'VECTOR(1536)' }] }] });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /vec: number\[\];/);
});

test('emitTsContracts: unknown SQL type → unknown + warning', () => {
  const env = mkEnvelope({ tables: [{ name: 'odd', columns: [{ name: 'x', type: 'WEIRDTYPE' }] }] });
  const { source, warnings } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /x: unknown;/);
  assert.ok(warnings.length > 0);
  assert.match(warnings[0], /Unknown SQL type/i);
});

// ── Header / AUTO-GENERATED marker ───────────────────────────────────────

test('emitTsContracts: source contains AUTO-GENERATED marker for reconciler detection', () => {
  const env = mkEnvelope({ tables: [{ name: 't', columns: [{ name: 'id', type: 'INTEGER' }] }] });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /AUTO-GENERATED — DO NOT EDIT/);
});

test('emitPydanticModels: source contains AUTO-GENERATED marker (Python comment form)', () => {
  const env = mkEnvelope({ tables: [{ name: 't', columns: [{ name: 'id', type: 'INTEGER' }] }] });
  const { source } = emitPydanticModels(env);
  assert.match(source, /^# AUTO-GENERATED — DO NOT EDIT/m);
});

// ── emitTsContracts: api_contract endpoint emission ──────────────────────

test('emitTsContracts: endpoint emits Request + Response interfaces', () => {
  const env = mkEnvelope({
    endpoints: [{
      method: 'POST',
      path: '/users',
      request: { name: 'string', age: 'number' },
      response: { body: { id: 'integer', name: 'string' } },
    }],
  });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  // Note: toPascal preserves the original casing when input is already
  // [A-Za-z0-9]+, so `POST` stays `POST` (not `Post`).
  assert.match(source, /export interface POSTUsersRequest \{/);
  assert.match(source, /name: string;/);
  assert.match(source, /age: number;/);
  assert.match(source, /export interface POSTUsersResponse \{/);
  assert.match(source, /id: number;/);
});

test('emitTsContracts: endpoint with path params builds clean identifier (no `:`/`{}`)', () => {
  const env = mkEnvelope({
    endpoints: [{
      method: 'GET',
      path: '/users/:id/tasks',
      response: { body: { id: 'integer' } },
    }],
  });
  const { source } = emitTsContracts(env, { scope: 'backend' });
  // Identifier must be no colon, no braces. (The method casing is
  // preserved per toPascal's "already-camelcase" branch — `GET` stays
  // `GET`, so the generated identifier is `GETUsersIdTasksResponse`.)
  assert.match(source, /export interface (Get|GET)UsersIdTasksResponse \{/);
  // No colon, no curly braces in the identifier portion.
  assert.doesNotMatch(source, /interface\s+\w*:\w*/);
});

// ── emitTsContracts: ui_contract emission (frontend only) ────────────────

test('emitTsContracts: ui_contract components only emitted for scope=frontend', () => {
  const env = mkEnvelope({
    components: [{ name: 'UserList', role: 'view', props: { items: 'array' } }],
  });
  const { source: feSrc } = emitTsContracts(env, { scope: 'frontend' });
  const { source: beSrc } = emitTsContracts(env, { scope: 'backend' });
  assert.match(feSrc, /export interface UserListProps \{/);
  assert.doesNotMatch(beSrc, /UserListProps/);
});

// ── Empty contracts produce parseable modules ────────────────────────────

test('emitTsContracts: empty envelope produces a parseable TS module with sentinel type', () => {
  const env = mkEnvelope({});
  const { source } = emitTsContracts(env, { scope: 'backend' });
  assert.match(source, /export type ContractsModule = Record<string, never>;/);
});

test('emitPydanticModels: empty envelope produces a parseable Python module with sentinel class', () => {
  const env = mkEnvelope({});
  const { source } = emitPydanticModels(env);
  assert.match(source, /class _ContractsModule\(BaseModel\):/);
});

// ── Pydantic type mappings ───────────────────────────────────────────────

test('emitPydanticModels: INTEGER → int', () => {
  const env = mkEnvelope({ tables: [{ name: 'users', columns: [{ name: 'id', type: 'INTEGER' }] }] });
  const { source } = emitPydanticModels(env);
  assert.match(source, /class User\(BaseModel\):/);
  assert.match(source, /id: int/);
});

test('emitPydanticModels: TEXT / VARCHAR → str', () => {
  const env = mkEnvelope({
    tables: [{
      name: 'people',
      columns: [
        { name: 'name', type: 'VARCHAR(100)' },
        { name: 'bio', type: 'TEXT' },
      ],
    }],
  });
  const { source } = emitPydanticModels(env);
  assert.match(source, /name: str/);
  assert.match(source, /bio: str/);
});

test('emitPydanticModels: BOOLEAN → bool', () => {
  const env = mkEnvelope({ tables: [{ name: 'flags', columns: [{ name: 'on', type: 'BOOLEAN' }] }] });
  const { source } = emitPydanticModels(env);
  assert.match(source, /on: bool/);
});

test('emitPydanticModels: TIMESTAMPTZ → datetime + import line', () => {
  const env = mkEnvelope({ tables: [{ name: 'logs', columns: [{ name: 'at', type: 'TIMESTAMPTZ' }] }] });
  const { source } = emitPydanticModels(env);
  assert.match(source, /at: datetime/);
  assert.match(source, /from datetime import datetime/);
});

test('emitPydanticModels: JSONB → dict[str, Any] + Any import', () => {
  const env = mkEnvelope({ tables: [{ name: 'configs', columns: [{ name: 'data', type: 'JSONB' }] }] });
  const { source } = emitPydanticModels(env);
  assert.match(source, /data: dict\[str, Any\]/);
  assert.match(source, /from typing import .*Any/);
});

test('emitPydanticModels: VECTOR → list[float]', () => {
  const env = mkEnvelope({ tables: [{ name: 'emb', columns: [{ name: 'v', type: 'VECTOR(384)' }] }] });
  const { source } = emitPydanticModels(env);
  assert.match(source, /v: list\[float\]/);
});

// ── selfTestTs: tsc soft-skip when unreachable ───────────────────────────

test('selfTestTs: returns valid shape (skipped or not-skipped) without throwing on clean TS', async () => {
  // Environment-tolerant: depending on whether `tsc`, `npx`+typescript, or
  // neither are reachable, this can either soft-skip OR run cleanly. Both
  // are valid contract outcomes; pin the shape, not the specific branch.
  // The negative case (forced failure) is tested separately via a stub
  // that exits non-zero — see "selfTestTs: throws when stub tsc exits
  // non-zero" below.
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'shape' });
  try {
    const result = selfTestTs('export const x: number = 1;', 'unit-test', ws.dir);
    // Either skipped (no tsc reachable) or successful run.
    if (result.skipped) {
      assert.match(result.reason, /no tsc binary reachable/i);
    } else {
      assert.equal(result.skipped, false);
    }
  } finally {
    await ws.cleanup();
  }
});

// ── selfTestTs: discovery via workspace/frontend/node_modules/.bin/tsc ───
//
// Stage a fake tsc-shaped script that accepts `--version` and prints a
// version string, then asserts no diagnostics for a `--noEmit` run. This
// proves the resolver picks up the workspace/frontend path.
async function stageStubTsc(workspaceDir, where /* 'frontend' | 'backend' */) {
  const binDir = path.join(workspaceDir, where, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  const tscPath = path.join(binDir, 'tsc');
  // Minimal fake: returns version on --version, exits 0 on --noEmit.
  const script = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "--version" ]; then',
    '  echo "Version 5.0.0-fake"',
    '  exit 0',
    'fi',
    '# --noEmit happy path: exit 0',
    'exit 0',
  ].join('\n');
  await writeFile(tscPath, script, 'utf-8');
  await chmod(tscPath, 0o755);
  return tscPath;
}

test('selfTestTs: discovers workspace/frontend/node_modules/.bin/tsc and runs cleanly', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'stub-fe' });
  try {
    await stageStubTsc(ws.dir, 'frontend');
    const result = selfTestTs('export const x: number = 1;', 'unit-test', ws.dir);
    assert.equal(result.skipped, false);
    assert.equal(result.reason, undefined);
  } finally {
    await ws.cleanup();
  }
});

test('selfTestTs: falls back to backend/node_modules/.bin/tsc when frontend is absent', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'stub-be' });
  try {
    await stageStubTsc(ws.dir, 'backend');
    const result = selfTestTs('export const x: number = 1;', 'unit-test', ws.dir);
    assert.equal(result.skipped, false);
  } finally {
    await ws.cleanup();
  }
});

test('selfTestTs: throws when stub tsc exits non-zero (self-test failure path)', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'stub-fail' });
  try {
    // Stub that always fails on --noEmit (but passes --version so the
    // resolver picks it up).
    const binDir = path.join(ws.dir, 'frontend', 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const tscPath = path.join(binDir, 'tsc');
    const script = [
      '#!/usr/bin/env bash',
      'if [ "$1" = "--version" ]; then',
      '  echo "Version 5.0.0-fake"',
      '  exit 0',
      'fi',
      'echo "error TS9999: forced failure" >&2',
      'exit 2',
    ].join('\n');
    await writeFile(tscPath, script, 'utf-8');
    await chmod(tscPath, 0o755);

    assert.throws(
      () => selfTestTs('garbage TS source', 'unit-test', ws.dir),
      (err) => {
        assert.match(err.message, /self-test failed/i);
        assert.match(err.tscOutput, /forced failure|error TS9999/);
        return true;
      },
    );
  } finally {
    await ws.cleanup();
  }
});

// ── generateContractTypes: atomic write via tmp file + rename ────────────

test('generateContractTypes: writes backend/src/generated/contracts.ts atomically', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-be-node' });
  try {
    // Stage minimal contracts.json so the generator has something to emit.
    const harness = path.join(ws.dir, '.harness');
    await mkdir(harness, { recursive: true });
    await writeFile(path.join(harness, 'contracts.json'), JSON.stringify({
      version: 1,
      data: {
        file_structure: { backend: { language: 'node' } },
        data_model: { tables: [{ name: 'item', columns: [{ name: 'id', type: 'INTEGER' }] }] },
      },
    }, null, 2));

    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors.join('; ')}`);
    assert.equal(result.written.length, 1);

    const target = path.join(ws.dir, 'backend/src/generated/contracts.ts');
    const content = await readFile(target, 'utf-8');
    assert.match(content, /export interface Item \{/);
    assert.match(content, /AUTO-GENERATED/);

    // Confirm no leftover .tmp file (the atomic write renamed it cleanly).
    await assert.rejects(stat(`${target}.tmp`), /ENOENT|no such/i,
      '.tmp file must be removed after rename');
  } finally {
    await ws.cleanup();
  }
});

test('generateContractTypes: writes Python models.py for python-backend scope', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-be-py' });
  try {
    const harness = path.join(ws.dir, '.harness');
    await mkdir(harness, { recursive: true });
    await writeFile(path.join(harness, 'contracts.json'), JSON.stringify({
      version: 1,
      data: {
        file_structure: { backend: { language: 'python' } },
        data_model: { tables: [{ name: 'user', columns: [{ name: 'id', type: 'INTEGER' }] }] },
      },
    }, null, 2));

    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors.join('; ')}`);
    assert.equal(result.written.length, 1);

    const target = path.join(ws.dir, 'backend/generated/models.py');
    const content = await readFile(target, 'utf-8');
    assert.match(content, /class User\(BaseModel\):/);
    assert.match(content, /id: int/);
  } finally {
    await ws.cleanup();
  }
});

test('generateContractTypes: no contracts.json → skipped (not an error)', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-nocontracts' });
  try {
    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.equal(result.written.length, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /not found/i);
  } finally {
    await ws.cleanup();
  }
});

test('generateContractTypes: malformed contracts.json schema fails with precise path', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-bad-schema' });
  try {
    const harness = path.join(ws.dir, '.harness');
    await mkdir(harness, { recursive: true });
    // Missing file_structure → required field → schema validation fails.
    await writeFile(path.join(harness, 'contracts.json'), JSON.stringify({
      version: 1,
      data: { /* no file_structure */ },
    }, null, 2));

    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.equal(result.written.length, 0);
    assert.ok(result.errors.length > 0);
    assert.match(result.errors[0], /schema validation failed/i);
    assert.match(result.errors[0], /file_structure/);
  } finally {
    await ws.cleanup();
  }
});

test('generateContractTypes: both backend + frontend scopes write two files', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-both' });
  try {
    const harness = path.join(ws.dir, '.harness');
    await mkdir(harness, { recursive: true });
    await writeFile(path.join(harness, 'contracts.json'), JSON.stringify({
      version: 1,
      data: {
        file_structure: {
          backend: { language: 'node' },
          frontend: {},
        },
        data_model: { tables: [{ name: 'task', columns: [{ name: 'id', type: 'INTEGER' }] }] },
        ui_contract: { components: [{ name: 'TaskList', role: 'view', props: { tasks: 'array' } }] },
      },
    }, null, 2));

    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.equal(result.errors.length, 0, `unexpected errors: ${result.errors.join('; ')}`);
    assert.equal(result.written.length, 2);

    const be = await readFile(path.join(ws.dir, 'backend/src/generated/contracts.ts'), 'utf-8');
    const fe = await readFile(path.join(ws.dir, 'frontend/src/generated/contracts.ts'), 'utf-8');
    assert.match(be, /export interface Task \{/);
    assert.match(fe, /export interface Task \{/);
    // ui_contract is FE-only.
    assert.doesNotMatch(be, /TaskListProps/);
    assert.match(fe, /export interface TaskListProps \{/);
  } finally {
    await ws.cleanup();
  }
});

test('generateContractTypes: file_structure with only database/integration scopes → no types emitted', async () => {
  // The generator only emits TS/Pydantic for backend + frontend scopes.
  // A database-only or integration-only build has nothing to emit and
  // should record a skip rather than an error. (An empty file_structure
  // {} fails schema validation; the validator requires ≥1 known scope.)
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-noemit-scopes' });
  try {
    const harness = path.join(ws.dir, '.harness');
    await mkdir(harness, { recursive: true });
    await writeFile(path.join(harness, 'contracts.json'), JSON.stringify({
      version: 1,
      data: { file_structure: { database: {}, integration: {} } },
    }, null, 2));

    const result = generateContractTypes(ws.dir, { skipSelfTest: true });
    assert.equal(result.written.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /no backend or frontend scope/i);
    assert.equal(result.errors.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('generateContractTypes: telemetry log appended to .harness/contract-types-generator.log', async () => {
  const ws = await createTestWorkspace({ scope: 'ctg', scenarioName: 'gen-log' });
  try {
    const harness = path.join(ws.dir, '.harness');
    await mkdir(harness, { recursive: true });
    await writeFile(path.join(harness, 'contracts.json'), JSON.stringify({
      version: 1,
      data: {
        file_structure: { backend: { language: 'node' } },
        data_model: { tables: [{ name: 't', columns: [{ name: 'id', type: 'INTEGER' }] }] },
      },
    }, null, 2));

    generateContractTypes(ws.dir, { skipSelfTest: true });
    const logFile = path.join(harness, 'contract-types-generator.log');
    const content = await readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    assert.ok(lines.length >= 2, 'at least one event + summary');
    const summary = JSON.parse(lines[lines.length - 1]);
    assert.equal(summary.event, 'summary');
    assert.equal(summary.written, 1);
  } finally {
    await ws.cleanup();
  }
});
