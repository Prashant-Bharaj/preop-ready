/**
 * esm-footgun-validator — catch + shim __dirname/__filename in ESM backends.
 *
 * The exact failure it targets: a `"type": "module"` backend that uses
 * `__dirname` passes tsc but throws `ReferenceError: __dirname is not defined`
 * on boot (observed: ex-mediumhard, routes.js:18). tsc can't see it, so this
 * deterministic pre-compose fixer must.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeSource,
  scanBackendForEsmFootguns,
  applyEsmFootgunFixes,
} from '../../server/validators/code/esm-footgun-validator.js';

function mkBackend({ type = 'module', files = {} }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'esmfix-'));
  fs.mkdirSync(path.join(ws, 'backend', 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'backend', 'package.json'), JSON.stringify({ type }));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(ws, 'backend', 'src', rel), content);
  }
  return ws;
}

test('analyzeSource: flags a free __dirname, ignores property access + own declaration', () => {
  assert.deepEqual(analyzeSource(`const p = path.join(__dirname, 'x');`), ['__dirname']);
  assert.deepEqual(analyzeSource(`const p = cfg.__dirname;`), []); // property, not the global
  assert.deepEqual(analyzeSource(`const __dirname = foo(); use(__dirname);`), []); // self-declared
  assert.deepEqual(analyzeSource(`const a = __filename; const b = __dirname;`).sort(), ['__dirname', '__filename']);
});

test('scan: the exact ex-mediumhard pattern is detected', () => {
  const ws = mkBackend({ files: { 'routes.ts': `import path from 'node:path';\nconst UP = process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(__dirname, '..', 'uploads');\n` } });
  try {
    const issues = scanBackendForEsmFootguns(ws);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].needs, ['__dirname']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('scan: CommonJS backend (type != module) is left alone', () => {
  const ws = mkBackend({ type: 'commonjs', files: { 'routes.ts': `const p = path.join(__dirname, 'x');` } });
  try { assert.deepEqual(scanBackendForEsmFootguns(ws), []); }
  finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('apply: injects a minimal shim and re-scan is clean (idempotent)', () => {
  const ws = mkBackend({ files: { 'routes.ts': `import path from 'node:path';\nexport const UP = path.join(__dirname, '..', 'uploads');\n` } });
  try {
    const issues = scanBackendForEsmFootguns(ws);
    const applied = applyEsmFootgunFixes(ws, issues);
    assert.equal(applied.length, 1);
    const fixed = fs.readFileSync(path.join(ws, 'backend', 'src', 'routes.ts'), 'utf-8');
    assert.match(fixed, /import \{ fileURLToPath as __esmFileURLToPath \} from 'node:url'/);
    assert.match(fixed, /const __dirname = __esmDirname\(__esmFileURLToPath\(import\.meta\.url\)\)/);
    assert.doesNotMatch(fixed, /const __filename/); // only __dirname was needed
    // idempotent: a second scan finds nothing (already shimmed)
    assert.deepEqual(scanBackendForEsmFootguns(ws), []);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('apply: shim goes after a shebang line', () => {
  const ws = mkBackend({ files: { 'index.ts': `#!/usr/bin/env node\nconsole.log(__filename);\n` } });
  try {
    applyEsmFootgunFixes(ws, scanBackendForEsmFootguns(ws));
    const fixed = fs.readFileSync(path.join(ws, 'backend', 'src', 'index.ts'), 'utf-8');
    assert.match(fixed, /^#!\/usr\/bin\/env node\nimport \{ fileURLToPath/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
