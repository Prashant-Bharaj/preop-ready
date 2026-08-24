/**
 * Build the "=== UI CONTRACT ===" section for frontend spawn messages.
 * Track A (A1): user-facing UI structure from the router — primary_view,
 * primary_action, secondary_views[], components[]. Frontend agent reads the
 * SAME structured object and produces components/files matching these names,
 * eliminating the prose-derived component-naming drift class (frontend agent
 * inventing layouts not implied by the user prompt).
 *
 * Scope-gated: frontend only. Returns null when out of scope or uiContract
 * is absent.
 */
export function buildUiContractSection(uiContract, scope) {
  if (scope !== 'frontend') return null;
  if (!uiContract || typeof uiContract.primary_view !== 'string' || typeof uiContract.primary_action !== 'string') {
    return null;
  }
  const lines = [
    `Primary view: ${uiContract.primary_view}`,
    `Primary action: ${uiContract.primary_action}`,
  ];
  if (Array.isArray(uiContract.secondary_views) && uiContract.secondary_views.length > 0) {
    lines.push(`Secondary views: ${uiContract.secondary_views.join(', ')}`);
  }
  if (Array.isArray(uiContract.components) && uiContract.components.length > 0) {
    const components = uiContract.components
      .filter(c => c && typeof c.name === 'string')
      .map(c => `  - ${c.name}: ${c.role || ''}`.trimEnd())
      .join('\n');
    if (components) lines.push(`Components:\n${components}`);
  }
  // Data first, prose after — see API CONTRACT note for rationale.
  return (
    '=== UI CONTRACT ===\n' +
    lines.join('\n') +
    '\n\n' +
    '(View names, primary action, and component names above are verbatim from the router — produce components/files matching these names. They are user-language names; translate to JSX while keeping the names, do not invent additional top-level pieces.)'
  );
}
