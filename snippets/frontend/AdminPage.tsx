/**
 * scopes: [frontend]
 * flags: [has-admin]
 * description: Admin page (TypeScript + Tailwind + shadcn) with tabs, upload form, CRUD item list.
 */

/**
 * React Admin Page Template (TypeScript + Tailwind)
 *
 * Generic admin page with tab navigation, file upload form, and item list.
 * Adapt tabs, API endpoints, and form fields to your project.
 *
 * Place at frontend/src/pages/AdminPage.tsx.
 */

import * as React from 'react';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { Label } from '../components/Label.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/Tabs.js';
import { Alert, AlertDescription } from '../components/Alert.js';

interface CurrentUser {
  name?: string;
  email?: string;
}

export function AdminPage(): React.JSX.Element {
  const [user, setUser] = React.useState<CurrentUser | null>(null);

  React.useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json() as Promise<CurrentUser>)
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        {user && (
          <p className="text-sm text-slate-500">
            Logged in as {user.name || user.email}
          </p>
        )}
      </div>

      <Tabs defaultValue="upload">
        <TabsList>
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="manage">Manage</TabsTrigger>
        </TabsList>
        <TabsContent value="upload">
          <UploadForm />
        </TabsContent>
        <TabsContent value="manage">
          <ItemList />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default AdminPage;

// ── Upload Form ─────────────────────────────────────────────

type StatusType = 'success' | 'error' | null;

interface StatusState {
  type: StatusType;
  msg: string;
}

function UploadForm(): React.JSX.Element {
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState('');
  const [status, setStatus] = React.useState<StatusState>({
    type: null,
    msg: '',
  });
  const [uploading, setUploading] = React.useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!file) {
      setStatus({ type: 'error', msg: 'Please select a file.' });
      return;
    }

    setUploading(true);
    setStatus({ type: null, msg: '' });

    try {
      const form = new FormData();
      form.append('file', file);
      if (title) form.append('title', title);

      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);

      setStatus({ type: 'success', msg: 'Uploaded successfully.' });
      setFile(null);
      setTitle('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ type: 'error', msg: message });
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="space-y-2">
        <Label htmlFor="upload-title">Title (optional)</Label>
        <Input
          id="upload-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="upload-file">File</Label>
        <Input
          id="upload-file"
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          accept=".pdf,.txt,.csv,.doc,.docx"
        />
      </div>
      <Button type="submit" disabled={uploading}>
        {uploading ? 'Uploading...' : 'Upload'}
      </Button>
      {status.msg && (
        <Alert variant={status.type === 'error' ? 'destructive' : 'default'}>
          <AlertDescription>{status.msg}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

// ── Item List ───────────────────────────────────────────────

interface AdminItem {
  id: string | number;
  title?: string;
  name?: string;
  created_at?: string;
}

function ItemList(): React.JSX.Element {
  const [items, setItems] = React.useState<AdminItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const fetchItems = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/items');
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = (await res.json()) as { items?: AdminItem[] };
      setItems(data.items || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  async function handleDelete(id: AdminItem['id']): Promise<void> {
    if (!confirm('Delete this item?')) return;
    try {
      const res = await fetch(`/api/admin/items/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }

  if (loading) return <p className="text-sm text-slate-500">Loading...</p>;
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );

  return (
    <div className="divide-y divide-slate-200 rounded-md border border-slate-200">
      {items.length === 0 && (
        <p className="px-4 py-3 text-sm text-slate-500">No items yet.</p>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between gap-3 px-4 py-3"
        >
          <span className="font-medium">{item.title || item.name}</span>
          <span className="text-sm text-slate-500">
            {item.created_at
              ? new Date(item.created_at).toLocaleDateString()
              : ''}
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handleDelete(item.id)}
          >
            Delete
          </Button>
        </div>
      ))}
    </div>
  );
}
