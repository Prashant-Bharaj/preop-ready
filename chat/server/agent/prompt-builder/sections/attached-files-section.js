/**
 * Build the "=== ATTACHED FILES ===" section that goes into the Cline prompt.
 * Cline already knows how to read context/ via get_rules("ai-file-input");
 * we just need to tell it WHICH files the user just attached and give it a
 * short preview so it can decide whether to read the whole file or not.
 */
export function buildAttachedFilesSection(uploads) {
  if (!Array.isArray(uploads) || uploads.length === 0) return '';
  const lines = [
    '=== ATTACHED FILES ===',
    'The user attached these files to this turn. They live in the workspace under context/ and are gitignored.',
    'Read them with your file tools when relevant — previews below are short excerpts, not the full content.',
    '',
  ];
  for (const u of uploads) {
    const summary = u?.parsed?.summary || `${u?.mime || 'file'}, ${u?.size || 0} bytes`;
    lines.push(`- ${u.relativePath} — ${summary}`);
  }
  // Include previews for text-ish files so small docs are immediately usable
  // without Cline needing a separate read_file tool call. Cap per-file preview.
  const PREVIEW_CAP = 1500;
  const hasPreviews = uploads.some((u) => u?.parsed?.preview && !u.mime?.startsWith('image/'));
  if (hasPreviews) {
    lines.push('');
    lines.push('Preview excerpts:');
    for (const u of uploads) {
      const p = u?.parsed?.preview;
      if (!p || u.mime?.startsWith('image/')) continue;
      lines.push('');
      lines.push(`--- ${u.relativePath} ---`);
      lines.push(p.length > PREVIEW_CAP ? p.slice(0, PREVIEW_CAP) + '\n…(truncated — read the file for full content)' : p);
    }
  }
  return lines.join('\n');
}
