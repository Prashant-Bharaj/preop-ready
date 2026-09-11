/**
 * Coverage: flow 10 (Hard guard denials) via the chain
 *   flow 10 → checkPermissions denies illegal paths
 *           → checkPermissions correctness depends on resolveWorkspacePath
 *           → resolveWorkspacePath must reject escape attempts safely
 *
 * This file tests the resolve-path primitive at the security boundary.
 * Tests serve flow 10 by ensuring the chain's lowest level is sound.
 *
 * If you change tests in this file: confirm the chain link is still valid.
 * If you remove a test: confirm no chain dependency disappears with it.
 *
 * Module under test: chat/server/agent/tools/util/resolve-path.js (78 LoC).
 * Quality criterion per TESTING_EVOLUTION.md: every escape vector explicitly
 * covered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, symlink, writeFile } from 'node:fs/promises';

import { createTestWorkspace } from '../util/test-workspace.js';
import { resolveWorkspacePath, PathEscapeError } from '../../server/agent/tools/util/resolve-path.js';

// ── (a) Workspace-relative resolution under the workspaceDir ─────────────

test('resolveWorkspacePath: simple relative resolves under workspaceDir', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'simple' });
  try {
    const abs = resolveWorkspacePath('backend/src/index.ts', { workspaceDir: ws.dir });
    assert.equal(abs, path.join(ws.dir, 'backend/src/index.ts'));
    assert.ok(abs.startsWith(ws.dir), 'resolved path is under workspaceDir');
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: leading ./ prefix collapses cleanly', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'leading-dot' });
  try {
    const abs = resolveWorkspacePath('./backend/main.py', { workspaceDir: ws.dir });
    assert.equal(abs, path.join(ws.dir, 'backend/main.py'));
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: two distinct workspaceDirs are isolated', async () => {
  const wsA = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'iso-a' });
  const wsB = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'iso-b' });
  try {
    const a = resolveWorkspacePath('backend/x.ts', { workspaceDir: wsA.dir });
    const b = resolveWorkspacePath('backend/x.ts', { workspaceDir: wsB.dir });
    assert.notEqual(a, b, 'same input resolves to different absolute paths under different workspaces');
    assert.ok(a.startsWith(wsA.dir));
    assert.ok(b.startsWith(wsB.dir));
  } finally {
    await wsA.cleanup();
    await wsB.cleanup();
  }
});

// ── (b) Absolute path handling ───────────────────────────────────────────

test('resolveWorkspacePath: absolute path INSIDE the workspace resolves cleanly', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'abs-inside' });
  try {
    const insidePath = path.join(ws.dir, 'frontend/src/App.tsx');
    const abs = resolveWorkspacePath(insidePath, { workspaceDir: ws.dir });
    assert.equal(abs, insidePath);
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: absolute path OUTSIDE the workspace throws PathEscapeError', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'abs-outside' });
  try {
    // /etc is canonically outside any workspace tmpdir under macOS/Linux.
    assert.throws(
      () => resolveWorkspacePath('/etc/passwd', { workspaceDir: ws.dir }),
      (err) => err instanceof PathEscapeError && err.input === '/etc/passwd',
      'absolute path outside workspace must throw PathEscapeError',
    );
  } finally {
    await ws.cleanup();
  }
});

// ── (c) Parent-traversal `..` at multiple depths ─────────────────────────

test('resolveWorkspacePath: single-level `..` escape throws', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'parent-1' });
  try {
    assert.throws(
      () => resolveWorkspacePath('../escape.txt', { workspaceDir: ws.dir }),
      PathEscapeError,
    );
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: two-level `../../` escape throws', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'parent-2' });
  try {
    assert.throws(
      () => resolveWorkspacePath('../../../etc/passwd', { workspaceDir: ws.dir }),
      PathEscapeError,
    );
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: mixed `subdir/../../up` traversal that escapes throws', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'mixed-escape' });
  try {
    assert.throws(
      () => resolveWorkspacePath('backend/src/../../../escape.txt', { workspaceDir: ws.dir }),
      PathEscapeError,
    );
  } finally {
    await ws.cleanup();
  }
});

// ── (d) `..` that cancels out and STAYS inside workspace must resolve OK ─

test('resolveWorkspacePath: `a/../b` cancels out cleanly without escape', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'cancel' });
  try {
    const abs = resolveWorkspacePath('backend/../frontend/index.html', { workspaceDir: ws.dir });
    assert.equal(abs, path.join(ws.dir, 'frontend/index.html'),
      '`..` that doesn\'t escape resolves to the canonical sibling path');
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: deep `a/b/c/../../d` resolves inside workspace', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'cancel-deep' });
  try {
    const abs = resolveWorkspacePath('backend/src/dir/../../main.ts', { workspaceDir: ws.dir });
    assert.equal(abs, path.join(ws.dir, 'backend/main.ts'));
  } finally {
    await ws.cleanup();
  }
});

// ── (e) Symlink traversal ────────────────────────────────────────────────
//
// path.resolve does NOT follow symlinks (it operates on the textual path), so
// a symlink that LOOKS workspace-relative would pass the textual containment
// check. resolveWorkspacePath closes this with a second, symlink-aware pass:
// it realpaths the deepest existing prefix of both the workspace root and the
// resolved target and re-checks containment. An in-workspace symlink whose
// target is OUTSIDE the workspace is therefore rejected here, not just
// "downstream at the fs layer".

test('resolveWorkspacePath: symlinked subdir whose target is outside workspace is REJECTED (realpath containment)', async () => {
  const wsOuter = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'symlink-outer' });
  const wsInner = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'symlink-inner' });
  try {
    // Make a symlink inside wsInner that POINTS at wsOuter. `linkdir/file.txt`
    // is textually workspace-relative, but the real path lands in wsOuter — the
    // realpath re-check must catch that and throw PathEscapeError.
    const linkPath = path.join(wsInner.dir, 'linkdir');
    await symlink(wsOuter.dir, linkPath, 'dir');
    assert.throws(
      () => resolveWorkspacePath('linkdir/file.txt', { workspaceDir: wsInner.dir }),
      PathEscapeError,
      'a symlink resolving outside the workspace must be rejected, not accepted',
    );
  } finally {
    await wsInner.cleanup();
    await wsOuter.cleanup();
  }
});

test('resolveWorkspacePath: symlink-shaped input combined with `..` ESCAPE still throws', async () => {
  // A path of the form `linkdir/../../escape.txt` still has a textual
  // `..` that walks above the workspace — the textual escape detection
  // fires regardless of symlinks.
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'symlink-escape' });
  try {
    assert.throws(
      () => resolveWorkspacePath('linkdir/../../escape.txt', { workspaceDir: ws.dir }),
      PathEscapeError,
    );
  } finally {
    await ws.cleanup();
  }
});

// ── (f) Trailing slashes and edge whitespace ─────────────────────────────

test('resolveWorkspacePath: trailing slash on directory path resolves cleanly', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'trailing-slash' });
  try {
    const abs = resolveWorkspacePath('backend/src/', { workspaceDir: ws.dir });
    // path.resolve strips trailing slash but keeps the dir target.
    assert.equal(abs, path.join(ws.dir, 'backend/src'));
  } finally {
    await ws.cleanup();
  }
});

// ── (g) Invalid input rejection ──────────────────────────────────────────

test('resolveWorkspacePath: empty string throws (non-PathEscape) Error', () => {
  assert.throws(
    () => resolveWorkspacePath('', { workspaceDir: '/tmp/anywhere' }),
    /non-empty string/i,
  );
});

test('resolveWorkspacePath: null input throws', () => {
  assert.throws(
    () => resolveWorkspacePath(null, { workspaceDir: '/tmp/anywhere' }),
    /non-empty string/i,
  );
});

test('resolveWorkspacePath: undefined input throws', () => {
  assert.throws(
    () => resolveWorkspacePath(undefined, { workspaceDir: '/tmp/anywhere' }),
    /non-empty string/i,
  );
});

test('resolveWorkspacePath: numeric input throws (not a string)', () => {
  assert.throws(
    () => resolveWorkspacePath(42, { workspaceDir: '/tmp/anywhere' }),
    /non-empty string/i,
  );
});

test('resolveWorkspacePath: missing ctx throws', () => {
  assert.throws(
    () => resolveWorkspacePath('backend/x.ts', null),
    /workspaceDir is required/i,
  );
});

test('resolveWorkspacePath: ctx with empty workspaceDir throws', () => {
  assert.throws(
    () => resolveWorkspacePath('backend/x.ts', { workspaceDir: '' }),
    /workspaceDir is required/i,
  );
});

test('resolveWorkspacePath: ctx with non-string workspaceDir throws', () => {
  assert.throws(
    () => resolveWorkspacePath('backend/x.ts', { workspaceDir: 123 }),
    /workspaceDir is required/i,
  );
});

// ── (h) Windows-style backslash normalization ────────────────────────────
//
// The impl explicitly normalizes `\\` to `/` before resolving (line 65).
// On POSIX runtimes path.resolve treats backslashes as literal chars in a
// filename; the normalization is to handle agent inputs that came from a
// Windows author. Confirm the normalization produces the same abs as the
// forward-slash equivalent.

test('resolveWorkspacePath: Windows-style backslashes normalize to forward slashes', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'win-slash' });
  try {
    const absBack = resolveWorkspacePath('backend\\src\\index.ts', { workspaceDir: ws.dir });
    const absFwd  = resolveWorkspacePath('backend/src/index.ts', { workspaceDir: ws.dir });
    assert.equal(absBack, absFwd, 'backslash-input resolves identically to forward-slash input');
  } finally {
    await ws.cleanup();
  }
});

test('resolveWorkspacePath: Windows-style backslash `..\\..\\escape` still throws', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'win-escape' });
  try {
    assert.throws(
      () => resolveWorkspacePath('..\\..\\..\\etc\\passwd', { workspaceDir: ws.dir }),
      PathEscapeError,
    );
  } finally {
    await ws.cleanup();
  }
});

// ── (i) PathEscapeError shape — caller observability ─────────────────────

test('PathEscapeError: carries input, resolved, workspaceDir for downstream logging', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'err-shape' });
  try {
    let caught;
    try {
      resolveWorkspacePath('../../../escape.txt', { workspaceDir: ws.dir });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof PathEscapeError, 'is PathEscapeError instance');
    assert.equal(caught.name, 'PathEscapeError');
    assert.equal(caught.input, '../../../escape.txt');
    assert.equal(caught.workspaceDir, ws.dir);
    assert.ok(typeof caught.resolved === 'string' && caught.resolved.length > 0);
  } finally {
    await ws.cleanup();
  }
});

// ── (j) Defensive: a path that exists but lives at the workspace root is OK

test('resolveWorkspacePath: workspace-root file (no subdir) resolves cleanly', async () => {
  const ws = await createTestWorkspace({ scope: 'resolve-path', scenarioName: 'root-file' });
  try {
    await writeFile(path.join(ws.dir, 'docker-compose.yml'), 'services: {}\n', 'utf-8');
    const abs = resolveWorkspacePath('docker-compose.yml', { workspaceDir: ws.dir });
    assert.equal(abs, path.join(ws.dir, 'docker-compose.yml'));
  } finally {
    await ws.cleanup();
  }
});

// Touch unused import for fs creation symmetry (no-op).
void mkdir;
