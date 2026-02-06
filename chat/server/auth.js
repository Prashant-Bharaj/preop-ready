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
          source: 'file',
        };
      }
    } catch {
      // Corrupt file — treat as unconfigured
    }
  }

  return null;
}

export function saveCredentials({ baseUrl, apiKey, model }) {
  ensureChatDir();
  writeFileSync(
    SECRETS_PATH,
    JSON.stringify({ baseUrl, apiKey, model: model || 'gpt-4.1-mini' }, null, 2) + '\n'
  );
}

export function mountAuthRoutes(app) {
  app.get('/api/auth/status', (_req, res) => {
    const creds = getCredentials();
    res.json({ configured: !!creds, source: creds?.source || null });
  });

  app.post('/api/auth/config', (req, res) => {
    const { baseUrl, apiKey, model } = req.body;
    if (!baseUrl || !apiKey) {
      return res.status(400).json({ error: 'baseUrl and apiKey are required' });
    }
    saveCredentials({ baseUrl, apiKey, model });
    res.json({ ok: true });
  });
}
