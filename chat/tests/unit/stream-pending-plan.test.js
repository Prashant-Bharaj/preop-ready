/**
 * history_batch carries the pending plan so a reload restores the confirm card.
 *
 * Module under test:
 *   chat/server/util/stream.js (pendingPlanFromHistory)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pendingPlanFromHistory } from '../../server/util/stream.js';

const preview1 = { type: 'plan_preview', payload: { message: 'first', tasks: [{ scope: 'backend' }] } };
const preview2 = { type: 'plan_preview', payload: { message: 'revised', tasks: [{ scope: 'backend' }, { scope: 'frontend' }] } };
const events = [{ type: 'user_message' }, preview1, { type: 'status', payload: { status: 'idle' } }, preview2, { type: 'status', payload: { status: 'idle' } }];

test('returns the LAST plan_preview payload while the session still holds a plan', () => {
  assert.deepEqual(pendingPlanFromHistory(events, true), preview2.payload);
});

test('null once the plan was resolved, when there is no preview, or on bad input', () => {
  assert.equal(pendingPlanFromHistory(events, false), null);
  assert.equal(pendingPlanFromHistory([{ type: 'user_message' }], true), null);
  assert.equal(pendingPlanFromHistory(null, true), null);
});
