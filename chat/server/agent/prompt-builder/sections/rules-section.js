export function buildRulesSection(context) {
  const lines = ['=== RELEVANT RULES (follow these strictly) ==='];

  for (const [file, content] of Object.entries(context.rulesContent)) {
    lines.push(`--- ${file} ---`);
    lines.push(content.trim());
    lines.push('');
  }

  return lines.join('\n');
}
