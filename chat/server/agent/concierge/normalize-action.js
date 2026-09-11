/**
 * Concierge decision normalizer.
 *
 * The concierge prompt can emit `multi` (nested sub-actions) and
 * `interrupt` (with an `interrupt_then` follow-up). Both are awkward to
 * dispatch directly in routes.js — `multi` is recursive, and `interrupt`
 * semantics depend on what's actually in flight (post-build has nothing
 * to interrupt, so the interrupt collapses to whatever its `_then` was
 * going to do anyway).
 *
 * This normalizer flattens any decision into a list of ATOMIC actions —
 * `respond`, `clarify`, `add_to_todo`, `dispatch_iterate`, `diagnose` (or
 * whatever unknown action the LLM emitted, which the caller can choose to
 * fall through to the planner on). After normalization:
 *
 *   - `multi` → recursively flattened (sub_actions become top-level)
 *   - `interrupt` with `interrupt_then: 'iterate'` → `dispatch_iterate`
 *     (interrupt_reason used as iterate_user_message; iterate_summary
 *     preserved if set, else falls back to interrupt_reason)
 *   - `interrupt` with `interrupt_then: 'abort' | 'wait' | undefined`
 *     → `respond` (no in-flight build to actually stop; ack the user)
 *   - everything else → returned as-is in a single-element list
 *
 * Pure function — no side effects, easily unit-testable. Caller is
 * responsible for the dispatch logic.
 */

/**
 * Flatten a concierge decision into a list of atomic actions.
 *
 * @param {object} decision - the parsed concierge decision JSON
 * @returns {Array<{action: string, [field: string]: any}>} flat list
 */
export function normalizeConciergeDecision(decision) {
  if (!decision || typeof decision !== 'object' || typeof decision.action !== 'string') {
    return [];
  }

  if (decision.action === 'multi') {
    const subs = Array.isArray(decision.sub_actions) ? decision.sub_actions : [];
    return subs.flatMap(normalizeConciergeDecision);
  }

  if (decision.action === 'interrupt') {
    if (decision.interrupt_then === 'iterate') {
      // No in-flight build to actually interrupt in the post-build path
      // (status was 'idle' when this turn started). Collapse to a regular
      // dispatch_iterate. iterate_summary may already be set per the
      // prompt's §4 example; if not, the interrupt_reason becomes the
      // change description.
      return [{
        action: 'dispatch_iterate',
        iterate_summary: decision.iterate_summary
          || decision.interrupt_reason
          || '(user redirect)',
        iterate_user_message: decision.interrupt_reason || '',
        response: typeof decision.response === 'string' ? decision.response : null,
      }];
    }
    // interrupt_then ∈ { 'abort', 'wait', undefined }: nothing to actually
    // stop. Translate to a respond so the user sees an acknowledgement
    // instead of silent inaction.
    const text = (typeof decision.response === 'string' && decision.response.trim())
      ? decision.response
      : `(${decision.interrupt_then || 'noop'}: ${decision.interrupt_reason || 'acknowledged'})`;
    return [{ action: 'respond', response: text }];
  }

  // Atomic action — respond, clarify, add_to_todo, dispatch_iterate,
  // diagnose, or anything else the LLM emitted. Pass through unchanged.
  return [decision];
}
