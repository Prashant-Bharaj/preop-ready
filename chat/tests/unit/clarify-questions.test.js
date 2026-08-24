/**
 * normalizeClarifyQuestions — unit coverage.
 *
 * The shared defensive normalizer for structured clarify questions emitted by
 * the planner (two-agent.js) and concierge (handle-action.js). There's no
 * validator gate on clarify output, so this is the only thing standing between
 * a malformed LLM `questions[]` and the frontend. Covers: well-formed pass,
 * type coercion (multiSelect/allowOther defaults), label re-derivation, count
 * caps (3 questions / 4 options), min-options drop, and empty/garbage → [].
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeClarifyQuestions } from '../../server/agent/clarify-questions.js';

test('well-formed questions pass through', () => {
  const out = normalizeClarifyQuestions([
    {
      text: 'Which is closest?',
      multiSelect: false,
      allowOther: true,
      options: [{ label: 'A', text: 'One' }, { label: 'B', text: 'Two' }],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Which is closest?');
  assert.equal(out[0].multiSelect, false);
  assert.equal(out[0].allowOther, true);
  assert.deepEqual(out[0].options, [{ label: 'A', text: 'One' }, { label: 'B', text: 'Two' }]);
});

test('multiSelect defaults to false; allowOther defaults to true', () => {
  const out = normalizeClarifyQuestions([
    { text: 'Q', options: [{ text: 'a' }, { text: 'b' }] },
  ]);
  assert.equal(out[0].multiSelect, false);
  assert.equal(out[0].allowOther, true);
});

test('multiSelect only true on strict boolean true; allowOther false respected', () => {
  const out = normalizeClarifyQuestions([
    { text: 'Q', multiSelect: 'yes', allowOther: false, options: [{ text: 'a' }, { text: 'b' }] },
  ]);
  assert.equal(out[0].multiSelect, false); // 'yes' is not === true
  assert.equal(out[0].allowOther, false);
});

test('labels are re-derived sequentially A,B,C,D regardless of input labels', () => {
  const out = normalizeClarifyQuestions([
    { text: 'Q', options: [{ label: 'X', text: 'a' }, { label: 'Z', text: 'b' }, { label: 'Q', text: 'c' }] },
  ]);
  assert.deepEqual(out[0].options.map(o => o.label), ['A', 'B', 'C']);
});

test('options are capped at 4', () => {
  const out = normalizeClarifyQuestions([
    { text: 'Q', options: [1, 2, 3, 4, 5, 6].map(n => ({ text: `o${n}` })) },
  ]);
  assert.equal(out[0].options.length, 4);
  assert.deepEqual(out[0].options.map(o => o.label), ['A', 'B', 'C', 'D']);
});

test('questions are capped at 5', () => {
  const out = normalizeClarifyQuestions(
    [1, 2, 3, 4, 5, 6, 7].map(n => ({ text: `Q${n}`, options: [{ text: 'a' }, { text: 'b' }] })),
  );
  assert.equal(out.length, 5);
});

test('questions with fewer than 2 valid options are dropped', () => {
  const out = normalizeClarifyQuestions([
    { text: 'only one', options: [{ text: 'a' }] },
    { text: 'blank options', options: [{ text: '' }, { text: '   ' }] },
    { text: 'good', options: [{ text: 'a' }, { text: 'b' }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'good');
});

test('questions with empty/missing text are dropped', () => {
  const out = normalizeClarifyQuestions([
    { text: '   ', options: [{ text: 'a' }, { text: 'b' }] },
    { options: [{ text: 'a' }, { text: 'b' }] },
  ]);
  assert.equal(out.length, 0);
});

test('non-array / null / garbage input returns []', () => {
  assert.deepEqual(normalizeClarifyQuestions(undefined), []);
  assert.deepEqual(normalizeClarifyQuestions(null), []);
  assert.deepEqual(normalizeClarifyQuestions('nope'), []);
  assert.deepEqual(normalizeClarifyQuestions([null, 42, 'x', {}]), []);
});

test('whitespace in text and option text is trimmed', () => {
  const out = normalizeClarifyQuestions([
    { text: '  Q  ', options: [{ text: '  a  ' }, { text: 'b' }] },
  ]);
  assert.equal(out[0].text, 'Q');
  assert.equal(out[0].options[0].text, 'a');
});
