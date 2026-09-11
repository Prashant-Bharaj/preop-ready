/**
 * Build the "=== DATA MODEL ===" section for database + backend spawn messages.
 * Step 7d: schema contract from the router. Database and backend agents read
 * the SAME structured object — mechanical agreement at the source replaces
 * implicit prose-based re-derivation that caused t31 / t33 schema-drift crashes.
 *
 * Scope-gated: only database + backend see this section (frontend doesn't need
 * the schema). Returns null when scope is out of bounds OR dataModel is absent —
 * caller skips pushing the section.
 */
export function buildDataModelSection(dataModel, scope) {
  if (scope !== 'database' && scope !== 'backend') return null;
  if (!dataModel || !Array.isArray(dataModel.tables) || dataModel.tables.length === 0) {
    return null;
  }
  const tables = dataModel.tables.map((t) => {
    const cols = (t.columns || [])
      .filter((c) => c && c.name && c.type)
      .map((c) => `  - ${c.name} ${c.type}`)
      .join('\n');
    return `Table ${t.name}:\n${cols}`;
  }).join('\n\n');
  // Data first, prose after — see API CONTRACT note for rationale.
  return (
    '=== DATA MODEL ===\n' +
    tables +
    '\n\n' +
    '(Column names and types above are verbatim from the router — do not rename, retype, or omit. If you have a strong local reason to deviate, document it under a `Schema deviations:` heading in your completion report.)'
  );
}
