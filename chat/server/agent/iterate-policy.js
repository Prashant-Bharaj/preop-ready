/**
 * iterate-policy.js — the minimal-change policy appended to every iterate /
 * fix dispatch spawn message.
 *
 * Why this exists (observed live): a two-field rename fix dispatched to the
 * frontend scope regenerated EVERY component from the contract snapshot —
 * one 19-minute turn, 287k chars, truncated at the completion cap, and it
 * dropped a page that had been added by a later iterate (the snapshot
 * predated it). The soft "files not mentioned remain as-is" phrasing in the
 * diffs block was not enough; this block makes minimal change an explicit,
 * checkable rule.
 *
 * Shared by phase-tools.js (build-dispatcher iterate path) and
 * session/routes.js (single-scope direct dispatch path).
 */

export const ITERATE_MINIMAL_CHANGE_POLICY = [
  '=== ITERATE MINIMAL-CHANGE POLICY ===',
  '',
  'This dispatch modifies an EXISTING, WORKING app. It is not a rebuild.',
  '',
  '- Read the current files before writing. The code on disk is the source',
  '  of truth for everything outside the iteration intent — it may contain',
  '  features added AFTER the contract snapshot you were given. The contract',
  '  tells you what to ADD or CHANGE, never what to delete.',
  '- Modify ONLY the files the intent requires. A typical iterate touches',
  '  1-4 files. Do NOT regenerate components, routes, pages, or styles you',
  '  were not asked to change.',
  '- Prefer targeted `replace_in_file` edits over rewriting an existing file',
  '  with `write_to_file`.',
  '- Removing an existing feature (a nav entry, page, route, endpoint, or',
  '  column) is a REGRESSION unless the intent explicitly asks for removal.',
  '',
  '=== END ITERATE MINIMAL-CHANGE POLICY ===',
].join('\n');