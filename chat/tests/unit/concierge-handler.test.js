/**
 * Concierge action dispatcher — unit coverage.
 *
 * Each concierge action shape from chat/prompts/concierge.md gets one or
 * two tests covering the happy path + the deferred-action decline paths
 * (dispatch_iterate, interrupt). multi recurses sequentially.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchConciergeAction } from '../../server/agent/concierge/handle-action.js';

function makeSession() {
  return { id: 'test-session-' + Math.random().toString(36).slice(2, 8) };
}

function collectEmit() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

test('respond: emits concierge_text with the response field', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session,
    { action: 'respond', response: 'Build is going fine — backend just finished.' },
    { emit: sink.emit });
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, 'concierge_text');
  assert.equal(sink.events[0].payload.text, 'Build is going fine — backend just finished.');
});

test('clarify: emits concierge_text identical to respond', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session,
    { action: 'clarify', response: 'Which scope did you mean — backend or frontend?' },
    { emit: sink.emit });
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, 'concierge_text');
  assert.match(sink.events[0].payload.text, /Which scope/);
});

test('add_to_todo: appends item to session.todoList and emits ack', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session,
    { action: 'add_to_todo', todo_item: 'Add OAuth login UI' },
    { emit: sink.emit });

  assert.ok(Array.isArray(session.todoList));
  assert.equal(session.todoList.length, 1);
  const item = session.todoList[0];
  assert.equal(item.text, 'Add OAuth login UI');
  assert.ok(typeof item.id === 'string' && item.id.length > 0, 'item has an id');
  assert.ok(typeof item.added_at === 'number' && item.added_at > 0, 'item has added_at');

  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].type, 'concierge_text');
  assert.match(sink.events[0].payload.text, /Added to your todo list/);
});

test('add_to_todo: uses concierge-provided response when present (overrides default ack)', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session,
    { action: 'add_to_todo', todo_item: 'Dark mode toggle', response: "Got it — I'll keep that on the list for after the build." },
    { emit: sink.emit });
  assert.equal(sink.events[0].payload.text, "Got it — I'll keep that on the list for after the build.");
});

test('add_to_todo: empty todo_item is skipped with diagnostic message', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session,
    { action: 'add_to_todo', todo_item: '   ' },
    { emit: sink.emit });
  assert.equal(session.todoList, undefined, 'no list created for skipped add');
  assert.match(sink.events[0].payload.text, /add_to_todo without todo_item/);
});

test('dispatch_iterate: DEFERRED — emits polite decline (does not call planner)', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session, {
    action: 'dispatch_iterate',
    iterate_summary: 'Add admin role',
    iterate_user_message: 'Please add an admin role to the schema.',
  }, { emit: sink.emit });
  assert.equal(sink.events.length, 1);
  assert.match(sink.events[0].payload.text, /can't dispatch a new iteration/);
  assert.equal(session.todoList, undefined, 'no side effect on session state');
});

test('interrupt: DEFERRED — emits polite decline', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session, {
    action: 'interrupt',
    interrupt_reason: 'wrong scope',
    interrupt_then: 'iterate',
  }, { emit: sink.emit });
  assert.equal(sink.events.length, 1);
  assert.match(sink.events[0].payload.text, /can't interrupt/);
});

test('multi: recurses sequentially through sub_actions', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session, {
    action: 'multi',
    sub_actions: [
      { action: 'respond', response: 'Sure, here\'s an update.' },
      { action: 'add_to_todo', todo_item: 'Polish login page' },
    ],
  }, { emit: sink.emit });

  assert.equal(sink.events.length, 2, 'one event per sub_action');
  assert.equal(sink.events[0].payload.text, 'Sure, here\'s an update.');
  assert.match(sink.events[1].payload.text, /Added to your todo list/);
  assert.equal(session.todoList.length, 1);
});

test('multi: empty sub_actions array is a no-op', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session, { action: 'multi', sub_actions: [] }, { emit: sink.emit });
  assert.equal(sink.events.length, 0);
});

test('unknown action: emits diagnostic concierge_text', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session, { action: 'wat' }, { emit: sink.emit });
  assert.equal(sink.events.length, 1);
  assert.match(sink.events[0].payload.text, /unknown action "wat"/);
});

test('malformed decision: emits diagnostic without throwing', () => {
  const session = makeSession();
  const sink = collectEmit();
  dispatchConciergeAction(session, null, { emit: sink.emit });
  assert.match(sink.events[0].payload.text, /invalid decision shape/);
});
