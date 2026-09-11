import { useState, useEffect, useCallback } from 'react';
import { getAppSecrets, setAppSecret, syncAppSecret } from '../lib/api.js';
import { CloseIcon } from './Icon.jsx';

/**
 * App Secrets — fixed-list editor for the 10 predefined slots from
 * .github/workflows/deploy.yml. Values flow over the loopback HTTP API
 * only (never the WebSocket transcript channel) and are never returned by
 * the server, so this component never displays existing values: each row
 * shows status + a fresh password input that clears on save.
 *
 * Description handling:
 *   - Named slots (kind: 'named') display the hardcoded description as a
 *     read-only hint under the slot name.
 *   - Generic slots (kind: 'generic') get an editable description input —
 *     the user labels SECRET_1 as "Stripe API key" etc.
 */
export default function AppSecretsModal({ open, onClose }) {
  const [slots, setSlots] = useState([]);
  const [gh, setGh] = useState({ available: false });
  const [mga, setMga] = useState({ present: false });
  const [loading, setLoading] = useState(true);
  const [valueDrafts, setValueDrafts] = useState({});       // name -> typed value
  const [descDrafts, setDescDrafts] = useState({});         // name -> typed description
  const [pending, setPending] = useState({});               // name -> 'saving' | 'syncing' | 'done' | 'err:<msg>'
  const [globalError, setGlobalError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setGlobalError('');
    try {
      const data = await getAppSecrets();
      setSlots(data.slots || []);
      setGh(data.gh || { available: false });
      setMga(data.mga || { present: false });
    } catch {
      setGlobalError('Failed to load app secrets — is the chat server running?');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    setValueDrafts({});
    setDescDrafts({});
    setPending({});
  }, [open, refresh]);

  if (!open) return null;

  function clearStatusEventually(name) {
    setTimeout(() => setPending((p) => {
      const n = { ...p };
      if (n[name] === 'done') delete n[name];
      return n;
    }), 1500);
  }

  async function saveRow(slot) {
    const valueDraft = valueDrafts[slot.name];
    const descDraft = descDrafts[slot.name];
    const valueChanged = typeof valueDraft === 'string' && valueDraft.length > 0;
    // Description "changed" includes setting to empty (clear), so we send
    // it whenever the field has been touched. We track that via the draft
    // map: any string in descDrafts (even '') counts as a touch.
    const descChanged = slot.kind === 'generic' && typeof descDraft === 'string';

    if (!valueChanged && !descChanged) return;

    setPending((p) => ({ ...p, [slot.name]: 'saving' }));
    try {
      const update = {};
      if (valueChanged) update.value = valueDraft;
      if (descChanged) update.description = descDraft;
      await setAppSecret(slot.name, update);

      // Wipe drafts so a freshly-rendered row never holds the typed value.
      setValueDrafts((d) => { const n = { ...d }; delete n[slot.name]; return n; });
      setDescDrafts((d) => { const n = { ...d }; delete n[slot.name]; return n; });
      setPending((p) => ({ ...p, [slot.name]: 'done' }));
      await refresh();
      clearStatusEventually(slot.name);
    } catch (err) {
      setPending((p) => ({ ...p, [slot.name]: `err:${err.message || 'failed'}` }));
    }
  }

  async function clearRow(slot) {
    setPending((p) => ({ ...p, [slot.name]: 'saving' }));
    try {
      // Clear the value only — leave the description (the user might want
      // to keep "Stripe API key" labelled even between key rotations).
      await setAppSecret(slot.name, { value: '' });
      setValueDrafts((d) => { const n = { ...d }; delete n[slot.name]; return n; });
      await refresh();
      setPending((p) => { const n = { ...p }; delete n[slot.name]; return n; });
    } catch (err) {
      setPending((p) => ({ ...p, [slot.name]: `err:${err.message || 'failed'}` }));
    }
  }

  async function syncRow(slot) {
    setPending((p) => ({ ...p, [slot.name]: 'syncing' }));
    try {
      await syncAppSecret(slot.name);
      await refresh();
      setPending((p) => ({ ...p, [slot.name]: 'done' }));
      clearStatusEventually(slot.name);
    } catch (err) {
      setPending((p) => ({ ...p, [slot.name]: `err:${err.message || 'failed'}` }));
    }
  }

  const setCount = slots.filter((s) => s.isSet).length;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>

        <div className="settings-header">
          <h2>App secrets</h2>
          <button className="drawer-close-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <p className="settings-hint" style={{ marginTop: 0 }}>
          Save the API keys and passwords your app needs — OpenAI, databases,
          third-party services. Values stay on this machine and never show up
          in chat messages or your code.
          {' '}<strong>{setCount}</strong> of <strong>{slots.length}</strong> filled in.
        </p>

        {!gh.available && !loading && (
          <div className="settings-hint settings-hint-err" style={{ marginTop: 8 }}>
            <strong>GitHub not connected.</strong> These keys work on this machine, but
            won't reach your deployed app. To enable that, open the terminal,
            run <code>gh auth login</code>, then reopen this panel.
          </div>
        )}

        {globalError && (
          <div className="error-msg" role="alert" style={{ marginTop: 8 }}>{globalError}</div>
        )}

        {!loading && mga.present && (
          <div className="app-secrets-mga">
            <h3 className="app-secrets-mga-title">MGA (managed by platform)</h3>
            <div className="app-secret-row app-secret-row-readonly">
              <div className="app-secret-meta">
                <span className="app-secret-name"><code>MGA_BASE_URL</code></span>
                <span className="app-secret-desc">{mga.baseUrl || '(not set)'}</span>
              </div>
            </div>
            <div className="app-secret-row app-secret-row-readonly">
              <div className="app-secret-meta">
                <span className="app-secret-name"><code>MGA_API_KEY</code></span>
                <span className={`app-secret-pill ${mga.apiKeySet ? 'app-secret-pill-set' : 'app-secret-pill-unset'}`}>
                  {mga.apiKeySet ? 'Set' : 'Not set'}
                </span>
              </div>
            </div>
            {(mga.assistants || []).map((a) => (
              <div key={a.envVar} className="app-secret-row app-secret-row-readonly">
                <div className="app-secret-meta">
                  <span className="app-secret-name"><code>{a.envVar}</code></span>
                  <span className={`app-secret-pill ${a.set ? 'app-secret-pill-set' : 'app-secret-pill-unset'}`}>
                    {a.set ? 'Found' : 'Not found'}
                  </span>
                  {a.set && <span className="app-secret-desc">{a.id}</span>}
                </div>
              </div>
            ))}
            <p className="settings-hint" style={{ marginTop: 8 }}>
              Before you deploy: MGA credentials are written to the workspace
              .env file (gitignored) and are used for local runs only.
              Deployment wiring for MGA is not automated yet — these values
              will not reach a deployed app.
            </p>
          </div>
        )}

        {loading ? (
          <div className="settings-loading">Loading…</div>
        ) : (
          <div className="app-secrets-list">
            {slots.map((slot) => {
              const valueDraft = valueDrafts[slot.name];
              const descDraft = descDrafts[slot.name];
              const status = pending[slot.name];
              const isErr = typeof status === 'string' && status.startsWith('err:');
              const errMsg = isErr ? status.slice(4) : '';

              const valueDirty = typeof valueDraft === 'string' && valueDraft.length > 0;
              const descDirty = slot.kind === 'generic' && typeof descDraft === 'string';
              const dirty = valueDirty || descDirty;

              const isGeneric = slot.kind === 'generic';

              // For generic slots, prefer the draft (empty string is a
              // valid intent: "clear my label"). Otherwise show the
              // server-side description as the input's current value.
              const descShown = isGeneric
                ? (typeof descDraft === 'string' ? descDraft : (slot.description || ''))
                : '';

              return (
                <div key={slot.name} className="app-secret-row">
                  <div className="app-secret-meta">
                    <span className="app-secret-name"><code>{slot.name}</code></span>
                    <span className={`app-secret-pill ${slot.isSet ? 'app-secret-pill-set' : 'app-secret-pill-unset'}`}>
                      {slot.isSet ? 'Set' : 'Not set'}
                    </span>
                    {slot.syncedToGitHub && (
                      <span className="app-secret-pill app-secret-pill-synced">Synced</span>
                    )}
                    {isGeneric && (
                      <span className="app-secret-pill app-secret-pill-generic">Generic</span>
                    )}
                  </div>

                  {!isGeneric && slot.description && (
                    <div className="app-secret-static-desc">{slot.description}</div>
                  )}

                  {isGeneric && (
                    <input
                      type="text"
                      className="app-secret-desc-input"
                      placeholder="Description (e.g. Stripe API key) — helps you remember what's in this slot"
                      maxLength={120}
                      value={descShown}
                      onChange={(e) => setDescDrafts((d) => ({ ...d, [slot.name]: e.target.value }))}
                    />
                  )}

                  <div className="app-secret-actions">
                    <input
                      type="password"
                      placeholder={slot.isSet ? '••••••••  (paste new value to replace)' : 'paste value to set'}
                      value={valueDraft || ''}
                      onChange={(e) => setValueDrafts((d) => ({ ...d, [slot.name]: e.target.value }))}
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      className="app-secret-btn"
                      onClick={() => saveRow(slot)}
                      disabled={!dirty || status === 'saving'}
                    >
                      {status === 'saving' ? 'Saving…' : 'Save'}
                    </button>
                    {slot.isSet && (
                      <button
                        type="button"
                        className="app-secret-btn app-secret-btn-clear"
                        onClick={() => clearRow(slot)}
                        disabled={status === 'saving'}
                        title="Clear the value — re-comments the line in backend/.env. The description (if any) is kept."
                      >
                        Clear
                      </button>
                    )}
                    {slot.isSet && gh.available && (
                      <button
                        type="button"
                        className="app-secret-btn app-secret-btn-sync"
                        onClick={() => syncRow(slot)}
                        disabled={status === 'syncing'}
                        title={`Push to GitHub Actions as APP_${slot.name}`}
                      >
                        {status === 'syncing' ? 'Syncing…' : (slot.syncedToGitHub ? 'Re-sync' : 'Sync to GH')}
                      </button>
                    )}
                  </div>

                  {isErr && (
                    <div className="app-secret-error">{errMsg}</div>
                  )}
                  {status === 'done' && (
                    <div className="app-secret-ok">Saved.</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
