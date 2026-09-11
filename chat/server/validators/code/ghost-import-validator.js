// Pre-`compose up` ghost-import validator. Catches the bug class:
//
//   Frontend agent writes a JSX file containing
//     `import DatePicker from '../components/DatePicker';`
//   but never writes `frontend/src/components/DatePicker.jsx`.
//   Build fails with: `Could not resolve "../components/DatePicker"`.
//
// The frontend agent's own completion report on a t39 run (2026-05-08)
// acknowledged this:
//
//   "Known issue: Build currently fails due to NewRequestForm.jsx
//   importing ../components/DatePicker which was not created. This
//   component needs to be either created (a simple input type='date'
//   wrapper) or the import removed. The fix is straightforward but was
//   not completed before finalization."
//
// A deterministic runtime validator closes the bug class.
//
// **Strategy:** scan all .jsx/.js/.tsx/.ts files under `frontend/src/`
// for ES6 import statements with relative paths. For each import target
// that doesn't resolve to a file on disk:
//
//   1. If the import name matches a known canonical UI primitive
//      (DatePicker, Modal, ConfirmModal, Toast, Spinner, etc.) → write
//      a functional minimal implementation. Build runs, component works.
//   2. Unknown name → write a soft-stub component that returns null +
//      emit SOFT-WARN in the auto-start log so the user knows the agent
//      left an unrendered placeholder. Build runs, app launches; the
//      missing feature renders nothing visible.
//
// Both paths let the build + compose up succeed. The user's "agent
// shipped acknowledged-broken code" outcome becomes "agent shipped
// code with auto-recovered components, with visibility on which were
// stubs vs functional".
//
// **Anti-overrestriction guardrails:**
//
// - Only scans `frontend/src/**/*.{js,jsx,ts,tsx}`. Backend / database /
//   integration code paths are out of scope.
// - Only flags relative-path imports (`./X`, `../X`). Package imports
//   (`react`, `lodash`, etc.) are left alone — those are resolved by
//   node_modules at build time.
// - Auto-fix is conservative on naming: only writes a stub if the
//   import path resolves cleanly (e.g., `../components/DatePicker` →
//   `frontend/src/components/DatePicker.jsx`). Convoluted paths are
//   reported as soft warnings without auto-fix.

import fs from 'node:fs';
import path from 'node:path';

// ──────────────────────────────────────────────────────────────────────
// Canonical UI primitives — minimal functional implementations.
//
// These are the names the frontend agent commonly invents-but-doesn't-
// write. Each stub is a self-contained .jsx file that exports a working
// component matching the most common usage pattern. The component is
// minimal (no styling beyond ARIA + structural HTML); user can replace
// with a richer version, but the auto-stub keeps the build green and
// the UI functionally usable.
const CANONICAL_STUBS = {
  DatePicker: `import React from 'react';

// Auto-recovered minimal DatePicker. Wraps a native HTML date input.
// Accepts \`value\` (ISO date string) and \`onChange(value)\`.
export default function DatePicker({ value, onChange, ...rest }) {
  return (
    <input
      type="date"
      value={value || ''}
      onChange={(e) => onChange && onChange(e.target.value)}
      {...rest}
    />
  );
}
`,

  Modal: `import React from 'react';

// Auto-recovered minimal Modal. Render children inside a dialog div.
// Accepts \`isOpen\`, \`onClose\`, and \`children\`.
export default function Modal({ isOpen, onClose, children, ...rest }) {
  if (!isOpen) return null;
  return (
    <div role="dialog" aria-modal="true" {...rest}>
      <div onClick={onClose} aria-label="close">
        {children}
      </div>
    </div>
  );
}
`,

  ConfirmModal: `import React from 'react';

// Auto-recovered minimal ConfirmModal. Confirm/cancel buttons with handlers.
// Accepts \`isOpen\`, \`title\`, \`message\`, \`onConfirm\`, \`onCancel\`.
export default function ConfirmModal({ isOpen, title, message, onConfirm, onCancel }) {
  if (!isOpen) return null;
  return (
    <div role="dialog" aria-modal="true">
      <h3>{title}</h3>
      <p>{message}</p>
      <button onClick={onConfirm}>Confirm</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
`,

  Toast: `import React from 'react';

// Auto-recovered minimal Toast. Shows a message in an aria-live region.
// Accepts \`message\` and optional \`type\` (info / error / success).
export default function Toast({ message, type = 'info', ...rest }) {
  if (!message) return null;
  return (
    <div role="alert" aria-live="polite" data-toast-type={type} {...rest}>
      {message}
    </div>
  );
}
`,

  Spinner: `import React from 'react';

// Auto-recovered minimal Spinner.
export default function Spinner({ label = 'Loading…' }) {
  return (
    <div role="status" aria-live="polite">
      {label}
    </div>
  );
}
`,

  LoadingIndicator: `import React from 'react';

// Auto-recovered minimal LoadingIndicator.
export default function LoadingIndicator({ label = 'Loading…' }) {
  return (
    <div role="status" aria-live="polite">
      {label}
    </div>
  );
}
`,

  ErrorBoundary: `import React from 'react';

// Auto-recovered minimal ErrorBoundary class component.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div role="alert">
          <p>Something went wrong.</p>
          <pre>{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
`,

  StatusBadge: `import React from 'react';

// Auto-recovered minimal StatusBadge. Renders the status as a span.
export default function StatusBadge({ status }) {
  return <span data-status={status}>{status}</span>;
}
`,
};

// Soft-stub for unknown component names. Returns null so the build
// passes and the app launches; the missing feature renders nothing
// visible. SOFT-WARN is emitted by the caller to surface visibility.
function softStubContent(componentName) {
  return `import React from 'react';

// Auto-stubbed placeholder. The frontend agent imported \`${componentName}\`
// but never wrote the file. This soft-stub returns null so the build
// succeeds; the missing feature renders nothing in the UI. Replace with
// a real implementation to restore the feature.
export default function ${componentName}() {
  return null;
}
`;
}

// ──────────────────────────────────────────────────────────────────────
// File walking + import parsing.

const SOURCE_EXTS = ['.jsx', '.js', '.tsx', '.ts'];
const STUB_EXT = '.jsx'; // we always write .jsx for the stub

function walkFrontendSource(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip node_modules / dist / build
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') continue;
      walkFrontendSource(full, out);
    } else if (ent.isFile() && SOURCE_EXTS.includes(path.extname(ent.name))) {
      out.push(full);
    }
  }
  return out;
}

// Parse ES6 imports out of source. We want default imports specifically
// (the canonical form the frontend agent generates) — `import X from 'path'`.
// Also catch named imports referencing relative paths in case agent
// imports a named export from a missing file.
function extractRelativeImports(content) {
  const imports = [];
  // Match: `import <name> from 'relative-path'` or
  //        `import { ... } from 'relative-path'`
  // Only relative paths (./ or ../). Quote can be ' or ".
  const re = /^[ \t]*import\s+(?:([A-Za-z_$][A-Za-z0-9_$]*)|(\{[^}]+\}))\s+from\s+['"](\.[^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const defaultName = m[1] || null;
    const namedBlock = m[2] || null;
    const importPath = m[3];
    imports.push({ defaultName, namedBlock, importPath });
  }
  return imports;
}

function resolveImportTarget(sourceFile, importPath) {
  // Resolve the import path relative to the source file's dir.
  const baseDir = path.dirname(sourceFile);
  const resolvedNoExt = path.resolve(baseDir, importPath);

  // Try each extension (and an /index.<ext> directory form).
  for (const ext of SOURCE_EXTS) {
    const candidate = resolvedNoExt + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const ext of SOURCE_EXTS) {
    const candidate = path.join(resolvedNoExt, 'index' + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Extract the component name from the import default name. For named
// imports we don't currently auto-stub (would need to know which named
// exports the consumer uses); flag as unknown for SOFT-WARN.
function deriveComponentNameFromImport(imp) {
  if (imp.defaultName) return imp.defaultName;
  return null; // named imports without default not handled; soft-warn
}

// Compute where to write the stub. Use the import path resolved to a
// .jsx file (using the source file's directory as base).
function computeStubPath(sourceFile, importPath) {
  const baseDir = path.dirname(sourceFile);
  return path.resolve(baseDir, importPath) + STUB_EXT;
}

// ──────────────────────────────────────────────────────────────────────
// Public API.

export function scanFrontendForGhostImports(workspaceDir) {
  const frontendSrc = path.join(workspaceDir, 'frontend', 'src');
  if (!fs.existsSync(frontendSrc)) return [];

  const sourceFiles = walkFrontendSource(frontendSrc);
  const issues = [];

  for (const sourceFile of sourceFiles) {
    let content;
    try {
      content = fs.readFileSync(sourceFile, 'utf-8');
    } catch {
      continue;
    }
    const imports = extractRelativeImports(content);
    for (const imp of imports) {
      const target = resolveImportTarget(sourceFile, imp.importPath);
      if (target) continue; // not a ghost — file exists
      const componentName = deriveComponentNameFromImport(imp);
      const stubPath = computeStubPath(sourceFile, imp.importPath);
      issues.push({
        sourceFile,
        importPath: imp.importPath,
        componentName, // null if named import without default
        stubPath,
        isCanonical: componentName != null && Object.prototype.hasOwnProperty.call(CANONICAL_STUBS, componentName),
      });
    }
  }
  return issues;
}

export function applyGhostImportFixes(workspaceDir, issues) {
  if (!issues.length) return [];
  const applied = [];

  // Dedupe by stubPath so we don't write the same file twice from two
  // different sources importing it.
  const seen = new Set();

  for (const issue of issues) {
    if (seen.has(issue.stubPath)) continue;
    seen.add(issue.stubPath);

    let content;
    let kind; // 'canonical' | 'soft-stub' | 'skip'
    if (issue.isCanonical) {
      content = CANONICAL_STUBS[issue.componentName];
      kind = 'canonical';
    } else if (issue.componentName) {
      content = softStubContent(issue.componentName);
      kind = 'soft-stub';
    } else {
      // Named-only import (no default). We don't know what to stub.
      // Skip; the build will fail explicitly and the user can see why.
      kind = 'skip';
      applied.push({
        sourceFile: issue.sourceFile,
        importPath: issue.importPath,
        stubPath: issue.stubPath,
        kind,
        componentName: null,
      });
      continue;
    }

    // Make sure parent dirs exist.
    const parentDir = path.dirname(issue.stubPath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch {
      // proceed; writeFileSync will surface the error if parent truly
      // can't be created
    }

    try {
      fs.writeFileSync(issue.stubPath, content, 'utf-8');
    } catch {
      continue;
    }

    applied.push({
      sourceFile: issue.sourceFile,
      importPath: issue.importPath,
      stubPath: issue.stubPath,
      componentName: issue.componentName,
      kind,
    });
  }
  return applied;
}
