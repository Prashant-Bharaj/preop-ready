import { useState } from 'react';
import { saveAuthConfig } from '../lib/api.js';

export default function ConnectScreen({ onConnected }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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
      });
      if (result.ok) {
        onConnected();
      } else {
        setError(result.error || 'Failed to save configuration.');
      }
    } catch {
      setError('Could not connect to the runner service.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <h1>Connect to LLM</h1>
        <p className="subtitle">
          Enter your OpenAI-compatible endpoint credentials to start chatting.
        </p>

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
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
          </label>

          <label>
            Model <span className="optional">(optional)</span>
            <input
              type="text"
              placeholder="gpt-4.1-mini"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>

          {error && <div className="error-msg">{error}</div>}

          <button type="submit" disabled={saving}>
            {saving ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
