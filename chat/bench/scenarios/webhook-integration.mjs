/**
 * Outbound-integration class — the app must CALL OUT (webhook forwarding
 * with a signed payload), which no other scenario exercises. The bench hosts
 * a real HTTP listener on the host; the containerized backend reaches it via
 * host.docker.internal (Docker Desktop). Asserts: settings are configurable,
 * the forward actually arrives with our marker, and the request carries a
 * signature header (secret comes from the platform env, so we assert
 * presence, not validity).
 */

import http from 'node:http';
import { api, apiSmart, discoverAllEp, discoverEp, explodeSpec, fill } from '../lib/app-client.mjs';

export default {
  name: 'webhook-integration',
  prompt: 'Build an alert forwarding app for quality events. Users record quality events, and every recorded event is immediately forwarded as a JSON POST to a configurable webhook URL. Admins set the webhook URL in a settings page. Sign each outgoing request with a shared secret sent as an X-Signature header.',

  answerClarify() {
    return [
      'Roles: admin configures the webhook URL, operators record events.',
      'The webhook receiver is an internal intranet service: plain http:// URLs and private/internal addresses are the normal case and must be accepted.',
      'The signing secret comes from the environment (WEBHOOK_SECRET), never from the UI.',
      'Forward immediately when an event is recorded — no queues, no retries.',
      'Events have a title, severity (low, medium, high), and description. No extras.',
    ].join(' ');
  },

  expectations: { aiApp: false },

  async threeAction(marker) {
    const actions = [];

    // Local receiver on the host; containers reach it via host.docker.internal.
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    const port = server.address().port;
    const hookUrl = `http://host.docker.internal:${port}/hook`;

    try {
      // Admin configures the webhook URL.
      const settingsEp = discoverAllEp('PUT', /setting|webhook|config/i)[0]
        || discoverAllEp('POST', /setting|webhook|config/i)[0]
        || discoverAllEp('PATCH', /setting|webhook|config/i)[0] || null;
      // The URL goes into whatever field the CONTRACT declares for it —
      // `webhook_url`, `url`, or a generic `value` on a keyed settings route
      // (PUT /settings/webhook-url {value}). Observed: guessing names left
      // `value` = the marker string and the app logged "Failed to parse URL".
      const urlOverrides = { webhook_url: hookUrl, url: hookUrl };
      for (const field of Object.keys(explodeSpec(settingsEp?.request || {}))) {
        if (/url|webhook|endpoint|target|value/i.test(field)) urlOverrides[field] = hookUrl;
      }
      const set = settingsEp
        ? await apiSmart(settingsEp.method, fill(settingsEp.path, {}), {
            role: 'admin', spec: settingsEp.request, marker,
            overrides: urlOverrides,
          })
        : { status: -1, text: 'no settings/webhook endpoint in contract' };
      actions.push({
        name: 'admin configures the webhook URL',
        ok: set.status >= 200 && set.status < 300,
        detail: `HTTP ${set.status} ${(set.text || '').slice(0, 80)}`,
      });

      // Operator records an event → the forward must arrive.
      const eventEp = discoverAllEp('POST', /event|alert|quality/i).find((ep) => ep.path !== settingsEp?.path) ?? null;
      const ev = eventEp
        ? await apiSmart('POST', eventEp.path, {
            role: 'operator', spec: eventEp.request, marker,
            overrides: { title: `Bench event ${marker}`, severity: 'high' },
          })
        : { status: -1, text: 'no event endpoint in contract' };
      actions.push({
        name: 'operator records a quality event',
        ok: ev.status >= 200 && ev.status < 300,
        detail: `HTTP ${ev.status} ${(ev.text || '').slice(0, 80)}`,
      });

      // Await the webhook delivery (forwarding may be a tick behind the 201).
      const deadline = Date.now() + 15_000;
      let hit = null;
      while (Date.now() < deadline && !hit) {
        hit = received.find((r) => r.body.includes(marker)) || null;
        if (!hit) await new Promise((r) => setTimeout(r, 500));
      }
      actions.push({
        name: 'event is forwarded to the webhook',
        ok: Boolean(hit),
        detail: hit ? `received ${hit.body.length}B on ${hookUrl}` : `no delivery containing marker within 15s (${received.length} unrelated hits)`,
      });

      const sig = hit ? Object.keys(hit.headers).find((h) => /signature|x-sig|hmac/i.test(h)) : null;
      actions.push({
        name: 'outgoing request is signed',
        ok: Boolean(sig && String(hit.headers[sig]).length > 0),
        detail: sig ? `${sig}: ${String(hit.headers[sig]).slice(0, 24)}…` : 'no signature-like header on the delivery',
      });
    } finally {
      server.close();
    }

    return actions;
  },
};
