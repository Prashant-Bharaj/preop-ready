/**
 * App secrets routes.
 *
 *   GET  /api/app-secrets               — list slots; never returns values
 *   PUT  /api/app-secrets/:name         — partial update of value and/or description
 *   POST /api/app-secrets/:name/sync    — push value to GitHub Actions via `gh`
 *
 * Values flow only through the loopback Express server — never through the
 * WebSocket event stream that powers the chat transcript. Responses always
 * report whether a slot is set, never the value itself.
 *
 * The slot universe is closed: PREDEFINED_SLOTS in app-secrets-scaffold.js
 * mirrors the secrets: block in .github/workflows/deploy.yml. Anything else
 * is rejected — those names wouldn't reach the deployed container anyway.
 */

import { execFileSync } from 'node:child_process';
import {
  PREDEFINED_SLOTS,
  PREDEFINED_SLOT_NAMES,
  readBackendEnv,
  writeBackendEnv,
  sanitizeDescription,
  readWorkspaceMgaEnv,
} from '../core/app-secrets-scaffold.js';
import { refreshSensitiveStrings } from '../core/redact-refresh.js';
import { WORKSPACE_DIR } from '../core/paths.js';

// Probe `gh` once per process — cheap, and lets the panel tell the user
// whether sync is even possible before they click. `gh auth status`
// succeeds inside an authenticated Codespace and fails (non-zero exit)
// outside.
let ghStatusCache = null;
function probeGh() {
  if (ghStatusCache) return ghStatusCache;
  try {
    execFileSync('gh', ['auth', 'status'], { cwd: WORKSPACE_DIR, stdio: 'ignore', timeout: 5000 });
    ghStatusCache = { available: true };
  } catch {
    ghStatusCache = { available: false };
  }
  return ghStatusCache;
}

/**
 * Look up which APP_* secrets already exist in GitHub Actions for the
 * current repo. Returns a Set of slot names (without the APP_ prefix). On
 * any failure we return an empty Set — the panel still works, it just
 * can't show the synced ✓ indicator.
 */
function listGhSyncedSlots() {
  if (!probeGh().available) return new Set();
  try {
    const out = execFileSync('gh', ['secret', 'list', '--json', 'name'], {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: 8000,
    });
    const arr = JSON.parse(out);
    const set = new Set();
    for (const row of arr) {
      const name = row?.name || '';
      if (name.startsWith('APP_')) {
        const slot = name.slice('APP_'.length);
        if (PREDEFINED_SLOT_NAMES.includes(slot)) set.add(slot);
      }
    }
    return set;
  } catch {
    return new Set();
  }
}

export function mountAppSecretsRoutes(app) {
  // ── GET /api/app-secrets ─────────────────────────────────────────────────
  // Returns slot metadata only. Never the value. The synced flag is best-effort.
  app.get('/api/app-secrets', (_req, res) => {
    const env = readBackendEnv(WORKSPACE_DIR);
    const synced = listGhSyncedSlots();
    const slots = PREDEFINED_SLOTS.map(({ name, kind }) => ({
      name,
      kind,
      isSet: env[name].isSet,
      description: env[name].description,
      syncedToGitHub: synced.has(name),
    }));
    res.json({
      slots,
      gh: probeGh(),
      // Harness-managed MGA credentials (workspace-root .env) — read-only
      // status for the panel; never the key value.
      mga: readWorkspaceMgaEnv(WORKSPACE_DIR),
    });
  });

  // ── PUT /api/app-secrets/:name ───────────────────────────────────────────
  // Body: { value?, description? }. Either or both may be supplied.
  // - String value updates the value (empty string clears).
  // - String description updates the description (empty string clears).
  // - Field absent → leave that aspect alone.
  // Description is only valid on generic slots (SECRET_1/2/3); the writer
  // also enforces this, but we surface a 400 here for a clearer error.
  app.put('/api/app-secrets/:name', (req, res) => {
    const { name } = req.params;
    const meta = PREDEFINED_SLOTS.find((s) => s.name === name);
    if (!meta) {
      return res.status(400).json({ error: `Unknown slot: ${name}` });
    }

    const body = req.body || {};
    const update = {};

    if (typeof body.value === 'string') {
      update.value = body.value;
    }

    if (typeof body.description === 'string') {
      if (meta.kind !== 'generic') {
        return res.status(400).json({ error: `Cannot edit description for named slot ${name}` });
      }
      // Sanity-check length up front so a 400 is returned (instead of 500
      // from the writer's safety-net throw).
      try {
        sanitizeDescription(body.description);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      update.description = body.description;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update — pass value and/or description in the body.' });
    }

    try {
      const result = writeBackendEnv(WORKSPACE_DIR, name, update);
      // Refresh redaction list so an active session [REDACTED]s the new
      // value immediately — without this, the user has to start a new
      // chat before the redact pipeline knows about it.
      refreshSensitiveStrings();
      // Response intentionally minimal — never echo the value back. The
      // description is safe to return (it was either user-supplied just
      // now or already public via the GET endpoint).
      res.json({ ok: true, name, isSet: result.isSet, description: result.description });
    } catch (err) {
      console.error('[app-secrets] write failed for %s: %s', name, err.message);
      res.status(500).json({ error: 'Failed to write secret. Check chat server logs.' });
    }
  });

  // ── POST /api/app-secrets/:name/sync ─────────────────────────────────────
  // Pushes the current value to GitHub Actions as APP_<name>. The value is
  // read from backend/.env on the server — clients never re-send it.
  app.post('/api/app-secrets/:name/sync', (req, res) => {
    const { name } = req.params;
    if (!PREDEFINED_SLOT_NAMES.includes(name)) {
      return res.status(400).json({ error: `Unknown slot: ${name}` });
    }
    if (!probeGh().available) {
      return res.status(412).json({ error: 'gh CLI not authenticated. Run `gh auth login` and retry.' });
    }
    const env = readBackendEnv(WORKSPACE_DIR);
    if (!env[name].isSet) {
      return res.status(400).json({ error: `${name} is not set locally — fill the value first.` });
    }

    try {
      // execFileSync passes args literally — no shell, no quoting bugs even
      // for values containing spaces, $, backticks, etc. `gh secret set`
      // accepts the value via stdin when --body-file is `-`, which keeps
      // the value off the process argv where another user on the box could
      // see it via `ps`. Single-tenant Codespace, but cheap defense.
      execFileSync('gh', ['secret', 'set', `APP_${name}`, '--body-file', '-'], {
        cwd: WORKSPACE_DIR,
        input: env[name].value,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15_000,
      });
      res.json({ ok: true, name, syncedToGitHub: true });
    } catch (err) {
      // err.stderr may contain the gh error message — surface a redacted
      // version. The value itself is never in stderr (gh hides it).
      const stderr = err?.stderr?.toString?.() || err.message || 'unknown';
      console.error('[app-secrets] sync failed for %s: %s', name, stderr.slice(0, 200));
      res.status(500).json({ error: `gh secret set failed: ${stderr.split('\n')[0].slice(0, 200)}` });
    }
  });
}
