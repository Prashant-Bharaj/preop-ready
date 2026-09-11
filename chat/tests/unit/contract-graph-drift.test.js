/**
 * Drift detector: assert that chat/prompts/contract-agent.md and
 * chat/server/agent/planner/contract-graph.js agree on the canonical enums.
 *
 * Why this test exists. The validator iterates CONTRACT_GRAPH; the LLM follows
 * contract-agent.md. If either side adds, renames, or removes a flag /
 * archetype / scope without the other, the runtime enforcement layer and the
 * model's mental model diverge silently.
 *
 * This test is the cheap substitute for build-time prompt injection: instead
 * of generating the prompt from the graph (heavier machinery), we read both
 * sources and assert they describe the same enums.
 *
 * Sources:
 *   - Prompt: chat/prompts/contract-agent.md
 *     - Flag enum at "Canonical flag enum" section (16 names)
 *     - Archetype table at "## 4. SCOPE SELECTION"
 *     - Scope order at "Scope ordering in `tasks[]`"
 *   - Code: chat/server/agent/planner/contract-graph.js (CONTRACT_GRAPH)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_GRAPH } from '../../server/agent/planner/contract-graph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'contract-agent.md');

function loadPrompt() {
  return fs.readFileSync(PROMPT_PATH, 'utf-8');
}

// Extract the canonical-flag line. Format from contract-agent.md L78-79:
//   `has-users` | `has-admin` | ... | `migration`
function extractPromptFlags(prompt) {
  const match = prompt.match(/Canonical flag enum[^`]*?(`[a-z\-]+`(?:\s*\|\s*`[a-z\-]+`)+)/);
  if (!match) throw new Error('could not locate canonical flag enum line in contract-agent.md');
  return [...match[1].matchAll(/`([a-z\-]+)`/g)].map(m => m[1]);
}

// Extract archetype names from the table at L156-166. Each row is of the form:
//   | `landing` | ... |
function extractPromptArchetypes(prompt) {
  const tableMatch = prompt.match(/## 4\. SCOPE SELECTION[\s\S]*?\n\n(\|[\s\S]*?\n)\n/);
  if (!tableMatch) throw new Error('could not locate archetype table in contract-agent.md');
  const archetypes = [];
  const rowRegex = /^\| `([a-z\-]+)` \|/gm;
  let m;
  while ((m = rowRegex.exec(tableMatch[1])) !== null) {
    archetypes.push(m[1]);
  }
  return archetypes;
}

// Extract scope names from "Scope ordering in `tasks[]`: database → vectordb → backend → frontend → integration."
function extractPromptScopes(prompt) {
  const match = prompt.match(/Scope ordering in `tasks\[\]`:\s*((?:`[a-z]+`(?:\s*→\s*)?)+)/);
  if (!match) throw new Error('could not locate scope ordering line in contract-agent.md');
  return [...match[1].matchAll(/`([a-z]+)`/g)].map(m => m[1]);
}

// ─────────────────────────────────────────────────────────────────────────────

test('drift: prompt and graph agree on the 16 canonical flags', () => {
  const prompt = loadPrompt();
  const promptFlags = new Set(extractPromptFlags(prompt));
  const graphFlags = new Set(Object.keys(CONTRACT_GRAPH.flags));

  const promptOnly = [...promptFlags].filter(f => !graphFlags.has(f));
  const graphOnly = [...graphFlags].filter(f => !promptFlags.has(f));

  assert.deepEqual(promptOnly, [], `flags in prompt but not in graph: ${promptOnly.join(', ')}`);
  assert.deepEqual(graphOnly, [], `flags in graph but not in prompt: ${graphOnly.join(', ')}`);
  assert.equal(promptFlags.size, 16, 'prompt should declare exactly 16 flags');
  assert.equal(graphFlags.size, 16, 'graph should declare exactly 16 flags');
});

test('drift: prompt and graph agree on the 9 archetypes', () => {
  const prompt = loadPrompt();
  const promptArchetypes = new Set(extractPromptArchetypes(prompt));
  const graphArchetypes = new Set(Object.keys(CONTRACT_GRAPH.archetypes));

  const promptOnly = [...promptArchetypes].filter(a => !graphArchetypes.has(a));
  const graphOnly = [...graphArchetypes].filter(a => !promptArchetypes.has(a));

  assert.deepEqual(promptOnly, [], `archetypes in prompt but not in graph: ${promptOnly.join(', ')}`);
  assert.deepEqual(graphOnly, [], `archetypes in graph but not in prompt: ${graphOnly.join(', ')}`);
  assert.equal(promptArchetypes.size, 9, 'prompt should declare exactly 9 archetypes');
});

test('drift: prompt and graph agree on the 5 scopes (and their order)', () => {
  const prompt = loadPrompt();
  const promptScopes = extractPromptScopes(prompt);
  const graphScopes = Object.keys(CONTRACT_GRAPH.scopes);

  // Set-equivalence
  const promptSet = new Set(promptScopes);
  const graphSet = new Set(graphScopes);
  const promptOnly = [...promptSet].filter(s => !graphSet.has(s));
  const graphOnly = [...graphSet].filter(s => !promptSet.has(s));
  assert.deepEqual(promptOnly, [], `scopes in prompt but not in graph: ${promptOnly.join(', ')}`);
  assert.deepEqual(graphOnly, [], `scopes in graph but not in prompt: ${graphOnly.join(', ')}`);

  // Ordering — the validator enforces this exact order; assert the prompt
  // matches.
  const SCOPE_ORDER_EXPECTED = ['database', 'vectordb', 'backend', 'frontend', 'integration'];
  assert.deepEqual(
    promptScopes,
    SCOPE_ORDER_EXPECTED,
    'prompt scope-ordering line should match validator order',
  );
});

test('drift: vector_engine value matches between prompt and graph', () => {
  const prompt = loadPrompt();
  // Prompt L246: 'Always `"vector_engine": "pgvector"`.'
  const match = prompt.match(/Always\s+`"vector_engine":\s*"([a-z]+)"`/);
  assert.ok(match, 'could not locate vector_engine assertion in prompt');
  assert.deepEqual(
    CONTRACT_GRAPH.validVectorEngines,
    [match[1]],
    `prompt says vector_engine="${match[1]}", graph validVectorEngines is ${JSON.stringify(CONTRACT_GRAPH.validVectorEngines)}`,
  );
});

test('drift: prompt forbids "fullstack" scope and graph lists it as forbidden', () => {
  const prompt = loadPrompt();
  assert.match(prompt, /Never include scope `"fullstack"`/, 'prompt should forbid fullstack scope');
  assert.ok(
    CONTRACT_GRAPH.forbiddenScopes.includes('fullstack'),
    'graph.forbiddenScopes should include "fullstack"',
  );
});
