import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SECRETS_PATH, CHAT_DATA_DIR, WORKSPACE_DIR } from './paths.js';
import { loadAssistantIds, HARNESS_ASSISTANT_KEYS, envVarFor } from '../config/assistant-ids.js';
import { MGA_PREFLIGHT_MS, MGA_VALIDATE_MS, MGA_HEALTH_PROBE_MS, DEFAULT_MODEL } from '../config/defaults.js';
import { logAndSwallow } from '../util/log-helpers.js';

// Parsed secrets file, or null when it does not exist yet.
function readSecretsFile() {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function harnessIds() {
  const fromConfig = loadAssistantIds();
  const out = {};
  for (const key of HARNESS_ASSISTANT_KEYS) {
    out[key] = process.env[envVarFor(key)] || fromConfig[key] || null;
  }
  return out;
}

function ensureChatDir() {
  if (!existsSync(CHAT_DATA_DIR)) {
    mkdirSync(CHAT_DATA_DIR, { recursive: true });
  }
}

/**
 * Resolve credentials in priority order:
 * 1. Environment variables (OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY)
 * 2. Stored secrets file (.chat/secrets.json)
 */
// The platform's myGenAssist endpoint. The vibe portal injects the user's key
// into their codespaces as the secret MYGENASSIST_API_KEY (nothing else), so
// with that alone the harness must be usable without a setup screen.
export const DEFAULT_MGA_BASE_URL = 'https://chat.int.bayer.com/api/v2';

export function getCredentials() {
  return resolveCredentials();
}

/**
 * Resolution order: explicit env (OPENAI_COMPAT_*) → the user's saved
 * settings (.chat/secrets.json) → the portal-injected codespace secret.
 * Injectable for tests.
 */
export function resolveCredentials({ env = process.env, secretsPath = SECRETS_PATH } = {}) {
  const envBaseUrl = env.OPENAI_COMPAT_BASE_URL;
  const envApiKey = env.OPENAI_COMPAT_API_KEY;
  if (envBaseUrl && envApiKey) {
    return {
      baseUrl: envBaseUrl,
      apiKey: envApiKey,
      model: env.OPENAI_COMPAT_MODEL || 'gpt-4.1-mini',
      ...harnessIds(),
      mode: env.CHAT_MODE || 'beginner',
      projectType: env.CHAT_PROJECT_TYPE || 'fresh',
      source: 'env',
    };
  }

  if (existsSync(secretsPath)) {
    try {
      const data = JSON.parse(readFileSync(secretsPath, 'utf-8'));
      if (data.baseUrl && data.apiKey) {
        return {
          baseUrl: data.baseUrl,
          apiKey: data.apiKey,
          model: data.model || 'gpt-4.1-mini',
          ...harnessIds(),
          mode: data.mode || 'beginner',
          projectType: data.projectType || 'fresh',
          source: 'file',
        };
      }
    } catch {
      // Corrupt file — treat as unconfigured
    }
  }

  if (env.MYGENASSIST_API_KEY) {
    return {
      baseUrl: env.MYGENASSIST_BASE_URL || DEFAULT_MGA_BASE_URL,
      apiKey: env.MYGENASSIST_API_KEY,
      model: env.MYGENASSIST_MODEL || DEFAULT_MODEL,
      ...harnessIds(),
      mode: env.CHAT_MODE || 'beginner',
      projectType: env.CHAT_PROJECT_TYPE || 'fresh',
      source: 'codespace-secret',
    };
  }

  return null;
}

export function saveCredentials({ baseUrl, apiKey, model }) {
  ensureChatDir();
  // Preserve existing preferences when re-saving credentials
  let existing = {};
  try { existing = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8')); } catch { /* first save, or unreadable */ }
  const data = {
    baseUrl,
    apiKey,
    model: model || existing.model || 'gpt-4.1-mini',
    mode: existing.mode || 'beginner',
    projectType: existing.projectType || 'fresh',
  };
  writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2) + '\n');
}

export function mountAuthRoutes(app) {
  app.get('/api/auth/status', (_req, res) => {
    const creds = getCredentials();
    res.json({
      configured: !!creds,
      source: creds?.source || null,
      mode: creds?.mode || 'beginner',
      // Where the user came from when a portal launched this workspace; the
      // "workspace went to sleep" card sends them back there (the portal
      // starts the codespace and reopens the harness) instead of the editor.
      portalUrl: process.env.VIBE_PORTAL_URL || null,
      // The portal uses this to land on the list with this project in focus.
      projectName: path.basename(WORKSPACE_DIR),
    });
  });

  app.get('/api/auth/settings', (_req, res) => {
    const creds = getCredentials();
    if (!creds) return res.json({ configured: false });
    // Mask the API key — show first 4 and last 4 chars
    const key = creds.apiKey || '';
    const maskedKey = key.length > 10
      ? key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4)
      : '****';
    res.json({
      configured: true,
      source: creds.source,
      baseUrl: creds.baseUrl,
      apiKey: maskedKey,
      model: creds.model,
      mode: creds.mode,
    });
  });

  app.get('/api/auth/models', async (_req, res) => {
    const creds = getCredentials();
    if (!creds) return res.json({ models: [] });

    try {
      const modelsUrl = creds.baseUrl.replace(/\/$/, '') + '/models';
      const resp = await fetch(modelsUrl, {
        headers: { 'Authorization': `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(MGA_PREFLIGHT_MS),
      });
      if (!resp.ok) return res.json({ models: [], error: `API returned ${resp.status}` });
      const data = await resp.json();
      const raw = data.data || data.models || data || [];
      const models = Array.isArray(raw)
        ? raw.map(m => typeof m === 'string'
            ? { id: m, name: m }
            : { id: m.id || m.name, name: m.name || m.display_name || m.id })
            .filter(m => m.id)
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];
      res.json({ models });
    } catch (err) {
      logAndSwallow(err, '[auth] Failed to fetch models');
      res.json({ models: [], error: err.message });
    }
  });

  // ── MGA models using a provided API key (for live key validation in Settings UI) ──
  app.post('/api/auth/models-for-key', async (req, res) => {
    const { apiKey } = req.body || {};
    if (!apiKey) return res.json({ models: [], error: 'apiKey is required' });

    // Use fixed MGA base URL — settings panel is MGA-only
    const MGA_BASE = 'https://chat.int.bayer.com/api/v2';
    try {
      const url = MGA_BASE + '/models?include_hidden_models=true&include_aliases=true';
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(MGA_VALIDATE_MS),
      });
      if (!resp.ok) return res.json({ models: [], error: `API returned ${resp.status}` });
      const data = await resp.json();
      const raw = data.data || data.models || data || [];
      const models = Array.isArray(raw)
        ? raw.map(m => typeof m === 'string'
            ? { id: m, name: m }
            : { id: m.id || m.name, name: m.name || m.display_name || m.id })
            .filter(m => m.id)
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];
      res.json({ models });
    } catch (err) {
      logAndSwallow(err, '[auth] models-for-key failed');
      res.json({ models: [], error: err.message });
    }
  });

  // ── MGA / Bayer Chat models endpoint (uses stored creds) ──────────────────
  app.get('/api/auth/mga-models', async (_req, res) => {
    const creds = getCredentials();
    if (!creds) return res.json({ models: [], error: 'No credentials configured' });

    try {
      const url = creds.baseUrl.replace(/\/$/, '') + '/models?include_hidden_models=true&include_aliases=true';
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(MGA_VALIDATE_MS),
      });
      if (!resp.ok) return res.json({ models: [], error: `MGA API returned ${resp.status}` });
      const data = await resp.json();
      const raw = data.data || data.models || data || [];
      const models = Array.isArray(raw)
        ? raw.map(m => typeof m === 'string'
            ? { id: m, name: m }
            : { id: m.id || m.name, name: m.name || m.display_name || m.id })
            .filter(m => m.id)
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];
      res.json({ models });
    } catch (err) {
      logAndSwallow(err, '[auth] Failed to fetch MGA models');
      res.json({ models: [], error: err.message });
    }
  });

  // ── Health check endpoint (LLM API + Assistant only, using stored secrets.json creds) ──
  app.get('/api/auth/health', async (_req, res) => {
    const creds = getCredentials();

    const checks = await Promise.allSettled([
      // 1. LLM API connectivity — try models list
      (async () => {
        if (!creds) throw new Error('No credentials configured');
        const url = creds.baseUrl.replace(/\/$/, '') + '/models';
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${creds.apiKey}` },
          signal: AbortSignal.timeout(MGA_HEALTH_PROBE_MS),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const count = (data.data || data.models || []).length;
        return { ok: true, detail: `${count} model(s) available` };
      })(),

      // 2. Router assistant connectivity — verifies the harness's router ID
      // is reachable with the user's per-codespace credentials.
      (async () => {
        if (!creds) throw new Error('No credentials configured');
        if (!creds.routerAssistantId) return { ok: true, detail: 'No router assistant ID configured (skipped)' };
        const url = creds.baseUrl.replace(/\/$/, '') + `/assistants/${creds.routerAssistantId}`;
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${creds.apiKey}` },
          signal: AbortSignal.timeout(MGA_HEALTH_PROBE_MS),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, detail: `Router ${creds.routerAssistantId.slice(0, 8)}… reachable` };
      })(),
    ]);

    const [llm, assistant] = checks;

    res.json({
      llm: llm.status === 'fulfilled'
        ? llm.value
        : { ok: false, detail: llm.reason?.message || 'Unknown error' },
      assistant: assistant.status === 'fulfilled'
        ? assistant.value
        : { ok: false, detail: assistant.reason?.message || 'Unknown error' },
    });
  });

  app.post('/api/auth/config', (req, res) => {
    const { baseUrl, apiKey, model } = req.body;
    if (!baseUrl || !apiKey) {
      return res.status(400).json({ error: 'baseUrl and apiKey are required' });
    }
    saveCredentials({ baseUrl, apiKey, model });
    res.json({ ok: true });
  });

  // ── Update model only (preserves stored apiKey) ───────────────────────────
  app.post('/api/auth/config-model', (req, res) => {
    const { model } = req.body || {};
    if (!model) return res.status(400).json({ error: 'model is required' });
    const data = readSecretsFile();
    if (!data) {
      return res.status(400).json({ error: 'No configuration found — save your API key first' });
    }
    try {
      data.model = model;
      writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2) + '\n');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update model' });
    }
  });

  // ── Update baseUrl and/or model without requiring a new API key ───────────
  app.post('/api/auth/config-connection', (req, res) => {
    const { baseUrl, model } = req.body || {};
    const data = readSecretsFile();
    if (!data) {
      return res.status(400).json({ error: 'No configuration found — save your API key first' });
    }
    try {
      if (baseUrl) data.baseUrl = baseUrl;
      if (model)   data.model   = model;
      writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2) + '\n');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update connection settings' });
    }
  });

  app.post('/api/auth/preferences', (req, res) => {
    const { mode, projectType } = req.body;
    const data = readSecretsFile();
    if (!data) {
      return res.status(400).json({ error: 'No configuration found' });
    }
    try {
      if (mode) data.mode = mode;
      if (projectType) data.projectType = projectType;
      writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2) + '\n');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update preferences' });
    }
  });
}
