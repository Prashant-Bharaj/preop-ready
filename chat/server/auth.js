import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SECRETS_PATH, CHAT_DATA_DIR } from './paths.js';

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
export function getCredentials() {
  const envBaseUrl = process.env.OPENAI_COMPAT_BASE_URL;
  const envApiKey = process.env.OPENAI_COMPAT_API_KEY;
  if (envBaseUrl && envApiKey) {
    return {
      baseUrl: envBaseUrl,
      apiKey: envApiKey,
      model: process.env.OPENAI_COMPAT_MODEL || 'gpt-4.1-mini',
      assistantId: process.env.ASSISTANT_ID || null,
      mode: process.env.CHAT_MODE || 'beginner',
      projectType: process.env.CHAT_PROJECT_TYPE || 'fresh',
      source: 'env',
    };
  }

  if (existsSync(SECRETS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'));
      if (data.baseUrl && data.apiKey) {
        return {
          baseUrl: data.baseUrl,
          apiKey: data.apiKey,
          model: data.model || 'gpt-4.1-mini',
          assistantId: data.assistantId || process.env.ASSISTANT_ID || null,
          mode: data.mode || 'beginner',
          projectType: data.projectType || 'fresh',
          source: 'file',
        };
      }
    } catch {
      // Corrupt file — treat as unconfigured
    }
  }

  return null;
}

export function saveCredentials({ baseUrl, apiKey, model, assistantId }) {
  ensureChatDir();
  // Preserve existing preferences when re-saving credentials
  let existing = {};
  if (existsSync(SECRETS_PATH)) {
    try { existing = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8')); } catch { /* ignore */ }
  }
  const data = {
    baseUrl,
    apiKey,
    model: model || 'gpt-4.1-mini',
    mode: existing.mode || 'beginner',
    projectType: existing.projectType || 'fresh',
  };
  // Preserve or set assistantId
  if (assistantId) data.assistantId = assistantId;
  else if (existing.assistantId) data.assistantId = existing.assistantId;
  writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2) + '\n');
}

export function mountAuthRoutes(app) {
  app.get('/api/auth/status', (_req, res) => {
    const creds = getCredentials();
    res.json({ configured: !!creds, source: creds?.source || null, mode: creds?.mode || 'beginner' });
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
      assistantId: creds.assistantId || '',
      mode: creds.mode,
    });
  });

  app.get('/api/auth/models', async (_req, res) => {
    const creds = getCredentials();
    if (!creds) return res.json({ models: [] });

    try {
      // Use OpenAI-compatible models endpoint: baseUrl + /models
      const modelsUrl = creds.baseUrl.replace(/\/$/, '') + '/models';

      const resp = await fetch(modelsUrl, {
        headers: { 'Authorization': `Bearer ${creds.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        return res.json({ models: [], error: `API returned ${resp.status}` });
      }

      const data = await resp.json();
      // OpenAI format: { data: [{ id, ... }] } or platform format: { models: [...] }
      const raw = data.data || data.models || data || [];
      const models = Array.isArray(raw)
        ? raw.map(m => typeof m === 'string' ? m : m.id || m.name).filter(Boolean).sort()
        : [];

      res.json({ models });
    } catch (err) {
      console.error('[auth] Failed to fetch models:', err.message);
      res.json({ models: [], error: err.message });
    }
  });

  app.post('/api/auth/config', (req, res) => {
    const { baseUrl, apiKey, model, assistantId } = req.body;
    if (!baseUrl || !apiKey) {
      return res.status(400).json({ error: 'baseUrl and apiKey are required' });
    }
    saveCredentials({ baseUrl, apiKey, model, assistantId });
    res.json({ ok: true });
  });

  app.post('/api/auth/preferences', (req, res) => {
    const { mode, projectType } = req.body;
    if (!existsSync(SECRETS_PATH)) {
      return res.status(400).json({ error: 'No configuration found' });
    }
    try {
      const data = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'));
      if (mode) data.mode = mode;
      if (projectType) data.projectType = projectType;
      writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2) + '\n');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update preferences' });
    }
  });
}
