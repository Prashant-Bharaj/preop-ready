/**
 * Build the "=== API CONTRACT ===" section for backend + frontend spawn messages.
 * Step 7d: HTTP contract from the router (paths, request/query/response shapes).
 * Backend and frontend agents read the SAME structured object — eliminates
 * field-name drift (e.g., backend sends `total_count` but frontend reads `totalCount`).
 *
 * Scope-gated: only backend + frontend see this section. Frontend gets an
 * additional note about the /api/ prefix convention. Returns null when out of
 * scope or apiContract is absent.
 */
export function buildApiContractSection(apiContract, scope) {
  if (scope !== 'backend' && scope !== 'frontend') return null;
  if (!apiContract || !Array.isArray(apiContract.endpoints) || apiContract.endpoints.length === 0) {
    return null;
  }
  const endpoints = apiContract.endpoints.map((e) => {
    const lines = [`${e.method} ${e.path}`];
    if (e.query)    lines.push(`  query:    ${JSON.stringify(e.query)}`);
    if (e.request)  lines.push(`  request:  ${JSON.stringify(e.request)}`);
    if (e.response) lines.push(`  response: ${JSON.stringify(e.response)}`);
    return lines.join('\n');
  }).join('\n\n');
  const fePathNote = scope === 'frontend'
    ? '\n\nNote: paths above are BACKEND paths (no /api/ prefix). When fetching from the frontend, prepend /api/ — e.g., backend GET /customers becomes fetch(\'/api/customers\').'
    : '';
  // Data first, prose after — observed t39 (2026-05-09): some agents
  // anchor on the first paragraph and conclude the section is "meta-text
  // with no data" if descriptive prose precedes the data, then refuse with
  // anti-fabrication. Putting the data immediately under the header and
  // moving prose to a trailing note prevents that misread.
  return (
    '=== API CONTRACT ===\n' +
    endpoints +
    '\n\n' +
    '(Endpoint paths, request fields, and response field names above are verbatim from the router — do not rename, alias, or omit.)' +
    fePathNote
  );
}
