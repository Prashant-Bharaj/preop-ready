/**
 * model-picker — pins the model policy (decision 2026-07-20):
 * Sonnet writes code, Opus thinks. Coding subagents (initial + iterate +
 * fix agents) run CODER_MODEL/ITERATE_MODEL; understanding/contract/judge
 * keep INITIAL_BUILD_MODEL because their decisions cascade.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickModel } from '../../server/agent/llm/model-picker.js';
import { INITIAL_BUILD_MODEL, ITERATE_MODEL, CODER_MODEL } from '../../server/config/defaults.js';

test('coding subagents on initial build → CODER_MODEL (Sonnet)', () => {
  for (const scope of ['backend', 'frontend', 'database', 'vectordb', 'integration']) {
    const { model, source } = pickModel({ phase: 'SUBAGENT', scope, isIterate: false });
    assert.equal(model, CODER_MODEL, scope);
    assert.match(source, /initial-coder/);
  }
});

test('coding subagents on iterate → ITERATE_MODEL', () => {
  const { model } = pickModel({ phase: 'SUBAGENT', scope: 'frontend', isIterate: true });
  assert.equal(model, ITERATE_MODEL);
});

test('thinking phases → INITIAL_BUILD_MODEL (Opus), never the coder model', () => {
  for (const phase of ['UNDERSTANDING', 'CONTRACT', 'JUDGE', 'SUMMARIZER']) {
    const { model } = pickModel({ phase, scope: 'planner' });
    assert.equal(model, INITIAL_BUILD_MODEL, phase);
  }
});

test('per-scope env override beats everything for that scope', () => {
  process.env.MGA_MODEL_OVERRIDE_FRONTEND = 'claude-test-override';
  try {
    assert.equal(pickModel({ phase: 'SUBAGENT', scope: 'frontend' }).model, 'claude-test-override');
    assert.equal(pickModel({ phase: 'SUBAGENT', scope: 'backend' }).model, CODER_MODEL);
  } finally {
    delete process.env.MGA_MODEL_OVERRIDE_FRONTEND;
  }
});

test('MGA_MODEL_CODER tunes coders without touching thinking phases', () => {
  process.env.MGA_MODEL_CODER = 'claude-coder-tune';
  try {
    assert.equal(pickModel({ phase: 'SUBAGENT', scope: 'backend' }).model, 'claude-coder-tune');
    assert.equal(pickModel({ phase: 'CONTRACT', scope: 'planner' }).model, INITIAL_BUILD_MODEL);
  } finally {
    delete process.env.MGA_MODEL_CODER;
  }
});
