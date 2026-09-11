/**
 * dispatchConciergeAction — structured clarify questions wire path.
 *
 * Asserts the concierge dispatcher attaches NORMALIZED structured questions to
 * the emitted concierge_text event on a `clarify` decision, and degrades to a
 * plain { text } payload when there are no usable questions. Uses the injectable
 * deps.emit — no IO, no LLM, deterministic pass/fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchConciergeAction } from '../../server/agent/concierge/handle-action.js';

function capture() {
  const events = [];
  return { emit: (e) => events.push(e), events };
}

test('clarify with structured questions emits normalized questions payload', () => {
  const { emit, events } = capture();
  dispatchConciergeAction(
    { id: 's1' },
    {
      action: 'clarify',
      response: 'How should notifications work?',
      questions: [
        {
          text: 'Which channels?',
          multiSelect: true,
          options: [{ label: 'X', text: 'Email' }, { label: 'Y', text: 'In-app' }],
        },
      ],
    },
    { emit },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'concierge_text');
  assert.equal(events[0].payload.text, 'How should notifications work?');
  assert.equal(events[0].payload.questions.length, 1);
  const q = events[0].payload.questions[0];
  assert.equal(q.multiSelect, true);
  assert.equal(q.allowOther, true); // defaulted
  // labels re-derived sequentially by the shared normalizer
  assert.deepEqual(q.options.map(o => o.label), ['A', 'B']);
});

test('clarify without usable questions degrades to plain text payload', () => {
  const { emit, events } = capture();
  dispatchConciergeAction(
    { id: 's1' },
    { action: 'clarify', response: 'Can you say more about what you want?' },
    { emit },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'concierge_text');
  assert.deepEqual(events[0].payload, { text: 'Can you say more about what you want?' });
  assert.ok(!('questions' in events[0].payload));
});

test('clarify drops malformed questions (single-option) and falls back to text', () => {
  const { emit, events } = capture();
  dispatchConciergeAction(
    { id: 's1' },
    {
      action: 'clarify',
      response: 'Pick one',
      questions: [{ text: 'Only one option', options: [{ text: 'lonely' }] }],
    },
    { emit },
  );
  assert.deepEqual(events[0].payload, { text: 'Pick one' });
});

test('respond never carries questions even if present', () => {
  const { emit, events } = capture();
  dispatchConciergeAction(
    { id: 's1' },
    {
      action: 'respond',
      response: 'Auth uses ALB OIDC.',
      questions: [{ text: 'x', options: [{ text: 'a' }, { text: 'b' }] }],
    },
    { emit },
  );
  assert.deepEqual(events[0].payload, { text: 'Auth uses ALB OIDC.' });
});
