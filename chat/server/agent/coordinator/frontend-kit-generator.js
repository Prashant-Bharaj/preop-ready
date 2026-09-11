/**
 * frontend-kit-generator.js — stages the pre-built UI kit into
 * `frontend/src/generated/kit/` (write-locked via the generated/ directory
 * rule) and produces the compact catalog injected into the frontend spawn.
 *
 * Why: every fresh build previously spent ~40% of the frontend agent's time
 * regenerating the same ~10 UI primitives (Button, Input, Card, Table,
 * Dialog, Toast, ...) from scratch — slightly different and inconsistently
 * styled each time. The kit is authored once in
 * `server/agent/coordinator/frontend-kit/` (real .tsx files, reviewable),
 * copied verbatim at pre-stage, and the agent only composes pages from it.
 *
 * The kit's full source is ~1200 lines — deliberately NOT inlined into the
 * spawn message. The catalog below tells the agent what exists and how to
 * import it; `read_file` is available when it needs details.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_SRC_DIR = path.join(__dirname, 'frontend-kit');
const KIT_DEST_REL = 'frontend/src/generated/kit';

/**
 * Extract the kit's type declarations + export signatures VERBATIM from the
 * .tsx sources. Motivation (type-error taxonomy, 2026-07-21): ~150-200
 * type-gate errors per bench window were agents GUESSING kit prop shapes —
 * the hand-written catalog summaries had drifted from the source (e.g. it
 * omitted ConfirmDialog's title/confirmLabel/danger). Verbatim extraction
 * cannot drift, and it describes rather than restricts: agents still
 * compose freely, they just stop guessing.
 */
function extractKitTypes() {
  const sections = [];
  let files;
  try {
    files = fs.readdirSync(KIT_SRC_DIR).filter((f) => f.endsWith('.tsx') || f === 'index.ts');
  } catch {
    return null;
  }
  const captureBlock = (src, startIdx) => {
    // Capture from startIdx to the matching close of the first '{' (or to
    // end-of-statement for brace-less aliases like `type Kind = 'a' | 'b';`).
    const braceAt = src.indexOf('{', startIdx);
    const semiAt = src.indexOf(';', startIdx);
    const nlAt = src.indexOf('\n', startIdx);
    if (braceAt === -1 || (semiAt !== -1 && semiAt < braceAt && semiAt <= (nlAt === -1 ? Infinity : nlAt))) {
      return src.slice(startIdx, semiAt === -1 ? nlAt : semiAt + 1);
    }
    let depth = 0;
    for (let i = braceAt; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
    }
    return src.slice(startIdx, nlAt === -1 ? src.length : nlAt);
  };
  for (const name of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(KIT_SRC_DIR, name), 'utf-8');
    } catch {
      continue;
    }
    const decls = [];
    // Top-level type/interface declarations (exported or not — non-exported
    // ones like Toast's ToastFn still shape the hook's return type).
    for (const m of src.matchAll(/^(?:export\s+)?(?:type|interface)\s+\w+[^\n{;=]*[{=]?/gm)) {
      decls.push(captureBlock(src, m.index));
    }
    // Export signatures with inline prop types (params up to the body `{`).
    for (const m of src.matchAll(/^export\s+(?:function|const)\s+\w+/gm)) {
      const sigEnd = src.indexOf(')', m.index);
      if (sigEnd === -1) continue;
      // Extend through nested parens/braces of destructured+typed params.
      let depth = 0; let i = src.indexOf('(', m.index);
      if (i === -1 || i - m.index > 200) continue;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) break; }
      }
      const sig = src.slice(m.index, i + 1).trim();
      if (sig.length < 400) decls.push(sig);
    }
    if (decls.length) sections.push(`--- ${name} ---\n${decls.join('\n')}`);
  }
  return sections.length ? sections.join('\n\n') : null;
}

const kitTypesSection = (() => {
  const types = extractKitTypes();
  if (!types) return '';
  return [
    '',
    '=== KIT PROP TYPES (extracted verbatim from source — AUTHORITATIVE) ===',
    'Use these exact prop names/shapes. When unsure, prefer these over the',
    'summaries above; read the component file for behavior.',
    '',
    types,
    '',
    'Annotated example (DataTable — the most-misused component):',
    '  const columns: Column<Deviation>[] = [',
    "    { header: 'Severity', cell: (row) => <Badge kind=\"warning\">{row.severity}</Badge>, width: '10rem' },",
    "    { header: 'Description', cell: (row) => row.description },",
    '  ];',
    '  <DataTable columns={columns} rows={deviations} rowKey={(row) => row.id} emptyMessage="No deviations yet" />',
    '=== END KIT PROP TYPES ===',
  ].join('\n');
})();

export const KIT_CATALOG = [
  '=== UI KIT (pre-staged, write-locked) ===',
  '',
  `A complete, styled component kit is staged at \`${KIT_DEST_REL}/\`.`,
  "Import everything from the barrel: `import { Button, Card, ... } from '../generated/kit';`",
  '(adjust the relative path to where your file lives). Importing the barrel',
  'also loads the design tokens (tokens.css) — do not write your own reset,',
  'color palette, or component CSS for these concerns.',
  '',
  'Components (props in parentheses):',
  '- AppShell(title, nav, headerRight, children) — the app frame: header + nav + centered content + toasts mounted. Wrap your app in it (inside ErrorBoundary). Use NavLink(active, onClick) for nav entries.',
  '- Button(variant: primary|secondary|danger|ghost, size: sm|md, loading, ...button props)',
  '- Input / Textarea / Select — styled form controls (native props)',
  '- FormField(label, required, error, hint) — wrap EVERY form control; render validation errors through `error`',
  '- Card / CardHeader(title, subtitle, actions) / CardContent',
  '- DataTable(columns: [{header, cell(row), width?}], rows, rowKey, emptyMessage) — use for every list/table',
  '- Dialog(open, title, onClose, footer) and ConfirmDialog(open, message, onConfirm, onCancel) — REQUIRED before destructive actions',
  '- useToast() → toast(message, "success"|"error"|"info") — available inside AppShell',
  '- Alert(kind: info|success|warning|danger, title) and Badge(kind)',
  '- EmptyState(title, hint, action) — render whenever a list/query is empty',
  '- MarkdownText(text) — render EVERY AI-generated answer through this (never as plain text)',
  '- FileDropzone(accept, multiple, onFiles) — file uploads with drag-and-drop',
  '- Spinner(size)',
  '',
  'Rules:',
  '- Do NOT create your own components/ui/ primitives (Button, Modal, Toast, Table, Spinner, ...) — the kit versions are the only allowed implementation.',
  '- Do NOT re-implement toasts, empty states, confirm dialogs, or markdown rendering.',
  '- App-specific components (forms, page sections, domain widgets) compose kit primitives.',
  '- Form inputs and URL params yield STRINGS; contract ids/quantities are numbers — coerce (`Number(value)`) before calling the api-client or comparing against contract types.',
  '',
  '=== END UI KIT ===',
].join('\n') + kitTypesSection;

/**
 * Copy the kit into the workspace. Returns the list of staged relPaths, or
 * null when the kit source dir is missing (never blocks a build).
 */
export function stageFrontendKit(workspaceDir) {
  try {
    if (!fs.existsSync(KIT_SRC_DIR)) return null;
    const destDir = path.join(workspaceDir, KIT_DEST_REL);
    fs.mkdirSync(destDir, { recursive: true });
    const staged = [];
    for (const name of fs.readdirSync(KIT_SRC_DIR)) {
      const src = path.join(KIT_SRC_DIR, name);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(destDir, name));
      staged.push(`${KIT_DEST_REL}/${name}`);
    }
    return staged.length ? staged : null;
  } catch {
    return null;
  }
}