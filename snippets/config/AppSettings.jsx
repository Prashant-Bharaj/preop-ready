/**
 * SNIPPET: App Settings Admin Page
 * CATEGORY: Configuration
 * LANGUAGE: React (JSX)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Admin page for managing runtime application settings stored in the database.
 *   Settings can be changed without redeployment. Backend reads DB first,
 *   falls back to environment variables.
 *
 * DEPENDENCIES:
 *   None (uses fetch API). Requires app-settings.js backend snippet.
 *
 * USAGE:
 *   import AppSettings from './AppSettings';
 *   // Add to router: <Route path="/settings" element={<AppSettings />} />
 *   // Add to sidebar nav: { path: '/settings', label: 'Settings', roles: ['admin'] }
 *
 * RELATED:
 *   - config/app-settings.js (backend routes)
 *   - config/app-settings-schema.sql (database table)
 *   - auth/user-roles.js (admin role check)
 */

import { useState, useEffect } from 'react';

export default function AppSettings() {
  const [settings, setSettings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to load settings');
      const data = await res.json();
      setSettings(data.settings || []);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSettings(); }, []);

  const startEdit = (setting) => {
    setEditingKey(setting.key);
    setEditValue(setting.value || '');
    setMessage(null);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue('');
  };

  const saveEdit = async (key) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      setEditingKey(null);
      setEditValue('');
      setMessage({ type: 'success', text: `Setting "${key}" updated successfully` });
      fetchSettings();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e, key) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit(key);
    }
    if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>App Settings</h2>
          <p style={styles.subtitle}>
            Runtime configuration. Changes take effect immediately without redeployment.
          </p>
        </div>
      </div>

      {message && (
        <div style={{
          ...styles.message,
          ...(message.type === 'error' ? styles.messageError : styles.messageSuccess),
        }}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div style={styles.loading}>Loading settings...</div>
      ) : settings.length === 0 ? (
        <div style={styles.empty}>
          <p>No settings configured yet.</p>
          <p style={styles.emptyHint}>
            Add settings to the <code>app_settings</code> table in your database,
            or use the backend <code>setConfig()</code> function.
          </p>
        </div>
      ) : (
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Key</th>
                <th style={styles.th}>Value</th>
                <th style={styles.th}>Description</th>
                <th style={styles.th}>Last Updated</th>
                <th style={{ ...styles.th, width: '120px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {settings.map((s) => (
                <tr key={s.key} style={styles.tr}>
                  <td style={styles.td}>
                    <code style={styles.keyCode}>{s.key}</code>
                  </td>
                  <td style={styles.td}>
                    {editingKey === s.key ? (
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, s.key)}
                        style={styles.input}
                        autoFocus
                        disabled={saving}
                      />
                    ) : (
                      <span style={styles.value}>{s.value || '—'}</span>
                    )}
                  </td>
                  <td style={{ ...styles.td, color: '#666' }}>
                    {s.description || '—'}
                  </td>
                  <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                    {s.updated_at
                      ? new Date(s.updated_at).toLocaleString()
                      : '—'}
                  </td>
                  <td style={styles.td}>
                    {editingKey === s.key ? (
                      <div style={styles.actions}>
                        <button
                          onClick={() => saveEdit(s.key)}
                          disabled={saving}
                          style={{ ...styles.btn, ...styles.btnSave }}
                        >
                          {saving ? '...' : 'Save'}
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={saving}
                          style={{ ...styles.btn, ...styles.btnCancel }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(s)}
                        style={{ ...styles.btn, ...styles.btnEdit }}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Inline styles (no CSS dependency) ---
const styles = {
  page: { padding: '24px', maxWidth: '1000px', margin: '0 auto' },
  header: { marginBottom: '24px' },
  title: { margin: '0 0 4px 0', fontSize: '24px', fontWeight: 600 },
  subtitle: { margin: 0, color: '#666', fontSize: '14px' },
  loading: { textAlign: 'center', padding: '40px', color: '#666' },
  empty: { textAlign: 'center', padding: '40px', color: '#666' },
  emptyHint: { fontSize: '13px', marginTop: '8px' },
  message: { padding: '12px 16px', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' },
  messageError: { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' },
  messageSuccess: { background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' },
  tableWrapper: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '14px' },
  th: { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151' },
  tr: { borderBottom: '1px solid #f3f4f6' },
  td: { padding: '10px 12px', verticalAlign: 'middle' },
  keyCode: { background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '13px', fontFamily: 'monospace' },
  value: { fontFamily: 'monospace', fontSize: '13px' },
  input: { width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '13px', fontFamily: 'monospace' },
  actions: { display: 'flex', gap: '6px' },
  btn: { padding: '4px 12px', borderRadius: '4px', border: '1px solid #d1d5db', cursor: 'pointer', fontSize: '13px', background: '#fff' },
  btnEdit: { color: '#2563eb', borderColor: '#93c5fd' },
  btnSave: { color: '#fff', background: '#16a34a', borderColor: '#16a34a' },
  btnCancel: { color: '#6b7280' },
};
