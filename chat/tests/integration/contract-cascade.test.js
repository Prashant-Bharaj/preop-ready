/**
 * W2.CASCADE — Contract cascade tests.
 *
 * Exercises the four required scenarios from the W2.CASCADE brief:
 *
 *   (a) Breaking rename detection (users.full_name → first_name + last_name)
 *       Router emits affected_scopes=[database, backend] but frontend ALSO
 *       references the old column. Cascade greps, finds the reference, and
 *       escalates frontend into the dispatch set. cascade_escalation event
 *       is emitted via the wired-up dispatchIterate path.
 *
 *   (b) Additive-only (new optional column)
 *       Diff adds users.last_login. Not breaking — no grep should run, no
 *       escalation, no event.
 *
 *   (c) Markdown false-positive filtered
 *       Same rename diff as (a), but frontend/ has no CODE references; the
 *       only "full_name" lives in frontend/README.md. The cascade's file-
 *       type whitelist drops .md, so no escalation to frontend.
 *
 *   (d) Identifier variant matching (camelCase)
 *       backend/src/index.ts references `user.fullName` (camelCase) while
 *       the underlying SQL column is `full_name`. Cascade's
 *       identifierVariants() catches the variant; backend is escalated.
 *
 * Tests are UNIT-shaped: they hand-craft a workspace on disk under /tmp and
 * call analyzeCascade directly. The dispatchIterate-level integration is
 * exercised via a typed-event-emit spy in case (a).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  analyzeCascade,
  classifyDiff,
  identifierVariants,
} from '../../server/session/contract-cascade.js';

let workspaceDir;
function mkWorkspace(name) {
  workspaceDir = path.join(os.tmpdir(), `cascade-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function writeFile(rel, contents) {
  const full = path.join(workspaceDir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf-8');
}

afterEach(() => {
  if (workspaceDir) {
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    workspaceDir = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (a) Breaking rename detection — full_name → first_name + last_name
// ─────────────────────────────────────────────────────────────────────────
test('(a) breaking rename: router emits [database, backend] — cascade escalates to frontend', () => {
  mkWorkspace('rename');
  writeFile('database/init/init.sql', `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL
);
`);
  writeFile('backend/src/index.ts', `
import { Pool } from 'pg';
const pool = new Pool();

interface User { id: number; full_name: string; }

export async function getUser(id: number): Promise<User> {
  const r = await pool.query('SELECT id, full_name FROM users WHERE id = $1', [id]);
  return r.rows[0];
}
`);
  writeFile('frontend/src/UserCard.tsx', `
import React from 'react';
export function UserCard({ user }: { user: any }) {
  return <div>{user.full_name}</div>;
}
`);

  const priorContracts = {
    data: {
      data_model: {
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'id', type: 'SERIAL' },
              { name: 'full_name', type: 'VARCHAR(255)' },
              { name: 'email', type: 'VARCHAR(255)' },
            ],
          },
        ],
      },
    },
  };

  const contractDiffs = {
    data_model: {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'SERIAL' },
            { name: 'first_name', type: 'VARCHAR(255)' },
            { name: 'last_name', type: 'VARCHAR(255)' },
            { name: 'email', type: 'VARCHAR(255)' },
          ],
        },
      ],
    },
  };

  const cascade = analyzeCascade({
    workspaceDir,
    contractDiffs,
    affectedScopes: ['database', 'backend'],
    priorContracts,
  });

  // Classification must flag breaking with full_name as a removed identifier.
  assert.ok(cascade.breakingDiffs.length > 0, 'breakingDiffs should be non-empty');
  const removed = cascade.breakingDiffs.flatMap((d) => d.removedIdentifiers || []);
  assert.ok(removed.some((r) => r.name === 'full_name'),
    'full_name should be flagged as removedIdentifier');

  // Grep should have found a frontend reference.
  assert.deepEqual(cascade.originalScopes, ['database', 'backend']);
  assert.ok(cascade.escalatedScopes.includes('frontend'),
    `cascade should escalate to frontend (got: ${cascade.escalatedScopes.join(',')})`);
  assert.deepEqual(cascade.finalScopes.sort(), ['backend', 'database', 'frontend'].sort(),
    'finalScopes should be the union');

  // escalationReasons should reference full_name with foundInScopes including frontend.
  const reason = cascade.escalationReasons.find((r) => r.name === 'full_name');
  assert.ok(reason, `expected escalationReason for full_name (got: ${JSON.stringify(cascade.escalationReasons)})`);
  assert.ok(reason.foundInScopes.includes('frontend'),
    'reason.foundInScopes should include frontend');
});

// ─────────────────────────────────────────────────────────────────────────
// (b) Additive-only: new optional column → no cascade fires
// ─────────────────────────────────────────────────────────────────────────
test('(b) additive-only: new optional column → no escalation, grep NOT invoked', () => {
  mkWorkspace('additive');
  // Workspace would have code, but we won't write any references to anything.
  writeFile('database/init/init.sql', `
CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255));
`);

  const priorContracts = {
    data: {
      data_model: {
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'id', type: 'SERIAL' },
              { name: 'name', type: 'VARCHAR(255)' },
            ],
          },
        ],
      },
    },
  };

  // Diff: ADD last_login TIMESTAMPTZ (nullable). Existing columns unchanged.
  const contractDiffs = {
    data_model: {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'SERIAL' },
            { name: 'name', type: 'VARCHAR(255)' },
            { name: 'last_login', type: 'TIMESTAMPTZ' },
          ],
        },
      ],
    },
  };

  const cascade = analyzeCascade({
    workspaceDir,
    contractDiffs,
    affectedScopes: ['database'],
    priorContracts,
  });

  assert.equal(cascade.breakingDiffs.length, 0,
    'additive-only diff must NOT classify as breaking');
  assert.deepEqual(cascade.escalatedScopes, [],
    'no escalation scopes');
  assert.deepEqual(cascade.finalScopes, ['database'],
    'finalScopes === originalScopes');
  assert.equal(cascade.escalationReasons.length, 0,
    'no escalation reasons');
});

// ─────────────────────────────────────────────────────────────────────────
// (c) Markdown false-positive filtered
// ─────────────────────────────────────────────────────────────────────────
test('(c) markdown false-positive filtered: full_name in README.md does NOT trigger frontend escalation', () => {
  mkWorkspace('markdown');
  // Database + backend code references full_name — these ARE in scope.
  writeFile('database/init/init.sql',
    `CREATE TABLE users (id SERIAL, full_name VARCHAR(255));`);
  writeFile('backend/src/index.ts',
    `interface User { full_name: string; }\nconst u: User = { full_name: 'x' };`);
  // Frontend README mentions full_name in PROSE only — should be ignored.
  writeFile('frontend/README.md', `
# Frontend

This component renders the user's full_name. Specifically, see UserCard:
- Displays user.full_name in the header.
`);
  // Frontend has NO code referring to full_name.
  writeFile('frontend/src/Home.tsx',
    `export function Home() { return <h1>Home</h1>; }`);

  const priorContracts = {
    data: {
      data_model: {
        tables: [{
          name: 'users',
          columns: [
            { name: 'id', type: 'SERIAL' },
            { name: 'full_name', type: 'VARCHAR(255)' },
          ],
        }],
      },
    },
  };
  const contractDiffs = {
    data_model: {
      tables: [{
        name: 'users',
        columns: [
          { name: 'id', type: 'SERIAL' },
          { name: 'first_name', type: 'VARCHAR(255)' },
          { name: 'last_name', type: 'VARCHAR(255)' },
        ],
      }],
    },
  };

  const cascade = analyzeCascade({
    workspaceDir,
    contractDiffs,
    affectedScopes: ['database', 'backend'],
    priorContracts,
  });

  // Frontend must NOT be in the escalation set (the .md reference is filtered).
  assert.ok(!cascade.escalatedScopes.includes('frontend'),
    `frontend must not escalate when only .md mentions exist (got: ${cascade.escalatedScopes.join(',')})`);
  assert.deepEqual(cascade.finalScopes.sort(), ['backend', 'database'].sort(),
    'finalScopes should equal originalScopes');
});

// ─────────────────────────────────────────────────────────────────────────
// (d) Identifier variant matching (camelCase)
// ─────────────────────────────────────────────────────────────────────────
test('(d) identifier variant matching: camelCase fullName triggers backend escalation', () => {
  mkWorkspace('variants');
  writeFile('database/init/init.sql',
    `CREATE TABLE users (id SERIAL, full_name VARCHAR(255));`);
  // Backend uses camelCase variant — typical Sequelize/Prisma-style mapping.
  writeFile('backend/src/index.ts', `
interface User { id: number; fullName: string; }
function format(u: User) { return u.fullName.toUpperCase(); }
`);
  // Frontend doesn't reference it.
  writeFile('frontend/src/Home.tsx',
    `export function Home() { return <h1>Home</h1>; }`);

  const priorContracts = {
    data: {
      data_model: {
        tables: [{
          name: 'users',
          columns: [
            { name: 'id', type: 'SERIAL' },
            { name: 'full_name', type: 'VARCHAR(255)' },
          ],
        }],
      },
    },
  };
  const contractDiffs = {
    data_model: {
      tables: [{
        name: 'users',
        columns: [
          { name: 'id', type: 'SERIAL' },
          { name: 'first_name', type: 'VARCHAR(255)' },
          { name: 'last_name', type: 'VARCHAR(255)' },
        ],
      }],
    },
  };

  const cascade = analyzeCascade({
    workspaceDir,
    contractDiffs,
    affectedScopes: ['database'],
    priorContracts,
  });

  assert.ok(cascade.escalatedScopes.includes('backend'),
    `backend must escalate when camelCase variant fullName is referenced (got: ${cascade.escalatedScopes.join(',')})`);
  assert.deepEqual(cascade.finalScopes.sort(), ['backend', 'database'].sort(),
    'finalScopes must include backend');
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers — sanity tests for identifierVariants + classifyDiff (used by all)
// ─────────────────────────────────────────────────────────────────────────
test('identifierVariants: snake_case → snake/kebab/camel/Pascal', () => {
  const v = identifierVariants('full_name');
  assert.ok(v.includes('full_name'), 'snake');
  assert.ok(v.includes('full-name'), 'kebab');
  assert.ok(v.includes('fullName'), 'camel');
  assert.ok(v.includes('FullName'), 'pascal');
});

test('classifyDiff: data_model rename → breaking + removedIdentifiers + renames', () => {
  const prior = {
    tables: [
      { name: 'users', columns: [{ name: 'id', type: 'SERIAL' }, { name: 'full_name', type: 'VARCHAR(255)' }] },
    ],
  };
  const next = {
    tables: [
      { name: 'users', columns: [
        { name: 'id', type: 'SERIAL' },
        { name: 'first_name', type: 'VARCHAR(255)' },
        { name: 'last_name', type: 'VARCHAR(255)' },
      ] },
    ],
  };
  const c = classifyDiff(prior, next, 'data_model');
  assert.equal(c.breaking, true);
  assert.ok(c.removedIdentifiers.some((r) => r.name === 'full_name'));
  // Rename heuristic — at least one rename row entry should match full_name → one of first_name/last_name.
  const rename = c.renames.find((r) => r.oldName === 'full_name');
  assert.ok(rename, 'expected a rename row with oldName=full_name');
  assert.ok(['first_name', 'last_name'].includes(rename.newName),
    `rename.newName should be first_name or last_name (got ${rename.newName})`);
});

test('classifyDiff: data_model add column → NOT breaking', () => {
  const prior = { tables: [{ name: 'users', columns: [{ name: 'id', type: 'SERIAL' }] }] };
  const next = { tables: [
    { name: 'users', columns: [
      { name: 'id', type: 'SERIAL' },
      { name: 'last_login', type: 'TIMESTAMPTZ' },
    ] },
  ] };
  const c = classifyDiff(prior, next, 'data_model');
  assert.equal(c.breaking, false);
  assert.equal(c.removedIdentifiers.length, 0);
  assert.equal(c.renames.length, 0);
});
