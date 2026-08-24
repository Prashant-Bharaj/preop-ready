import { useState, useEffect, useCallback } from 'react';
import { getAuthSettings, saveAuthConfig, saveConnectionConfig, getHealthStatus } from '../lib/api.js';
import { getThemePref, setThemePref, THEME_PREFS } from '../lib/theme.js';
import { CloseIcon } from './Icon.jsx';

const DEFAULT_MGA_BASE_URL = 'https://chat.int.bayer.com/api/v2';

export default function SettingsModal({ open, onClose, onSaved, showTokenBar = true, onToggleTokenBar }) {
  const [themePref, setThemePrefState] = useState(getThemePref());
  const [baseUrl, setBaseUrl]   = useState(DEFAULT_MGA_BASE_URL);
  const [apiKey, setApiKey]     = useState('');
  const [maskedApiKey, setMaskedApiKey] = useState('');
  const [error, setError]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [loading, setLoading]   = useState(true);

  // Health check state
  const [health, setHealth]             = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);

  // ── run health checks ─────────────────────────────────────────────────────
  const runHealthCheck = useCallback(async () => {
    setHealthLoading(true);
    try {
      const data = await getHealthStatus();
      setHealth(data);
    } catch {
      setHealth({
        llm:       { ok: false, detail: 'Could not reach server' },
        assistant: { ok: false, detail: 'Could not reach server' },
      });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  // ── load settings + health on open ───────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setError('');
    setLoading(true);
    setHealth(null);
    setApiKey('');
    setMaskedApiKey('');

    Promise.all([
      getAuthSettings(),
      runHealthCheck(),
    ]).then(([settings]) => {
      if (settings.configured) {
        setBaseUrl(settings.baseUrl || DEFAULT_MGA_BASE_URL);
        setMaskedApiKey(settings.apiKey || '');
      }
    })
    .catch(() => setError('Failed to load current settings'))
    .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    const trimmedKey = apiKey.trim();
    const trimmedUrl = baseUrl.trim() || DEFAULT_MGA_BASE_URL;

    setSaving(true);
    try {
      if (trimmedKey) {
        // New API key → full save
        const result = await saveAuthConfig({ baseUrl: trimmedUrl, apiKey: trimmedKey });
        if (result.ok) {
          onSaved?.();
          onClose();
        } else {
          setError(result.error || 'Failed to save.');
        }
      } else {
        // No new API key → preserve stored one, update baseUrl only
        const settings = await getAuthSettings();
        if (!settings.configured) {
          setError('API key is required when no key is currently saved.');
          setSaving(false);
          return;
        }
        const result = await saveConnectionConfig({ baseUrl: trimmedUrl });
        if (result.ok) {
          onSaved?.();
          onClose();
        } else {
          setError(result.error || 'Failed to save settings.');
        }
      }
    } catch {
      setError('Could not save settings. Check that the server is running.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  // ── helpers ───────────────────────────────────────────────────────────────
  function HealthPill({ status }) {
    if (!status) return <span className="health-pill health-checking">● Checking…</span>;
    return status.ok
      ? <span className="health-pill health-ok">● Connected</span>
      : <span className="health-pill health-err">● Error</span>;
  }

  function HealthRow({ label, status }) {
    return (
      <div className="health-row">
        <span className="health-label">{label}</span>
        <HealthPill status={status} />
        {status && (
          <span className={`health-detail ${status.ok ? 'health-detail-ok' : 'health-detail-err'}`}>
            {status.detail}
          </span>
        )}
      </div>
    );
  }

  const hasNewKey = apiKey.trim().length > 0;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="drawer-close-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        {/* ── Connection Health ── */}
        <div className="health-panel">
          <div className="health-panel-header">
            <span className="health-panel-title">Connection Health</span>
            <button
              type="button"
              className="settings-refresh-btn"
              onClick={runHealthCheck}
              disabled={healthLoading}
              title="Re-run connection checks"
            >
              {healthLoading ? '…' : '↺ Re-check'}
            </button>
          </div>
          <HealthRow label="LLM API"          status={healthLoading ? null : health?.llm} />
          <HealthRow label="Router assistant" status={healthLoading ? null : health?.assistant} />
        </div>

        {loading ? (
          <div className="settings-loading">Loading…</div>
        ) : (
          <form onSubmit={handleSubmit}>

            {/* ── Base URL ── */}
            <label>
              Base URL <span className="required">*</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://chat.int.bayer.com/api/v2"
                autoComplete="off"
              />
              <span className="settings-hint">
                API base URL — update only if your endpoint has changed.
              </span>
            </label>

            {/* ── API Key ── */}
            <label>
              API Key <span className="required">*</span>
              <input
                type="password"
                placeholder={hasNewKey ? '' : (maskedApiKey ? `Current: ${maskedApiKey}` : 'Paste new MGA API key')}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
              />
              {!hasNewKey && (
                <span className="settings-hint">
                  {maskedApiKey
                    ? `Current key: ${maskedApiKey} — leave blank to keep it, or paste a new key to update.`
                    : 'Paste your MGA API key.'}
                </span>
              )}
            </label>

            {/* ── Display preferences ── */}
            <div className="settings-preferences-section">
              <span className="settings-preferences-title">Display preferences</span>
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Theme</span>
                  <span className="settings-toggle-desc">
                    System follows your OS setting. Applies immediately and is remembered on this machine.
                  </span>
                </div>
                <div className="settings-theme-picker" role="radiogroup" aria-label="Theme">
                  {THEME_PREFS.map((pref) => (
                    <button
                      key={pref}
                      type="button"
                      role="radio"
                      aria-checked={themePref === pref}
                      className={`settings-theme-option${themePref === pref ? ' selected' : ''}`}
                      onClick={() => { setThemePref(pref); setThemePrefState(pref); }}
                    >
                      {pref.charAt(0).toUpperCase() + pref.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Token &amp; MCP savings bar</span>
                  <span className="settings-toggle-desc">
                    Show the token optimisation banner at the bottom of the chat, including cost saved via MCP on-demand tools.
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showTokenBar}
                  className={`settings-toggle-switch${showTokenBar ? ' on' : ''}`}
                  onClick={() => onToggleTokenBar?.(!showTokenBar)}
                  aria-label="Toggle token savings bar"
                >
                  <span className="settings-toggle-thumb" />
                </button>
              </div>
            </div>

            {error && <div className="error-msg" role="alert">{error}</div>}

            <button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
