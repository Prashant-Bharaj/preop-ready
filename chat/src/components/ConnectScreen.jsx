import { useState } from 'react';
import { saveAuthConfig } from '../lib/api.js';

const BAYER_MGA_BASE_URL = 'https://chat.int.bayer.com/api/v2';

export default function ConnectScreen({ onConnected }) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!apiKey.trim()) {
      setError('API Key is required.');
      return;
    }

    setSaving(true);
    try {
      const result = await saveAuthConfig({
        baseUrl: BAYER_MGA_BASE_URL,
        apiKey: apiKey.trim(),
      });
      if (result.ok) {
        onConnected();
      } else {
        setError(result.error || 'Failed to save configuration.');
      }
    } catch {
      setError('Could not connect to the runner service. Make sure the server is running.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="connect-screen">
      <div className="connect-card">
        <div className="connect-header">
          <span className="connect-emoji" role="img" aria-label="key">🔑</span>
          <h1>Connect to AI</h1>
          <p className="subtitle">
            Paste your Bayer MGA API key to start building.
          </p>
        </div>

        <div className="connect-help">
          💡 Get your key from <a href="https://chat.int.bayer.com" target="_blank" rel="noreferrer">chat.int.bayer.com</a> — the same one you use for the MGA portal.
        </div>

        <form onSubmit={handleSubmit}>
          <label>
            API Key <span className="required">*</span>
            <input
              type="password"
              placeholder="mga-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              aria-required="true"
              autoFocus
            />
          </label>

          {error && <div className="error-msg" role="alert">{error}</div>}

          <button type="submit" disabled={saving}>
            {saving ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
