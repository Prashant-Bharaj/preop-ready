export function buildMcpHintSection({ rules = [], snippets = [] }) {
  const lines = [
    '=== PLATFORM TOOLS (optional — on-demand) ===',
    'The primary scope rule and primary snippet for this task are already inlined above. Only call MCP tools for the SECONDARY items listed below, and only if you actually need them.',
    '',
    '- get_rules "<name>"       — fetch a specific rule file',
    '- list_snippets           — see all available snippets',
    '- get_snippet "<path>"    — fetch a specific snippet',
    '- search_snippets "<kw>"  — keyword search snippet descriptions',
    '- resolve_context         — resolve {flags, scope} to rule + snippet paths',
  ];

  if (rules.length > 0 || snippets.length > 0) {
    lines.push('');
    lines.push('=== SECONDARY RULES / SNIPPETS (fetch only if needed) ===');
    if (rules.length > 0) {
      lines.push(`Rules:    ${rules.map(r => `get_rules("${r}")`).join(', ')}`);
    }
    if (snippets.length > 0) {
      lines.push(`Snippets: ${snippets.map(s => `get_snippet("${s}")`).join(', ')}`);
    }
  }

  return lines.join('\n');
}
