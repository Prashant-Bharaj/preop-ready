/**
 * xml-parser tool-name coverage.
 *
 * Every tool registered in core.js TOOL_MAP must also appear in the parser's
 * TOOL_NAMES, or the agent's `<tool>` call is classified as plain text — the
 * runtime then logs "no tool calls in response — nudging", the model stalls,
 * and the turn returns no_completion. This gap has bitten twice:
 *   - spawn_phase_agent (orchestrator bailed "no task spec provided")
 *   - read_harness_state / read_container_logs (investigator → "Investigation
 *     did not complete")
 * These tests lock in that the harness-state + investigator read-only tools
 * (and their params) parse as real tool_use blocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAssistantMessage } from '../../server/agent/cline-derived/xml-parser.js';

function firstToolUse(text) {
  return parseAssistantMessage(text).find((b) => b.type === 'tool_use' && !b.partial);
}

test('read_harness_state parses as a tool_use (no params)', () => {
  const tu = firstToolUse('Let me orient. <read_harness_state></read_harness_state>');
  assert.ok(tu, 'expected a tool_use block, not plain text');
  assert.equal(tu.name, 'read_harness_state');
});

test('read_container_logs parses with its params', () => {
  const tu = firstToolUse(
    'Checking logs: <read_container_logs><service>backend</service><tail>50</tail>'
    + '<since>5m</since><scope>backend</scope></read_container_logs>',
  );
  assert.ok(tu, 'expected a tool_use block');
  assert.equal(tu.name, 'read_container_logs');
  assert.equal(tu.params.service, 'backend');
  assert.equal(tu.params.tail, '50');
  assert.equal(tu.params.since, '5m');
  assert.equal(tu.params.scope, 'backend');
});

test('write_harness_state parses with its params', () => {
  const tu = firstToolUse(
    '<write_harness_state><state>{"idea":"x"}</state><decision>{"d":1}</decision>'
    + '<file_structure>{"f":[]}</file_structure></write_harness_state>',
  );
  assert.ok(tu, 'expected a tool_use block');
  assert.equal(tu.name, 'write_harness_state');
  assert.equal(tu.params.state, '{"idea":"x"}');
  assert.equal(tu.params.decision, '{"d":1}');
  assert.equal(tu.params.file_structure, '{"f":[]}');
});

test('the investigator tool set is fully parseable (regression guard)', () => {
  // The exact tools the INVESTIGATING phase whitelists (phase.js
  // INVESTIGATING_ALLOWED_TOOLS) must all parse, or the investigator stalls.
  for (const name of ['read_harness_state', 'read_file', 'read_container_logs', 'list_files', 'attempt_completion']) {
    const tu = firstToolUse(`<${name}></${name}>`);
    assert.ok(tu && tu.name === name, `investigator tool <${name}> must parse as a tool_use`);
  }
});
