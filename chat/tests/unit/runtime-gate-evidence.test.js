/**
 * runtime-gate evidence discipline — unit coverage for isNonActionable.
 *
 * The classifier decides whether a gate failure carries evidence a fix agent
 * can act on. Getting this wrong in either direction is the risk: too loose
 * suppresses real failures; too strict keeps burning fix rounds on phantom
 * timeouts (observed live: 4 scopes "failed" simultaneously with `probe
 * timeout … (docker logs unavailable)`, ~12 min + 785k tokens wasted, app
 * verified green downstream).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNonActionable } from '../../server/reconciler/runtime-gate.js';

test('probe timeout with logs unavailable → non-actionable', () => {
  assert.equal(isNonActionable({
    hasErrors: true,
    errors: [{ kind: 'probe', stage: 'probe backend', message: 'probe timeout — service did not respond with 2xx/3xx', dockerLogs: '(docker logs unavailable)' }],
  }), true);
});

test('probe timeout with EMPTY-string logs → non-actionable (container gone)', () => {
  assert.equal(isNonActionable({
    hasErrors: true,
    errors: [{ kind: 'probe', stage: 'probe vectordb', message: 'pg_isready never returned success within probe window — timeout', dockerLogs: '' }],
  }), true);
});

test('probe timeout WITH real container logs → actionable (hang has evidence)', () => {
  assert.equal(isNonActionable({
    hasErrors: true,
    errors: [{ kind: 'probe', stage: 'probe backend', message: 'probe timeout — service did not respond with 2xx/3xx', dockerLogs: 'Error: connect ECONNREFUSED at Pool.connect' }],
  }), false);
});

test('build failure → always actionable (compiler/docker output)', () => {
  assert.equal(isNonActionable({
    hasErrors: true,
    errors: [{ kind: 'build', stage: 'docker build backend', message: 'npm ERR! missing script: build' }],
  }), false);
});

test('crash with FATAL logs → actionable', () => {
  assert.equal(isNonActionable({
    hasErrors: true,
    errors: [{ kind: 'probe', stage: 'probe database', message: 'pg_isready never returned success within probe window — timeout', dockerLogs: 'FATAL: database files are incompatible with server' }],
  }), false);
});

test('mixed errors (one actionable) → actionable', () => {
  assert.equal(isNonActionable({
    hasErrors: true,
    errors: [
      { kind: 'probe', stage: 'probe backend', message: 'probe timeout — service did not respond', dockerLogs: '(docker logs unavailable)' },
      { kind: 'build', stage: 'docker build backend', message: 'tsc: TS2304 cannot find name' },
    ],
  }), false);
});

test('clean / skipped results → not non-actionable', () => {
  assert.equal(isNonActionable({ hasErrors: false, errors: [] }), false);
  assert.equal(isNonActionable(null), false);
  assert.equal(isNonActionable({ hasErrors: true, errors: [] }), false);
});
