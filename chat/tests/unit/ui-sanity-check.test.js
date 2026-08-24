/**
 * Unit tests for the post-compose visual sanity check.
 *
 * Module under test:
 *   chat/server/reconciler/ui-sanity-check.js
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseVerdict,
  findChromeBinary,
  runUiSanityCheck,
} from '../../server/reconciler/ui-sanity-check.js';

const UI_CONTRACT = { primary_view: 'Sample list', primary_action: 'Register sample', components: [{ name: 'SampleTable' }] };

afterEach(() => {
  delete globalThis.__HARNESS_MGA_CALL_OVERRIDE;
  delete process.env.UI_SANITY_SKIP;
  delete process.env.CHROME_BIN;
});

// ── parseVerdict ──────────────────────────────────────────────────────────

test('parseVerdict: plain JSON, fenced JSON, and garbage', () => {
  assert.deepEqual(parseVerdict('{"sane": true, "defects": []}'), { sane: true, defects: [] });
  const fenced = parseVerdict('```json\n{"sane": false, "defects": [{"severity": "high", "description": "[object Object] in list"}]}\n```');
  assert.equal(fenced.sane, false);
  assert.equal(fenced.defects[0].severity, 'high');
  assert.equal(parseVerdict('not json'), null);
  assert.equal(parseVerdict('{"defects": []}'), null, 'missing sane boolean → null');
});

test('parseVerdict: normalizes unknown severities and drops malformed defects', () => {
  const v = parseVerdict(JSON.stringify({
    sane: false,
    defects: [{ severity: 'catastrophic', description: 'blank page' }, { severity: 'high' }, 'junk'],
  }));
  assert.equal(v.defects.length, 1);
  assert.equal(v.defects[0].severity, 'medium');
});

// ── findChromeBinary ──────────────────────────────────────────────────────

test('findChromeBinary: CHROME_BIN env wins when it exists', () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-bin-'));
  const bin = path.join(fake, 'chrome');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  process.env.CHROME_BIN = bin;
  assert.equal(findChromeBinary(), bin);
  fs.rmSync(fake, { recursive: true, force: true });
});

// ── runUiSanityCheck skip paths + full flow ───────────────────────────────

test('skips on env escape hatch and missing ui contract', async () => {
  process.env.UI_SANITY_SKIP = 'true';
  assert.deepEqual(await runUiSanityCheck({ url: 'http://x', uiContract: UI_CONTRACT }), { skipped: 'env' });
  delete process.env.UI_SANITY_SKIP;
  assert.deepEqual(await runUiSanityCheck({ url: 'http://x', uiContract: null }), { skipped: 'no-ui-contract' });
});

test('skips when capture fails', async () => {
  const r = await runUiSanityCheck({
    url: 'http://x', uiContract: UI_CONTRACT,
    captureImpl: async () => null,
  });
  assert.equal(r.skipped, 'screenshot-failed');
});

test('full flow: screenshot → vision judge → defects returned', async () => {
  let judgeSawImage = false;
  globalThis.__HARNESS_MGA_CALL_OVERRIDE = async ({ messages }) => {
    const user = messages.find((m) => m.role === 'user');
    judgeSawImage = Array.isArray(user.content) && user.content.some((b) => b.type === 'image_url' && b.image_url.url.startsWith('data:image/png;base64,'));
    return { content: JSON.stringify({ sane: false, defects: [{ severity: 'high', description: '[object Object] rendered in the ingredients list' }] }) };
  };
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-sanity-'));
  const r = await runUiSanityCheck({
    url: 'http://localhost:8080', uiContract: UI_CONTRACT,
    captureImpl: async (_url, outPath) => {
      const p = path.join(shotDir, 'shot.png');
      fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
      return p;
    },
  });
  assert.equal(judgeSawImage, true, 'judge received a base64 png block');
  assert.equal(r.sane, false);
  assert.equal(r.defects.length, 1);
  fs.rmSync(shotDir, { recursive: true, force: true });
});

test('unparseable judge output degrades to skipped', async () => {
  globalThis.__HARNESS_MGA_CALL_OVERRIDE = async () => ({ content: 'I think it looks fine!' });
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-sanity-'));
  const r = await runUiSanityCheck({
    url: 'http://x', uiContract: UI_CONTRACT,
    captureImpl: async () => {
      const p = path.join(shotDir, 'shot.png');
      fs.writeFileSync(p, 'png');
      return p;
    },
  });
  assert.equal(r.skipped, 'judge-unparseable');
  fs.rmSync(shotDir, { recursive: true, force: true });
});
