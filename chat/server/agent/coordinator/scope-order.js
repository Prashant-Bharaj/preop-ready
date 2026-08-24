/**
 * Canonical subagent dispatch order. Used by build-dispatcher.js and any
 * future test that asserts dispatch ordering. The orchestrator prompt's
 * Rule 3 ("default: database → backend in parallel → integration") + Section 4
 * scope-ordering ("database → vectordb → backend → frontend → integration")
 * are codified here so the same ordering used to be LLM-encoded in the prompt
 * is now LLM-free.
 *
 * Filtered against the contract's tasks[] to skip scopes not present in a
 * given build. Iterate mode filters further to affected_scopes.
 */

export const CANONICAL_SCOPE_ORDER = Object.freeze([
  'database',
  'vectordb',
  'backend',
  'frontend',
  'integration',
]);
