/**
 * The plan held for confirmation survives a server restart.
 *
 * Module under test:
 *   chat/server/session/pending-plan-store.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { savePendingPlan, loadPendingPlan, clearPendingPlan } from '../../server/session/pending-plan-store.js';

test('save → load round-trips the plan without envContext; clear removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  try {
    const plan = { tasks: [{ scope: 'backend', task: 'x', dockerfile: 'Dockerfile.node' }], flags: ['has-users'], envContext: { huge: true }, uploads: null, modulePlan: null, confidence: 0.9, reasonCodes: ['a'] };
    assert.equal(savePendingPlan('s1', plan, { dir }), true);
    const loaded = loadPendingPlan('s1', { dir });
    assert.equal(loaded.envContext, null);
    assert.deepEqual(loaded.tasks, plan.tasks);
    assert.deepEqual(loaded.flags, ['has-users']);
    assert.equal(loaded.confidence, 0.9);
    assert.equal(clearPendingPlan('s1', { dir }), true);
    assert.equal(loadPendingPlan('s1', { dir }), null);
    assert.equal(clearPendingPlan('s1', { dir }), true); // idempotent
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing, corrupt, or task-less files load as null; null plan saves as clear; bad ids rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  try {
    assert.equal(loadPendingPlan('nope', { dir }), null);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(loadPendingPlan('bad', { dir }), null);
    fs.writeFileSync(path.join(dir, 'notasks.json'), JSON.stringify({ plan: { flags: [] } }));
    assert.equal(loadPendingPlan('notasks', { dir }), null);
    savePendingPlan('s2', { tasks: [] }, { dir });
    assert.equal(savePendingPlan('s2', null, { dir }), true);
    assert.equal(fs.existsSync(path.join(dir, 's2.json')), false);
    assert.throws(() => savePendingPlan('../escape', { tasks: [] }, { dir }) || (() => { throw new Error('x'); })(), /./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
