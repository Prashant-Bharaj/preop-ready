/**
 * Unit tests for the two-agent planner runtime entry.
 *
 * Modules under test:
 *   chat/server/agent/planner/shared-context.js
 *   chat/server/agent/planner/two-agent.js (input enrichment + routeMessage error paths)
 *
 * Live MGA behavior + the multi-turn clarify loop are covered by the smoke
 * battery (chat/tests/smoke) — that's where end-to-end correctness is gated
 * before the deletion commit per the Phase B verification plan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildProjectContext,
  buildAttachedFilesBlock,
  buildProjectMemoryBlock,
} from '../../server/agent/planner/shared-context.js';
import {
  _testables_buildEnrichedUserMessage as buildEnrichedUserMessage,
} from '../../server/agent/planner/two-agent.js';

// ─────────────────────────────────────────────────────────────────────────────
// shared-context: buildProjectContext
// ─────────────────────────────────────────────────────────────────────────────

test('shared-context: buildProjectContext returns empty when envContext null', () => {
  assert.equal(buildProjectContext(null), '');
});

test('shared-context: buildProjectContext renders env / phase / structure', () => {
  const out = buildProjectContext({
    environment: 'codespaces',
    projectPhase: 'empty',
    hasStructure: { backend: true, frontend: true },
  });
  assert.ok(out.startsWith('[Project Context]'));
  assert.match(out, /Environment: GitHub Codespace/);
  assert.match(out, /Phase: empty/);
  assert.match(out, /Structure: frontend \+ backend/);
});

test('shared-context: buildProjectContext renders continuation enrichment when phase != empty', () => {
  const out = buildProjectContext({
    environment: 'local',
    projectPhase: 'in_progress',
    hasStructure: { backend: true },
    recentCommits: ['abc123 fix(api): foo', 'def456 feat(ui): bar'],
    hasUncommittedChanges: true,
    projectStatus: { idea: 'Build a feedback tool', stack: 'Node+Express+pg' },
  });
  assert.match(out, /Phase: in_progress/);
  assert.match(out, /Idea: Build a feedback tool/);
  assert.match(out, /Stack: Node\+Express\+pg/);
  assert.match(out, /Recent commits: abc123/);
  assert.match(out, /Uncommitted changes: yes/);
});

test('shared-context: buildProjectContext OMITS continuation block when phase=empty (fresh build)', () => {
  const out = buildProjectContext({
    environment: 'local',
    projectPhase: 'empty',
    hasStructure: {},
    recentCommits: ['x'],
    hasUncommittedChanges: true,
  });
  assert.doesNotMatch(out, /Recent commits/);
  assert.doesNotMatch(out, /Uncommitted changes/);
});

// ─────────────────────────────────────────────────────────────────────────────
// shared-context: buildAttachedFilesBlock
// ─────────────────────────────────────────────────────────────────────────────

test('shared-context: buildAttachedFilesBlock returns empty for no uploads', () => {
  assert.equal(buildAttachedFilesBlock(null), '');
  assert.equal(buildAttachedFilesBlock([]), '');
});

test('shared-context: buildAttachedFilesBlock lists files + summary', () => {
  const out = buildAttachedFilesBlock([
    { relativePath: 'docs/spec.pdf', size: 12345, mime: 'application/pdf', parsed: { summary: 'PDF, 12 pages' } },
    { relativePath: 'data.csv', size: 99, mime: 'text/csv' },
  ]);
  assert.match(out, /^\[Attached files\]/);
  assert.match(out, /- docs\/spec\.pdf — PDF, 12 pages/);
  assert.match(out, /- data\.csv — text\/csv, 99 bytes/);
});

test('shared-context: buildAttachedFilesBlock includes preview of first file when present', () => {
  const out = buildAttachedFilesBlock([
    { relativePath: 'a.txt', size: 9, mime: 'text/plain', parsed: { summary: 'plain', preview: 'hello world' } },
  ]);
  assert.match(out, /Preview of a\.txt/);
  assert.match(out, /hello world/);
});

// ─────────────────────────────────────────────────────────────────────────────
// shared-context: buildProjectMemoryBlock
// ─────────────────────────────────────────────────────────────────────────────

function makeTempWorkspace(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-agent-test-'));
  const harness = path.join(dir, '.harness');
  fs.mkdirSync(harness, { recursive: true });
  if (setup.stateMd != null) {
    fs.writeFileSync(path.join(harness, 'state.md'), setup.stateMd);
  }
  if (setup.contracts != null) {
    fs.writeFileSync(path.join(harness, 'contracts.json'), JSON.stringify(setup.contracts, null, 2));
  }
  return dir;
}

test('shared-context: buildProjectMemoryBlock returns null when .harness/ is empty', () => {
  const dir = makeTempWorkspace({});
  assert.equal(buildProjectMemoryBlock(dir), null);
});

test('shared-context: buildProjectMemoryBlock embeds state.md + contracts.json', () => {
  const dir = makeTempWorkspace({
    stateMd: '# State\nBuilt: policy library\n',
    contracts: { data: { archetype: 'search-tool', flags: ['ai-rag', 'has-users'] } },
  });
  const out = buildProjectMemoryBlock(dir);
  assert.ok(out);
  assert.match(out, /=== PROJECT MEMORY ===/);
  assert.match(out, /--- \.harness\/state\.md ---/);
  assert.match(out, /Built: policy library/);
  assert.match(out, /--- \.harness\/contracts\.json ---/);
  assert.match(out, /"archetype": "search-tool"/);
  assert.match(out, /=== END PROJECT MEMORY ===/);
});

test('shared-context: buildProjectMemoryBlock handles state.md present but contracts.json missing', () => {
  const dir = makeTempWorkspace({ stateMd: '# State\n' });
  const out = buildProjectMemoryBlock(dir);
  assert.ok(out);
  assert.match(out, /--- \.harness\/state\.md ---/);
  // contracts.json absent — no contracts block
  assert.doesNotMatch(out, /--- \.harness\/contracts\.json ---/);
});

// ─────────────────────────────────────────────────────────────────────────────
// two-agent: buildEnrichedUserMessage composition
// ─────────────────────────────────────────────────────────────────────────────

test('two-agent: first-turn message includes project context + user message; OMITS project memory', () => {
  const dir = makeTempWorkspace({ stateMd: '# State\n', contracts: { data: { archetype: 'crud-app' } } });
  const out = buildEnrichedUserMessage({
    userMessage: 'Build a feedback form',
    envContext: { environment: 'local', projectPhase: 'empty', hasStructure: {} },
    uploads: null,
    workspaceDir: dir,
    isFirstTurn: true,
  });
  assert.match(out, /\[Project Context\]/);
  assert.match(out, /\[User Message\]\nBuild a feedback form/);
  assert.doesNotMatch(out, /=== PROJECT MEMORY ===/);
});

test('two-agent: follow-up message includes project memory + user message; OMITS project context', () => {
  const dir = makeTempWorkspace({
    stateMd: '# State\nBuilt: policy library\n',
    contracts: { data: { archetype: 'search-tool', flags: ['ai-rag'] } },
  });
  const out = buildEnrichedUserMessage({
    userMessage: 'Add a comments table',
    envContext: { environment: 'local', projectPhase: 'in_progress', hasStructure: { backend: true } },
    uploads: null,
    workspaceDir: dir,
    isFirstTurn: false,
  });
  assert.match(out, /=== PROJECT MEMORY ===/);
  assert.match(out, /Built: policy library/);
  assert.match(out, /\[User Message\]\nAdd a comments table/);
  assert.doesNotMatch(out, /\[Project Context\]/);
});

test('two-agent: follow-up message OMITS project memory block when .harness is empty', () => {
  const dir = makeTempWorkspace({});
  const out = buildEnrichedUserMessage({
    userMessage: 'do something',
    envContext: { environment: 'local', projectPhase: 'empty', hasStructure: {} },
    uploads: null,
    workspaceDir: dir,
    isFirstTurn: false,
  });
  assert.doesNotMatch(out, /=== PROJECT MEMORY ===/);
  assert.match(out, /\[User Message\]\ndo something/);
});

test('two-agent: uploads attach to first-turn message', () => {
  const dir = makeTempWorkspace({});
  const out = buildEnrichedUserMessage({
    userMessage: 'review this',
    envContext: { environment: 'local', projectPhase: 'empty', hasStructure: {} },
    uploads: [{ relativePath: 'spec.pdf', mime: 'application/pdf', size: 100, parsed: { summary: 'PDF' } }],
    workspaceDir: dir,
    isFirstTurn: true,
  });
  assert.match(out, /\[Project Context\]/);
  assert.match(out, /\[Attached files\]/);
  assert.match(out, /- spec\.pdf — PDF/);
});

test('two-agent: uploads attach to follow-up message too (user can attach mid-clarify)', () => {
  const dir = makeTempWorkspace({});
  const out = buildEnrichedUserMessage({
    userMessage: 'use this doc',
    envContext: { environment: 'local', projectPhase: 'empty', hasStructure: {} },
    uploads: [{ relativePath: 'extra.csv', mime: 'text/csv', size: 50 }],
    workspaceDir: dir,
    isFirstTurn: false,
  });
  assert.match(out, /\[Attached files\]/);
  assert.match(out, /- extra\.csv/);
});
