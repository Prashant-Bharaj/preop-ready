/**
 * "Workspace went to sleep" detection helpers for the chat UI.
 *
 * Module under test:
 *   chat/src/lib/workspace-status.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { editorUrlFor, classifyHealthProbe } from '../../src/lib/workspace-status.js';

test('editorUrlFor derives the codespace editor from the port-forward hostname', () => {
  assert.equal(editorUrlFor('ubiquitous-acorn-6qwv65466v42w6v-5050.app.github.dev'), 'https://ubiquitous-acorn-6qwv65466v42w6v.github.dev');
  assert.equal(editorUrlFor('silver-space-capybara-6qwv6546xjxh576q-8080.preview.github.dev'), 'https://silver-space-capybara-6qwv6546xjxh576q.github.dev');
  assert.equal(editorUrlFor('localhost'), null);
  assert.equal(editorUrlFor('harness.vibe.intranet.cnb'), null);
  assert.equal(editorUrlFor(''), null);
});

test('classifyHealthProbe: JSON 200 is online; failures, non-2xx, and the proxy HTML page are gone', () => {
  assert.equal(classifyHealthProbe({ ok: true, contentType: 'application/json; charset=utf-8' }), 'online');
  assert.equal(classifyHealthProbe(null), 'gone');
  assert.equal(classifyHealthProbe({ ok: false, contentType: 'text/html' }), 'gone');
  assert.equal(classifyHealthProbe({ ok: true, contentType: 'text/html; charset=utf-8' }), 'gone');
});
