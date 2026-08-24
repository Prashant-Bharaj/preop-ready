/**
 * normalizeConciergeDecision — unit coverage.
 *
 * Covers every transformation the post-build branch in routes.js relies
 * on: multi flattening (incl. nested), interrupt-then-iterate collapse,
 * interrupt-abort/wait collapse to respond, atomic passthrough, and
 * defensive shapes (null, missing action). The normalizer is the
 * load-bearing piece that lets routes.js treat every concierge decision
 * as a flat list of {respond, clarify, add_to_todo, dispatch_iterate, diagnose}.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConciergeDecision } from '../../server/agent/concierge/normalize-action.js';

test('atomic respond passes through unchanged', () => {
  const decision = { action: 'respond', response: 'hi' };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 1);
  assert.equal(result[0], decision);
});

test('atomic dispatch_iterate passes through unchanged', () => {
  const decision = {
    action: 'dispatch_iterate',
    iterate_summary: 'add /version endpoint',
    iterate_user_message: 'add a /version endpoint to the backend',
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 1);
  assert.equal(result[0], decision);
});

test('atomic diagnose passes through unchanged', () => {
  const decision = {
    action: 'diagnose',
    symptom: 'the projects page is blank',
    suspected_scope: 'frontend',
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 1);
  assert.equal(result[0], decision);
});

test('multi containing diagnose flattens with the diagnose preserved', () => {
  const decision = {
    action: 'multi',
    sub_actions: [
      { action: 'respond', response: 'looking into it' },
      { action: 'diagnose', symptom: 'save button does nothing' },
    ],
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 2);
  assert.equal(result[0].action, 'respond');
  assert.equal(result[1].action, 'diagnose');
  assert.equal(result[1].symptom, 'save button does nothing');
});

test('multi flattens sub_actions into a flat list', () => {
  const decision = {
    action: 'multi',
    sub_actions: [
      { action: 'respond', response: 'acknowledging' },
      { action: 'dispatch_iterate', iterate_summary: 'make button green' },
    ],
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 2);
  assert.equal(result[0].action, 'respond');
  assert.equal(result[1].action, 'dispatch_iterate');
});

test('nested multi flattens recursively', () => {
  const decision = {
    action: 'multi',
    sub_actions: [
      { action: 'respond', response: 'a' },
      {
        action: 'multi',
        sub_actions: [
          { action: 'add_to_todo', todo_item: 'later: refactor X' },
          { action: 'dispatch_iterate', iterate_summary: 'do Y now' },
        ],
      },
    ],
  };
  const result = normalizeConciergeDecision(decision);
  assert.deepEqual(result.map(r => r.action), ['respond', 'add_to_todo', 'dispatch_iterate']);
});

test('multi with empty sub_actions returns empty list', () => {
  const result = normalizeConciergeDecision({ action: 'multi', sub_actions: [] });
  assert.equal(result.length, 0);
});

test('multi with missing sub_actions returns empty list (defensive)', () => {
  const result = normalizeConciergeDecision({ action: 'multi' });
  assert.equal(result.length, 0);
});

test('interrupt with interrupt_then=iterate collapses to dispatch_iterate', () => {
  const decision = {
    action: 'interrupt',
    interrupt_then: 'iterate',
    interrupt_reason: 'use Python instead of Node',
    iterate_summary: 'switch backend to FastAPI',
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'dispatch_iterate');
  assert.equal(result[0].iterate_summary, 'switch backend to FastAPI');
  assert.equal(result[0].iterate_user_message, 'use Python instead of Node');
});

test('interrupt+iterate falls back to interrupt_reason when iterate_summary is absent', () => {
  const decision = {
    action: 'interrupt',
    interrupt_then: 'iterate',
    interrupt_reason: 'user wants email notifications added',
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result[0].action, 'dispatch_iterate');
  assert.equal(result[0].iterate_summary, 'user wants email notifications added');
});

test('interrupt with interrupt_then=abort collapses to respond (no in-flight build to stop)', () => {
  const decision = {
    action: 'interrupt',
    interrupt_then: 'abort',
    interrupt_reason: 'never mind',
    response: "Okay, I'll hold off.",
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'respond');
  assert.equal(result[0].response, "Okay, I'll hold off.");
});

test('interrupt with interrupt_then=wait collapses to respond using default ack', () => {
  const decision = {
    action: 'interrupt',
    interrupt_then: 'wait',
    interrupt_reason: 'pause here',
  };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result[0].action, 'respond');
  // Default ack format includes the then + reason
  assert.match(result[0].response, /wait/);
  assert.match(result[0].response, /pause here/);
});

test('null / non-object / missing action returns empty list', () => {
  assert.deepEqual(normalizeConciergeDecision(null), []);
  assert.deepEqual(normalizeConciergeDecision(undefined), []);
  assert.deepEqual(normalizeConciergeDecision('not-an-object'), []);
  assert.deepEqual(normalizeConciergeDecision({}), []);
  assert.deepEqual(normalizeConciergeDecision({ action: null }), []);
});

test('unknown action passes through (caller falls through to planner)', () => {
  const decision = { action: 'mystery_action', foo: 'bar' };
  const result = normalizeConciergeDecision(decision);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'mystery_action');
});

test('multi containing interrupt-then-iterate flattens AND collapses the interrupt', () => {
  const decision = {
    action: 'multi',
    sub_actions: [
      { action: 'respond', response: 'ack' },
      {
        action: 'interrupt',
        interrupt_then: 'iterate',
        interrupt_reason: 'change DB to Mongo',
        iterate_summary: 'switch to MongoDB',
      },
    ],
  };
  const result = normalizeConciergeDecision(decision);
  assert.deepEqual(result.map(r => r.action), ['respond', 'dispatch_iterate']);
  assert.equal(result[1].iterate_summary, 'switch to MongoDB');
});
