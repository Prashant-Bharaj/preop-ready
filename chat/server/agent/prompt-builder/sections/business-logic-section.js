/**
 * Build the "=== BUSINESS LOGIC CONTRACT ===" section for backend + integration spawn messages.
 * Track A (A2): event-driven behaviors (triggers), invariants (rules), and
 * implicit non-response changes (side_effects) from the router. Backend agent
 * reads the SAME structured object so behaviors don't get re-derived from prose
 * (e.g., the router says "send welcome email on signup" → backend reliably
 * implements it instead of inventing a different trigger surface).
 *
 * Scope-gated: backend + integration. Returns null when out of scope or
 * businessLogicContract is absent / empty.
 */
export function buildBusinessLogicSection(businessLogicContract, scope) {
  if (scope !== 'backend' && scope !== 'integration') return null;
  if (!businessLogicContract || typeof businessLogicContract !== 'object') return null;
  const triggers = Array.isArray(businessLogicContract.triggers) ? businessLogicContract.triggers : [];
  const rules = Array.isArray(businessLogicContract.rules) ? businessLogicContract.rules : [];
  const sideEffects = Array.isArray(businessLogicContract.side_effects) ? businessLogicContract.side_effects : [];
  if (triggers.length === 0 && rules.length === 0 && sideEffects.length === 0) return null;

  const lines = [];
  if (triggers.length > 0) {
    const tr = triggers
      .filter((t) => t && typeof t.event === 'string' && typeof t.action === 'string')
      .map((t) => `  - on ${t.event}${t.condition ? ` [${t.condition}]` : ''} → ${t.action}`)
      .join('\n');
    if (tr) lines.push(`Triggers:\n${tr}`);
  }
  if (rules.length > 0) {
    const rs = rules.filter((r) => typeof r === 'string').map((r) => `  - ${r}`).join('\n');
    if (rs) lines.push(`Rules:\n${rs}`);
  }
  if (sideEffects.length > 0) {
    const ss = sideEffects.filter((s) => typeof s === 'string').map((s) => `  - ${s}`).join('\n');
    if (ss) lines.push(`Side effects:\n${ss}`);
  }
  if (lines.length === 0) return null;

  // Data first, prose after — see API CONTRACT note for rationale.
  return (
    '=== BUSINESS LOGIC CONTRACT ===\n' +
    lines.join('\n\n') +
    '\n\n' +
    '(Triggers, rules, and side-effects above are from the router. Every entry must be reflected in produced code; do not silently drop or rephrase.)'
  );
}
