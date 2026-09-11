import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useToast } from '../toastContext.js';
import ConfirmModal from '../components/ConfirmModal.jsx';

const PAGE_SIZE = 50;

export default function DocumentsPage() {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [drag, setDrag] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const fileInputRef = useRef(null);
  const pollRef = useRef(null);

  const load = useCallback(async (reset = false) => {
    setLoading(true);
    const off = reset ? 0 : offset;
    try {
      const res = await fetch(`/api/documents?limit=${PAGE_SIZE}&offset=${off}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const items = data.documents || data.items || data || [];
      setDocs((prev) => reset ? items : [...prev, ...items]);
      setHasMore(items.length === PAGE_SIZE);
      setOffset(off + items.length);
    } catch (e) {
      toast('Failed to load documents', 'error');
    } finally {
      setLoading(false);
    }
  }, [offset, toast]);

  useEffect(() => { load(true); /* eslint-disable-next-line */ }, []);

  // Poll for status updates if any pending docs exist
  useEffect(() => {
    const hasPending = docs.some((d) => d.status === 'pending');
    if (!hasPending) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/documents?limit=${PAGE_SIZE}&offset=0`);
        if (!res.ok) return;
        const data = await res.json();
        const items = data.documents || data.items || data || [];
        setDocs((prev) => prev.map((d) => {
          const fresh = items.find((x) => x.id === d.id);
          return fresh ? { ...d, status: fresh.status } : d;
        }));
      } catch { /* ignore */ }
    }, 3000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [docs]);

  const upload = (file) => {
    if (!file || uploading) return;
    setUploading(true);
    setProgress(0);
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      setProgress(0);
      if (xhr.status >= 200 && xhr.status < 300) {
        toast('Upload successful');
        load(true);
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
        toast(msg, 'error');
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      setProgress(0);
      toast('Upload failed', 'error');
    };
    xhr.send(fd);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    if (uploading) return;
    const f = e.dataTransfer.files?.[0];
    if (f) upload(f);
  };

  const doDelete = async () => {
    const id = confirmDel?.id;
    setConfirmDel(null);
    if (!id) return;
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        let msg = 'Delete failed';
        try { msg = (await res.json()).message || msg; } catch {}
        toast(msg, 'error');
        return;
      }
      toast('Deleted');
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch {
      toast('Delete failed', 'error');
    }
  };

  return (
    <>
      <h1>Documents</h1>

      <div className="card">
        <div
          className={`dropzone ${drag ? 'drag' : ''} ${uploading ? 'disabled' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!uploading) setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => !uploading && fileInputRef.current?.click()}
        >
          {uploading ? (
            <>
              <div><span className="spinner dark" />Uploading… {progress}%</div>
              <div className="progress-bar"><div style={{ width: `${progress}%` }} /></div>
            </>
          ) : (
            <>
              <div><strong>Drop a file here</strong> or click to choose</div>
              <div className="doc-meta">PDF, TXT, or MD · max 20MB</div>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.md"
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files?.[0])}
            disabled={uploading}
          />
        </div>
      </div>

      <div className="card">
        {loading && docs.length === 0 ? (
          <div className="empty"><span className="spinner dark" />Loading…</div>
        ) : docs.length === 0 ? (
          <div className="empty">
            <h3>No documents yet</h3>
            <p>Upload one to get started</p>
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}>Upload a document</button>
          </div>
        ) : (
          <>
            {docs.map((d) => (
              <div className="doc-row" key={d.id}>
                <div>
                  <div><strong>{d.filename}</strong></div>
                  <div className="doc-meta">
                    by {d.uploaded_by || d.uploadedBy || 'unknown'} · {formatDate(d.uploaded_at || d.uploadedAt)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span className={`badge ${d.status || 'pending'}`}>{d.status || 'pending'}</span>
                  {(d.can_delete ?? d.canDelete ?? d.is_owner ?? true) && (
                    <button className="danger" onClick={() => setConfirmDel(d)}>Delete</button>
                  )}
                </div>
              </div>
            ))}
            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: '1rem' }}>
                <button className="ghost" onClick={() => load(false)} disabled={loading}>
                  {loading ? 'Loading…' : 'Load More'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {confirmDel && (
        <ConfirmModal
          title="Delete document?"
          message={`Are you sure you want to delete "${confirmDel.filename}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={doDelete}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </>
  );
}

function formatDate(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}