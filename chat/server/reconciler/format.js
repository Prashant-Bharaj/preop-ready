/**
 * Formatting for reconciler diagnostics.
 *
 * Two outputs, both consumed by humans (in the chat session) and by smoke
 * harness assertions (literal header match).
 *
 *   - formatHardFailDiagnostic — shown when re-engage budget exhausts AND
 *     hard mismatches remain. The build is skipped.
 *   - formatSoftDeviationNote — shown when re-engage budget exhausts but
 *     all remaining mismatches are soft. The build proceeds.
 *
 * Header literals are stable contract:
 *   "[reconciler] HARD MISMATCHES"
 *   "[reconciler] SOFT DEVIATIONS"
 * Per-mismatch markers used by smoke assertions:
 *   "scope=<name>", "contract:", "actual:"
 * Don't change these without updating smoke.js.
 */

function groupByScope(mismatches) {
  const byScope = new Map();
  for (const m of mismatches) {
    const k = m.scope || 'unknown';
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push(m);
  }
  return byScope;
}

function formatOne(m) {
  const lines = [];
  const head = m.method && m.path
    ? `${m.method} ${m.path}`
    : (m.kind || 'mismatch');
  const loc = m.file
    ? `${m.file}${m.line ? ':' + m.line : ''}`
    : (m.evidence || '(no file location)');
  lines.push(`  - ${head} at ${loc}`);
  if (m.contract) lines.push(`    contract: ${m.contract}`);
  if (m.actual) lines.push(`    actual:   ${m.actual}`);
  return lines.join('\n');
}

export function formatHardFailDiagnostic(mismatches) {
  const byScope = groupByScope(mismatches);
  const out = ['[reconciler] HARD MISMATCHES - build skipped after 2 re-engage attempts.', ''];
  for (const [scope, list] of byScope) {
    out.push(`scope=${scope} (${list.length} mismatch${list.length === 1 ? '' : 'es'})`);
    for (const m of list) out.push(formatOne(m));
    out.push('');
  }
  out.push('To proceed: fix the offending file(s) by hand, then re-run /confirm.');
  return out.join('\n');
}

export function formatSoftDeviationNote(mismatches) {
  const byScope = groupByScope(mismatches);
  const out = ['[reconciler] SOFT DEVIATIONS - proceeding with build despite mismatches:', ''];
  for (const [scope, list] of byScope) {
    out.push(`scope=${scope} (${list.length} mismatch${list.length === 1 ? '' : 'es'})`);
    for (const m of list) out.push(formatOne(m));
    out.push('');
  }
  out.push('The build will proceed. Resolve these manually if they break runtime behavior.');
  return out.join('\n');
}
