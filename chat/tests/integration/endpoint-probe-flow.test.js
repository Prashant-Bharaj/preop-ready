/**
 * Coverage: post-compose endpoint verification flow via chain
 *   probe (live HTTP) → failures formatted → buildFixDirective frames the
 *   endpoint-probe source → (fix lands — simulated by the stub server
 *   healing) → filtered re-probe passes → recovery record carries
 *   triggeredBy='smoke'.
 *
 * Integration tier: real production modules (endpoint-probe, buildFixDirective,
 * pushAutoRecoveryRecord). No MGA, no Docker — the app under probe is a
 * scripted node:http server standing in for the frontend nginx proxy.
 * Same composition posture as auto-recovery-flow.test.js (the full
 * runEndpointVerificationLoop assembly dynamic-imports runCustomAgent, which
 * would need an esm loader hook to stub).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  probeApiEndpoints,
  formatProbeFailures,
} from '../../server/reconciler/endpoint-probe.js';
import { buildFixDirective, pushAutoRecoveryRecord } from '../../server/session/auto-recovery.js';
import { MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE } from '../../server/config/defaults.js';

const CONTRACT = {
  endpoints: [
    { method: 'POST', path: '/recipes/generate', request: { ingredients: 'string' } },
    { method: 'GET', path: '/recipes' },
    { method: 'GET', path: '/health' },
  ],
};

function startApp() {
  // Starts broken: the AI endpoint 502s until `healed` flips — the stand-in
  // for a successful fix dispatch + rebuild.
  const state = { healed: false };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/recipes/generate' && !state.healed) {
        res.writeHead(502);
        res.end('<html>502 Bad Gateway</html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('probe → directive → heal → filtered re-probe → recovery record', async () => {
  const { server, state, url } = await startApp();
  try {
    const timeouts = { requestMs: 2000, aiRequestMs: 2000, totalMs: 20000 };

    // Round 1: the AI endpoint fails, everything else passes.
    const round1 = await probeApiEndpoints({ baseUrl: url, apiContract: CONTRACT, timeouts });
    assert.equal(round1.probed, 3);
    assert.equal(round1.failed.length, 1);
    assert.equal(round1.failed[0].path, '/recipes/generate');
    assert.equal(round1.failed[0].status, 502);

    // The directive frames the failure with endpoint, status, and log tail.
    const directive = buildFixDirective('backend', [{
      source: 'endpoint-probe',
      errorCount: round1.failed.length,
      formatted: formatProbeFailures(round1.failed, { logsTail: 'ENOTFOUND mga.platform.bayer.com' }),
    }]);
    assert.match(directive, /POST \/recipes\/generate — HTTP 502/);
    assert.match(directive, /ENOTFOUND mga\.platform\.bayer\.com/);
    assert.match(directive, /attempt_completion/);

    // The recovery record for a probe-triggered fix uses triggeredBy='smoke'.
    const session = { id: 'probe-flow-test' };
    pushAutoRecoveryRecord(session, {
      scope: 'backend',
      attemptN: 1,
      triggeredBy: 'smoke',
      failureSummary: '1 endpoint(s) failing live probe',
      exhausted: false,
    });
    assert.equal(session.autoRecoveryAttempts.length, 1);
    assert.equal(session.autoRecoveryAttempts[0].triggeredBy, 'smoke');
    assert.ok(session.autoRecoveryAttempts[0].attemptN <= MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE);

    // Fix lands (simulated) → filtered re-probe touches only the failed key.
    state.healed = true;
    const failedKeys = new Set(round1.failed.map((f) => `${f.method} ${f.path}`));
    const round2 = await probeApiEndpoints({
      baseUrl: url,
      apiContract: CONTRACT,
      filter: (s) => failedKeys.has(`${s.method} ${s.path}`),
      timeouts,
    });
    assert.equal(round2.probed, 1);
    assert.equal(round2.failed.length, 0);
  } finally {
    server.close();
  }
});

test('budget exhaustion surfaces still-broken endpoints', async () => {
  const { server, url } = await startApp(); // never healed
  try {
    const timeouts = { requestMs: 2000, aiRequestMs: 2000, totalMs: 20000 };
    let result = await probeApiEndpoints({ baseUrl: url, apiContract: CONTRACT, timeouts });
    let attempts = 0;
    while (result.failed.length > 0 && attempts < MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE) {
      attempts++;
      const failedKeys = new Set(result.failed.map((f) => `${f.method} ${f.path}`));
      result = await probeApiEndpoints({
        baseUrl: url, apiContract: CONTRACT,
        filter: (s) => failedKeys.has(`${s.method} ${s.path}`),
        timeouts,
      });
    }
    assert.equal(attempts, MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE);
    assert.equal(result.failed.length, 1, 'still broken after budget');
  } finally {
    server.close();
  }
});
