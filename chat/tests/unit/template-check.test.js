import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTemplateCheckOutput,
  templateNeedsAttention,
  describeTemplateCheck,
} from '../../server/core/template-check.js';

const HEADER = '[template-check] Platform template status for this repo — act on it as ...';

test('parses an open sync PR with held workflow files', () => {
  const out = [
    HEADER,
    'TEMPLATE_PR|31|https://github.com/bayer-int/qa-nexus/pull/31|held_workflows=yes',
    'TEMPLATE_CALLER|current',
    'TEMPLATE_VERSION|UPDATE_AVAILABLE|1.4.11|1.4.12',
    'TEMPLATE_AUTO_UPDATE|off',
  ].join('\n');
  const r = parseTemplateCheckOutput(out);
  assert.deepEqual(r.pr, { number: 31, url: 'https://github.com/bayer-int/qa-nexus/pull/31', heldWorkflows: true });
  assert.equal(r.caller, 'current');
  assert.deepEqual(r.version, { status: 'UPDATE_AVAILABLE', current: '1.4.11', latest: '1.4.12' });
  assert.equal(r.autoUpdate, false);
  assert.equal(templateNeedsAttention(r), true);
  assert.match(describeTemplateCheck(r), /PR #31 is open \(workflow files need a local engine run/);
});

test('all-clear output needs no attention', () => {
  const r = parseTemplateCheckOutput('TEMPLATE_PR|none\nTEMPLATE_CALLER|current\nTEMPLATE_VERSION|UP_TO_DATE\nTEMPLATE_AUTO_UPDATE|off\n');
  assert.equal(r.pr, null);
  assert.equal(templateNeedsAttention(r), false);
  assert.equal(describeTemplateCheck(r), null);
});

test('outdated caller is flagged even when GitHub could not be asked', () => {
  const r = parseTemplateCheckOutput('TEMPLATE_PR|unknown|gh_auth\nTEMPLATE_CALLER|outdated\nTEMPLATE_VERSION|CHECK_FAILED|fetch_auth\nTEMPLATE_AUTO_UPDATE|on\n');
  assert.equal(r.pr, null);
  assert.equal(r.prUnknown, 'gh_auth');
  assert.equal(r.caller, 'outdated');
  assert.deepEqual(r.version, { status: 'CHECK_FAILED', reason: 'fetch_auth' });
  assert.equal(r.autoUpdate, true);
  assert.equal(templateNeedsAttention(r), true);
  assert.match(describeTemplateCheck(r), /pre-platform copy/);
});

test('held major and retired stack are surfaced', () => {
  const r = parseTemplateCheckOutput('TEMPLATE_PR|none\nTEMPLATE_CALLER|current\nTEMPLATE_VERSION|UPDATE_AVAILABLE|1.4.12|2.0.0\nTEMPLATE_MAJOR_HELD|2|2.0.0\nTEMPLATE_MIGRATION_NEEDED|frontend=vanilla,vectordb=chroma\nTEMPLATE_AUTO_UPDATE|off\n');
  assert.deepEqual(r.majorHeld, { major: '2', synced: '2.0.0' });
  assert.equal(r.migrationNeeded, 'frontend=vanilla,vectordb=chroma');
  assert.equal(templateNeedsAttention(r), true);
  assert.match(describeTemplateCheck(r), /retired stack \(frontend=vanilla,vectordb=chroma\) — migrate before accepting template v2/);
  const held = parseTemplateCheckOutput('TEMPLATE_PR|none\nTEMPLATE_CALLER|current\nTEMPLATE_VERSION|UP_TO_DATE\nTEMPLATE_MAJOR_HELD|2|2.0.0\n');
  assert.match(describeTemplateCheck(held), /template v2 is available \(held until accepted\)/);
});

test('TypeScript migration offer is informational, not attention-worthy', () => {
  const r = parseTemplateCheckOutput('TEMPLATE_PR|none\nTEMPLATE_CALLER|current\nTEMPLATE_VERSION|UP_TO_DATE\nTEMPLATE_TS_MIGRATION|backend=node-js,frontend=react-js\nTEMPLATE_AUTO_UPDATE|off\n');
  assert.equal(r.tsMigration, 'backend=node-js,frontend=react-js');
  assert.equal(templateNeedsAttention(r), false);
  assert.equal(describeTemplateCheck(r), null);
});

test('garbage and empty input degrade to the empty shape', () => {
  for (const input of ['', null, undefined, 'TEMPLATE_PR|abc|x|y\nTEMPLATE_CALLER|weird\nnot a line']) {
    const r = parseTemplateCheckOutput(input);
    assert.equal(r.pr, null);
    assert.equal(r.caller, null);
    assert.equal(r.version, null);
    assert.equal(templateNeedsAttention(r), false);
  }
});
