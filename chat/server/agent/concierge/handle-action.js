/**
 * Concierge action dispatcher.
 *
 * The concierge LLM emits a JSON decision per user turn (see
 * chat/prompts/concierge.md). This module turns that decision into the
 * actual runtime side effect:
 *
 *   respond / clarify  → emit a concierge_text event with the LLM's reply
 *   add_to_todo        → append to session.todoList + emit an acknowledgment
 *   dispatch_iterate   → DEFERRED for v1: emit a polite decline. Iterate-
 *                        mode planner wiring is a follow-on segment (see
 *                        the segment plan / checkpoint Section 9). The
 *                        concierge prompt still emits this action; runtime
 *                        just declines for now.
 *   interrupt          → DEFERRED for v1: same as dispatch_iterate.
 *   diagnose           → mid-build only: the app isn't running yet, so there
 *                        are no runtime logs to investigate. Emit a polite
 *                        decline. (Post-build, diagnose is handled by the
 *                        sequencer in routes.js, not here.)
 *   multi              → recurse through sub_actions sequentially.
 *
 * Events emitted carry type='concierge_text' with payload={text} (a clarify
 * decision may also carry payload.questions for structured choice cards). The
 * frontend handler (ChatScreen) renders them as top-of-thread assistant
 * bubbles, separate from the cline subagent stream.
 *
 * Public surface: dispatchConciergeAction(session, decision, deps?).
 *   - Pure dispatcher (no IO beyond emit + session.todoList mutation).
 *   - `deps.emit` is injectable for unit testing; default uses appendEvent
 *     + sessionEvents.emit (same channel build-dispatcher uses).
 */

import { randomUUID } from 'node:crypto';
import { appendEvent } from '../../session/transcript.js';
import { sessionEvents } from '../../session/events.js';
import { tlog } from '../../util/timestamped-log.js';
import { normalizeClarifyQuestions } from '../clarify-questions.js';

const DEFERRED_DISPATCH_ITERATE_TEXT =
  "I can't dispatch a new iteration while a build is in progress yet. "
  + 'Please wait for the current build to finish, then send your request.';

const DEFERRED_INTERRUPT_TEXT =
  "I can't interrupt an in-flight build yet. The build will finish first; "
  + 'please resend any redirect after.';

const DEFERRED_DIAGNOSE_TEXT =
  "I can't investigate runtime errors while the build is still in progress — "
  + "the app isn't running yet. Once it's built, tell me what's not working and "
  + "I'll dig into the logs.";

const VALID_ACTIONS = new Set([
  'respond', 'clarify', 'add_to_todo', 'dispatch_iterate',
  'interrupt', 'diagnose', 'multi', 'show_trace',
]);

/**
 * @param {object} session  the session record (needs .id; .todoList mutated for add_to_todo)
 * @param {{action: string, [field: string]: any}} decision  concierge JSON output
 * @param {{emit?: (event: {type: string, payload: object}) => void}} [deps]
 */
export function dispatchConciergeAction(session, decision, deps = {}) {
  const emit = deps.emit || makeDefaultEmit(session.id);

  if (!decision || typeof decision !== 'object' || typeof decision.action !== 'string') {
    emit({ type: 'concierge_text', payload: { text: '(concierge: invalid decision shape)' } });
    return;
  }

  switch (decision.action) {
    case 'respond': {
      const text = typeof decision.response === 'string' ? decision.response : '';
      emit({ type: 'concierge_text', payload: { text } });
      return;
    }

    case 'clarify': {
      const text = typeof decision.response === 'string' ? decision.response : '';
      // A clarify decision MAY carry structured single/multi-select questions —
      // the frontend renders them as cards. Absent/empty → plain prose reply.
      const questions = normalizeClarifyQuestions(decision.questions);
      const payload = questions.length ? { text, questions } : { text };
      emit({ type: 'concierge_text', payload });
      return;
    }

    case 'add_to_todo': {
      const todoText = typeof decision.todo_item === 'string' ? decision.todo_item.trim() : '';
      if (!todoText) {
        emit({ type: 'concierge_text', payload: { text: '(concierge: add_to_todo without todo_item — skipped)' } });
        return;
      }
      if (!Array.isArray(session.todoList)) session.todoList = [];
      session.todoList.push({
        id: randomUUID().slice(0, 8),
        added_at: Date.now(),
        text: todoText,
      });
      tlog('[concierge] add_to_todo: session=%s text=%s (list size=%d)',
        session.id, todoText.slice(0, 80), session.todoList.length);
      const ack = typeof decision.response === 'string' && decision.response.trim()
        ? decision.response
        : `Added to your todo list: "${todoText}".`;
      emit({ type: 'concierge_text', payload: { text: ack } });
      return;
    }

    case 'dispatch_iterate': {
      const summary = typeof decision.iterate_summary === 'string' && decision.iterate_summary.trim()
        ? ` ("${decision.iterate_summary}")`
        : '';
      tlog('[concierge] dispatch_iterate DEFERRED for session=%s%s', session.id, summary);
      emit({
        type: 'concierge_text',
        payload: { text: DEFERRED_DISPATCH_ITERATE_TEXT },
      });
      return;
    }

    case 'interrupt': {
      tlog('[concierge] interrupt DEFERRED for session=%s reason=%s',
        session.id,
        typeof decision.interrupt_reason === 'string' ? decision.interrupt_reason.slice(0, 80) : 'n/a');
      emit({
        type: 'concierge_text',
        payload: { text: DEFERRED_INTERRUPT_TEXT },
      });
      return;
    }

    case 'diagnose': {
      // Mid-build only (post-build diagnose is handled by the sequencer in
      // routes.js). The app isn't running during a build, so there's nothing
      // to investigate — decline politely.
      tlog('[concierge] diagnose DEFERRED mid-build for session=%s', session.id);
      emit({
        type: 'concierge_text',
        payload: { text: DEFERRED_DIAGNOSE_TEXT },
      });
      return;
    }

    case 'multi': {
      const subs = Array.isArray(decision.sub_actions) ? decision.sub_actions : [];
      for (const sub of subs) {
        dispatchConciergeAction(session, sub, deps);
      }
      return;
    }

    case 'show_trace': {
      const summary = typeof decision.trace_summary === 'string' && decision.trace_summary.trim()
        ? decision.trace_summary
        : 'No module trace available for this build.';
      tlog('[concierge] show_trace for session=%s', session.id);
      emit({ type: 'concierge_text', payload: { text: summary } });
      return;
    }

    default: {
      emit({
        type: 'concierge_text',
        payload: { text: `(concierge: unknown action "${decision.action}")` },
      });
      return;
    }
  }
}

function makeDefaultEmit(sessionId) {
  return (event) => {
    const stored = appendEvent(sessionId, event.type, event.payload);
    sessionEvents.emit('event', sessionId, stored);
  };
}
