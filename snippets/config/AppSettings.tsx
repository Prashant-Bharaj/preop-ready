/**
 * scopes: [frontend]
 * flags: [app-settings]
 * description: React settings page (TypeScript + Tailwind + shadcn) for editing runtime app_settings.
 */

/**
 * App Settings Admin Page (TypeScript + Tailwind)
 *
 * Admin page for managing runtime application settings stored in the database.
 * Settings can be changed without redeployment. Backend reads DB first,
 * falls back to environment variables.
 *
 * Dependencies: React 18+, shadcn Button / Input / Alert / Table.
 *
 * Usage:
 *   import AppSettings from './AppSettings.js';
 *   <Route path="/settings" element={<AppSettings />} />
 *
 * Related:
 *   - config/app-settings.ts (backend routes)
 *   - config/app-settings-schema.sql (database table)
 *   - auth/user-roles.ts (admin role check)
 */

import * as React from 'react';
import { Button } from '../frontend/components/Button.js';
import { Input } from '../frontend/components/Input.js';
import { Alert, AlertDescription } from '../frontend/components/Alert.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../frontend/components/Table.js';

interface AppSetting {
  key: string;
  value: string | null;
  description?: string | null;
  updated_by?: string | null;
  updated_at?: string | null;
}

interface SettingsResponse {
  success?: boolean;
  settings?: AppSetting[];
}

type MessageType = 'error' | 'success';

interface MessageState {
  type: MessageType;
  text: string;
}

export default function AppSettings(): React.JSX.Element {
  const [settings, setSettings] = React.useState<AppSetting[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<MessageState | null>(null);

  const fetchSettings = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to load settings');
      const data = (await res.json()) as SettingsResponse;
      setSettings(data.settings || []);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
      setMessage({ type: 'error', text: 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  function startEdit(setting: AppSetting): void {
    setEditingKey(setting.key);
    setEditValue(setting.value || '');
    setMessage(null);
  }

  function cancelEdit(): void {
    setEditingKey(null);
    setEditValue('');
  }

  async function saveEdit(key: string): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: editValue }),
      });
      if (!res.ok) {
        const errPayload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errPayload.error || 'Failed to save');
      }
      setEditingKey(null);
      setEditValue('');
      setMessage({
        type: 'success',
        text: `Setting "${key}" updated successfully`,
      });
      void fetchSettings();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMessage({ type: 'error', text });
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    key: string
  ): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void saveEdit(key);
    }
    if (e.key === 'Escape') cancelEdit();
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold">App Settings</h2>
        <p className="text-sm text-slate-500">
          Runtime configuration. Changes take effect immediately without
          redeployment.
        </p>
      </div>

      {message && (
        <Alert
          className="mb-4"
          variant={message.type === 'error' ? 'destructive' : 'default'}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="py-10 text-center text-slate-500">Loading settings...</div>
      ) : settings.length === 0 ? (
        <div className="py-10 text-center text-slate-500">
          <p>No settings configured yet.</p>
          <p className="mt-2 text-xs">
            Add settings to the <code>app_settings</code> table in your database,
            or use the backend <code>setConfig()</code> function.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead className="w-32">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.map((s) => (
                <TableRow key={s.key}>
                  <TableCell>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
                      {s.key}
                    </code>
                  </TableCell>
                  <TableCell>
                    {editingKey === s.key ? (
                      <Input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, s.key)}
                        autoFocus
                        disabled={saving}
                        className="font-mono text-xs"
                      />
                    ) : (
                      <span className="font-mono text-xs">{s.value || '—'}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {s.description || '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {s.updated_at
                      ? new Date(s.updated_at).toLocaleString()
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {editingKey === s.key ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => saveEdit(s.key)}
                          disabled={saving}
                        >
                          {saving ? '...' : 'Save'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={cancelEdit}
                          disabled={saving}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => startEdit(s)}
                      >
                        Edit
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
