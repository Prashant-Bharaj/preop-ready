// Shared defensive normalizer for structured clarify questions.
//
// Both the planner (two-agent.js Understanding agent) and the post-build
// concierge (handle-action.js) can emit a `questions[]` array on a `clarify`
// turn. There is no schema/validator gate on clarify output, so we shape it
// here before it reaches the frontend: drop malformed items, cap counts, coerce
// types, re-derive sequential A/B/C/D labels. Returns [] when there's nothing
// usable — the frontend then falls back to parsing the prose message.

const MAX_QUESTIONS = 5; // per round — adaptive-depth ceiling; guards against runaway output
const MAX_OPTIONS = 4;   // per question — frontend labels are A–D
const MIN_OPTIONS = 2;   // a question needs at least two choices to be meaningful

export function normalizeClarifyQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const text = typeof q.text === 'string' ? q.text.trim() : '';
    if (!text) continue;

    const rawOpts = Array.isArray(q.options) ? q.options : [];
    const options = [];
    for (const o of rawOpts) {
      if (!o || typeof o !== 'object') continue;
      const optText = typeof o.text === 'string' ? o.text.trim() : '';
      if (!optText) continue;
      // Re-derive labels from position so they're always sequential A, B, C, D.
      const label = String.fromCharCode('A'.charCodeAt(0) + options.length);
      options.push({ label, text: optText });
      if (options.length >= MAX_OPTIONS) break;
    }
    if (options.length < MIN_OPTIONS) continue;

    out.push({
      text,
      multiSelect: q.multiSelect === true,
      allowOther: q.allowOther !== false, // default true
      options,
    });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}
