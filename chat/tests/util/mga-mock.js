/**
 * MGA mock layer.
 *
 * Intercepts `callMgaAssistant` (the export from chat/server/agent/llm/llm.js)
 * during integration tests, serving fixture-recorded responses instead of
 * hitting the real MGA endpoint. The intercept point is the JS export, NOT
 * the HTTP boundary — integration tests care about what the harness's
 * downstream code does with MGA responses, not the wire format. (The
 * fixture refresh script handles the wire-format → fixture pipeline.)
 *
 * Usage:
 *   import { createMgaMock } from '../util/mga-mock.js';
 *   import { fileURLToPath } from 'node:url';
 *   import { join, dirname } from 'node:path';
 *
 *   const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)),
 *     '..', 'fixtures', 'mga-responses');
 *
 *   const mock = createMgaMock({ fixturesRoot: FIXTURES_ROOT });
 *   mock.expect('router', 'iterate-cosmetic-frontend')
 *       .returns('router/iterate-cosmetic-frontend.json');
 *   mock.install();
 *   try {
 *     // ... test code that calls callMgaAssistant under the hood ...
 *     mock.assertExpectationsMet();
 *   } finally {
 *     mock.uninstall();
 *   }
 *
 * Design notes:
 *   - install()/uninstall() routes calls through the test-only override hook
 *     in `chat/server/agent/llm/llm.js` (`globalThis.__HARNESS_MGA_CALL_OVERRIDE`).
 *     ESM export bindings are immutable in Node, so a direct monkey-patch on
 *     the `callMgaAssistant` export is rejected with "Cannot redefine
 *     property" — the override hook is the substitute seam. In production
 *     the override is always undefined and behavior is unchanged.
 *   - The mock matches a call to an expectation by (assistantKey,
 *     scenarioName). assistantKey is derived from the call's `assistantLabel`
 *     (lowercased + normalized). scenarioName is operator-chosen and matched
 *     via FIFO queue per assistantKey — tests can chain multiple expectations
 *     for the same key.
 *   - If a call comes in with no matching expectation, the mock throws —
 *     surfacing "the harness called MGA with an unexpected key" loudly
 *     instead of silently returning a generic response.
 *   - callsMade() returns the audit trail; useful for asserting "the
 *     harness called router once, then orchestrator once" etc.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Normalize the assistantLabel passed into callMgaAssistant into the short
// fixture key. Labels we've seen in the harness: 'Router', 'Orchestrator',
// 'Investigator', 'Coder', 'Subagent', 'Subagent (backend)', 'Summarizer',
// 'Prompt Writer'. The label may include a scope in parens for subagents.
function deriveAssistantKey(assistantLabel) {
  if (!assistantLabel) return 'unknown';
  const lc = assistantLabel.toLowerCase().trim();
  // 'Subagent (backend)' → 'subagent-backend'
  const subagentMatch = lc.match(/^subagent\s*\(([a-z]+)\)/);
  if (subagentMatch) return `subagent-${subagentMatch[1]}`;
  // 'Prompt Writer' → 'prompt-writer'
  return lc.replace(/\s+/g, '-');
}

export function createMgaMock({ fixturesRoot } = {}) {
  if (!fixturesRoot) {
    throw new Error('createMgaMock: fixturesRoot is required');
  }

  // Map<assistantKey, Array<{ scenarioName, fixturePath, fulfilled }>>
  const expectations = new Map();
  const callsMade = [];
  let priorOverride = undefined;
  let installed = false;
  const HOOK_KEY = '__HARNESS_MGA_CALL_OVERRIDE';

  async function loadFixture(relPath) {
    const abs = join(fixturesRoot, relPath);
    let raw;
    try {
      raw = await readFile(abs, 'utf8');
    } catch (err) {
      throw new Error(`mga-mock: failed to read fixture ${abs}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`mga-mock: fixture is not valid JSON: ${abs}: ${err.message}`);
    }
    if (!parsed.response || typeof parsed.response !== 'object') {
      throw new Error(`mga-mock: fixture ${abs} missing required \`response\` object`);
    }
    return parsed;
  }

  async function mockedCall({ message, conversationId, assistantId, assistantLabel } = {}) {
    const key = deriveAssistantKey(assistantLabel);
    const queue = expectations.get(key);
    if (!queue || queue.length === 0) {
      throw new Error(
        `mga-mock: no expectation registered for assistantKey="${key}" (label="${assistantLabel}"). ` +
        `Registered: [${[...expectations.keys()].join(', ') || '<none>'}]`,
      );
    }
    // FIFO: pop the next unfulfilled.
    const nextIdx = queue.findIndex((e) => !e.fulfilled);
    if (nextIdx === -1) {
      throw new Error(
        `mga-mock: all expectations for assistantKey="${key}" already fulfilled, ` +
        `but harness called it again.`,
      );
    }
    const exp = queue[nextIdx];
    exp.fulfilled = true;

    const fixture = await loadFixture(exp.fixturePath);
    const resp = fixture.response;

    callsMade.push({
      assistantKey: key,
      assistantLabel: assistantLabel || null,
      assistantId: assistantId || null,
      conversationId: conversationId || null,
      messageLen: typeof message === 'string' ? message.length : 0,
      returnedFrom: exp.fixturePath,
      scenarioName: exp.scenarioName,
    });

    // Return shape matches callMgaAssistant: { content, conversationId, usage, latencyMs?, costUsd?, model? }
    return {
      content: typeof resp.completionText === 'string' ? resp.completionText : '',
      conversationId: resp.conversationId || conversationId || null,
      usage: resp.usage || null,
      latencyMs: 0,
      costUsd: 0,
      model: resp.model || null,
    };
  }

  return {
    /**
     * Declare an expected call. Returns a chainable handle:
     *   mock.expect('router', 'iterate-cosmetic-frontend')
     *       .returns('router/iterate-cosmetic-frontend.json');
     */
    expect(assistantKey, scenarioName) {
      const handle = {
        returns(fixturePath) {
          const list = expectations.get(assistantKey) || [];
          list.push({ scenarioName, fixturePath, fulfilled: false });
          expectations.set(assistantKey, list);
          return handle;
        },
      };
      return handle;
    },

    /**
     * Install the override hook so callMgaAssistant routes through this mock.
     * Idempotent: a second install() while already installed is a no-op.
     */
    install() {
      if (installed) return;
      priorOverride = globalThis[HOOK_KEY];
      globalThis[HOOK_KEY] = mockedCall;
      installed = true;
    },

    /**
     * Restore whatever was at globalThis[HOOK_KEY] before install().
     * (Usually undefined; an outer mock could nest by leaving its own
     * value in place, but Dispatch 1 doesn't exercise nested mocks.)
     */
    uninstall() {
      if (!installed) return;
      if (priorOverride === undefined) {
        delete globalThis[HOOK_KEY];
      } else {
        globalThis[HOOK_KEY] = priorOverride;
      }
      installed = false;
      priorOverride = undefined;
    },

    /**
     * The audit trail of calls the mock served. Order = call order.
     */
    callsMade() {
      return [...callsMade];
    },

    /**
     * Throws if any registered expectation was never called.
     */
    assertExpectationsMet() {
      const unmet = [];
      for (const [key, queue] of expectations.entries()) {
        for (const exp of queue) {
          if (!exp.fulfilled) {
            unmet.push(`${key} / ${exp.scenarioName} (${exp.fixturePath})`);
          }
        }
      }
      if (unmet.length > 0) {
        throw new Error(
          `mga-mock: ${unmet.length} expectation(s) not met:\n  - ${unmet.join('\n  - ')}`,
        );
      }
    },
  };
}
