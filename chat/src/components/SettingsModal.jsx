import { useState, useEffect } from 'react';
import { getAuthSettings, saveAuthConfig, getModels } from '../lib/api.js';
import { CloseIcon } from './Icon.jsx';

export default function SettingsModal({ open, onClose, onSaved }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [assistantId, setAssistantId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setLoading(true);

    Promise.all([
      getAuthSettings(),
      getModels().catch(() => ({ models: [] })),
    ]).then(([settings, modelsData]) => {
      if (settings.configured) {
        setBaseUrl(settings.baseUrl || '');
        setApiKey('');
        setModel(settings.model || '');
        setAssistantId(settings.assistantId || '');
        setSource(settings.source);
      }
      setModels(modelsData.models || []);
    })
    .catch(() => setError('Failed to load current settings'))
    .finally(() => setLoading(false));
  }, [open]);

  async function handleRefreshModels() {
    setModelsLoading(true);
    try {
      const data = await getModels();
      setModels(data.models || []);
      if (data.error) setError(`Could not fetch models: ${data.error}`);
    } catch {
      setError('Failed to fetch models list');
    } finally {
      setModelsLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!baseUrl.trim() || !apiKey.trim()) {
      setError('Base URL and API Key are required.');
      return;
    }

    setSaving(true);
    try {
      const result = await saveAuthConfig({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
        assistantId: assistantId.trim() || undefined,
      });
      if (result.ok) {
        onSaved?.();
        onClose();
      } else {
        setError(result.error || 'Failed to save.');
      }
    } catch {
      setError('Could not save settings. Check that the server is running.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="drawer-close-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {source === 'env' && (
          <div className="settings-env-notice">
            Credentials are set via environment variables. Changes here will be saved to the config file but env vars take priority.
          </div>
        )}

        {loading ? (
          <div className="settings-loading">Loading...</div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label>
              Base URL <span className="required">*</span>
              <input
                type="url"
                placeholder="https://your-endpoint.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
              />
            </label>

            <label>
              API Key <span className="required">*</span>
              <input
                type="password"
                placeholder="Enter new API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
              />
              <span className="settings-hint">Must re-enter to save changes</span>
            </label>

            <label>
              Model
              <div className="settings-model-row">
                {models.length > 0 ? (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {!models.includes(model) && model && (
                      <option value={model}>{model}</option>
                    )}
                    {models.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder="gpt-4.1-mini"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="settings-refresh-btn"
                  onClick={handleRefreshModels}
                  disabled={modelsLoading}
                  title="Refresh models list"
                >
                  {modelsLoading ? '...' : 'Refresh'}
                </button>
              </div>
            </label>

            <label>
              Assistant ID <span className="optional">(optional)</span>
              <input
                type="text"
                placeholder="UUID of the router assistant"
                value={assistantId}
                onChange={(e) => setAssistantId(e.target.value)}
              />
              <span className="settings-hint">Routes messages through an assistant before Cline</span>
            </label>

            {error && <div className="error-msg" role="alert">{error}</div>}

            <button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save settings'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
