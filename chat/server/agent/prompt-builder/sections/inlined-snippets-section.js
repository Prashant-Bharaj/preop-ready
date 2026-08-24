export function buildInlinedSnippetsSection(snippets) {
  const lines = [
    '=== PRIMARY SNIPPETS (already loaded — do NOT re-fetch) ===',
    'These are the snippets the router committed to as this task\'s scaffold. Use them directly — do NOT call get_snippet() for any path below.',
    '',
  ];
  for (const { path: p, content } of snippets) {
    lines.push(`--- ${p} ---`);
    lines.push(content.trim());
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
