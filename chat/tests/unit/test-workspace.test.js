/**
 * Unit tests for tests/util/test-workspace.js.
 *
 * The helper is load-bearing for parallel-safe integration tests. Per
 * TESTING_EVOLUTION.md known risks #2: "bugs there inherit into every
 * integration test." This file exists to catch those bugs before they
 * spread.
 *
 * Assertions:
 *   - 10 concurrent createTestWorkspace calls produce 10 distinct dirs
 *   - 10 concurrent calls produce 10 distinct port ranges (no overlap)
 *   - dirs exist, are writable, and are under os.tmpdir()
 *   - cleanup() removes the dir
 *   - cleanup() is idempotent (second call does not throw)
 *   - containerPrefix is unique per workspace
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { stat, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import { createTestWorkspace } from '../util/test-workspace.js';

test('createTestWorkspace: 10 concurrent calls → 10 distinct dirs', async () => {
  const wss = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      createTestWorkspace({ scope: 'parallel-test', scenarioName: `n${i}` }),
    ),
  );
  try {
    const dirs = new Set(wss.map((w) => w.dir));
    assert.equal(dirs.size, 10, 'every workspace got a distinct dir');
    for (const ws of wss) {
      assert.ok(ws.dir.startsWith(tmpdir()), 'dir is under os.tmpdir()');
      const s = await stat(ws.dir);
      assert.ok(s.isDirectory(), 'dir is an actual directory');
    }
  } finally {
    await Promise.all(wss.map((w) => w.cleanup()));
  }
});

test('createTestWorkspace: 10 concurrent calls → 10 distinct port ranges (no overlap)', async () => {
  const wss = await Promise.all(
    Array.from({ length: 10 }, () => createTestWorkspace({ scope: 'ports' })),
  );
  try {
    // Each ws.ports has 4 numeric ports. Across 10 workspaces that's 40 ports.
    // We require all 40 to be distinct — no overlap between workspaces.
    const all = [];
    for (const ws of wss) {
      assert.equal(typeof ws.ports.backend, 'number');
      assert.equal(typeof ws.ports.frontend, 'number');
      assert.equal(typeof ws.ports.database, 'number');
      assert.equal(typeof ws.ports.vectordb, 'number');
      all.push(ws.ports.backend, ws.ports.frontend, ws.ports.database, ws.ports.vectordb);
    }
    const distinct = new Set(all);
    // NOTE: a uuid-hash collision in port-slot space is theoretically possible
    // (~1/1024 per pair). If this assertion ever flakes on CI, that's the
    // signal — bump SLOTS in test-workspace.js, don't loosen the assertion.
    assert.equal(distinct.size, all.length,
      `every allocated port is unique across 10 workspaces (collision = port-slot aliasing; raise SLOTS)`);
  } finally {
    await Promise.all(wss.map((w) => w.cleanup()));
  }
});

test('createTestWorkspace: dir is writable', async () => {
  const ws = await createTestWorkspace({ scope: 'writable' });
  try {
    const file = join(ws.dir, 'probe.txt');
    await writeFile(file, 'hello');
    const contents = await readFile(file, 'utf8');
    assert.equal(contents, 'hello');
  } finally {
    await ws.cleanup();
  }
});

test('createTestWorkspace: cleanup() removes the dir', async () => {
  const ws = await createTestWorkspace({ scope: 'cleanup' });
  await writeFile(join(ws.dir, 'probe.txt'), 'data');
  await ws.cleanup();
  // After cleanup, access should throw ENOENT.
  await assert.rejects(
    () => access(ws.dir),
    /ENOENT|no such file/i,
    'dir is removed after cleanup',
  );
});

test('createTestWorkspace: cleanup() is idempotent (second call does not throw)', async () => {
  const ws = await createTestWorkspace({ scope: 'idem' });
  await ws.cleanup();
  // Second call must not throw, even though dir is already gone.
  await ws.cleanup();
  // And a third call still doesn't throw.
  await ws.cleanup();
});

test('createTestWorkspace: containerPrefix is unique per workspace', async () => {
  const wss = await Promise.all(
    Array.from({ length: 10 }, () => createTestWorkspace({ scope: 'prefix' })),
  );
  try {
    const prefixes = new Set(wss.map((w) => w.containerPrefix));
    assert.equal(prefixes.size, 10, 'every workspace got a distinct containerPrefix');
    for (const ws of wss) {
      assert.match(ws.containerPrefix, /^test-[a-f0-9-]+-$/, 'prefix matches docker-safe pattern');
    }
  } finally {
    await Promise.all(wss.map((w) => w.cleanup()));
  }
});
