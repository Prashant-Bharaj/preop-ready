/**
 * component-stub-generator.js — emits empty React component shells for
 * every `ui_contract.components[i]`. Subagent fills in the JSX body.
 *
 * One file per component at `frontend/src/components/<Name>.tsx`, each
 * with:
 *   - A doc comment quoting the contract `role` (the behavior hint).
 *   - A named exported function `<Name>(props: <Name>Props)` matching the
 *     contracts.ts emitter convention.
 *   - A `// TODO: implement` marker inside a `<div>` placeholder.
 *
 * Kills the ghost-import failure pattern: the import path is guaranteed
 * to resolve at the moment the LLM writes its JSX. The named export
 * is locked so the LLM can't rename the component.
 */

// Visual framing of the stub header has measurable behavioral impact on
// the subagent. The original `// AUTO-GENERATED stub — Generated <ISO>`
// header pattern-matched in the LLM's training data to AUTO-GENERATED-
// DO-NOT-EDIT conventions; the frontend agent then re-wrote the stub
// contents back into disk unchanged ("preserve this auto-generated
// file") and claimed `complete` while every component still rendered
// `<div>Name (stub)</div>`. The header below uses the same anti-fake-
// PASS framing as routes.ts (see route-stub-generator.js) — directive
// verbs, no "Generated <timestamp>" line, explicit "EDIT THIS FILE".
const HEADER_BLOCK = (name) => [
  '// =====================================================================',
  `// THIS FILE IS A SCAFFOLD — YOU MUST EDIT IT.`,
  '// =====================================================================',
  `// The body of \`${name}\` currently returns a placeholder \`<div ... (stub)>\``,
  `// you MUST replace it with a real implementation per the UI contract.`,
  '//',
  `// Editable: the JSX body of \`${name}\`. Add hooks, helpers, sub-components`,
  `//           as needed inside this file.`,
  `// Locked:   the exported function name (\`${name}\`) and the props type`,
  `//           (\`${name}Props\` from generated/contracts) — the cross-scope`,
  `//           reconciler reads those literally. Leave them byte-identical.`,
  '//',
  '// This file is NOT in the `generated/` directory and is NOT auto-',
  '// regenerated. Once you edit it, your changes stick.',
  '// =====================================================================',
].join('\n');

export function generateComponentStubs(uiContract) {
  const components = Array.isArray(uiContract?.components) ? uiContract.components : [];
  const files = [];
  for (const comp of components) {
    if (!comp || typeof comp.name !== 'string' || !comp.name) continue;
    const name = comp.name;
    const role = (typeof comp.role === 'string' ? comp.role : '').trim();
    const source = emitComponentStub({ name, role });
    files.push({ relPath: `frontend/src/components/${name}.tsx`, content: source, name, role });
  }
  return files;
}

function emitComponentStub({ name, role }) {
  const lines = [];
  lines.push(HEADER_BLOCK(name));
  if (role) {
    lines.push('');
    lines.push(`// Role per ui_contract: ${role}`);
  }
  lines.push('');
  lines.push(`import type * as React from 'react';`);
  lines.push(`import type { ${name}Props } from '../generated/contracts.js';`);
  lines.push('');
  lines.push(`export function ${name}(props: ${name}Props): React.JSX.Element {`);
  lines.push(`  // REPLACE-ME — implement the JSX body per the UI contract.`);
  lines.push(`  // The placeholder return below MUST be replaced with real markup.`);
  lines.push(`  return <div className="stub-${kebab(name)}">${name} (stub)</div>;`);
  lines.push(`}`);
  lines.push('');

  return lines.join('\n');
}

function kebab(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}