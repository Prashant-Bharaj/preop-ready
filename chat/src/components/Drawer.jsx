import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from './Icon.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import { timeAgo } from '../lib/time.js';

export default function Drawer({ open, onClose, sessions, onResume, onNewSession, currentSessionId }) {
  const panelRef = useRef(null);
  const [resuming, setResuming] = useState(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Focus trap: focus panel when opened
  useEffect(() => {
    if (open && panelRef.current) {
      panelRef.current.focus();
    }
  }, [open]);

  async function handleResume(sessionId) {
    if (sessionId === currentSessionId) {
      onClose();
      return;
    }
    setResuming(sessionId);
    try {
      await onResume(sessionId);
      onClose();
    } finally {
      setResuming(null);
    }
  }

  async function handleNewSession() {
    await onNewSession();
    onClose();
  }

  if (!open) return null;

  return (
    <div className="drawer-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Navigation drawer">
      <div
        className="drawer-panel"
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-header">
          <h3>Conversations</h3>
          <button className="drawer-close-btn" onClick={onClose} aria-label="Close drawer">
            <CloseIcon />
          </button>
        </div>

        <button
          className="drawer-new-btn"
          onClick={handleNewSession}
          disabled={resuming !== null}
        >
          + New conversation
        </button>

        <div className="drawer-sessions">
          {sessions.length === 0 ? (
            <div className="drawer-empty">
              <p>No conversations yet</p>
            </div>
          ) : (
            sessions.map((s) => (
              <button
                key={s.sessionId}
                className={`drawer-session-item${s.sessionId === currentSessionId ? ' active' : ''}`}
                onClick={() => handleResume(s.sessionId)}
                disabled={resuming !== null}
                aria-label={`Resume: ${s.title || 'Untitled session'}`}
              >
                <span className="drawer-session-title">{s.title || 'Untitled session'}</span>
                <span className="drawer-session-time">{timeAgo(s.lastMessageAt || s.createdAt)}</span>
              </button>
            ))
          )}
        </div>

        <div className="drawer-divider" />

        <div className="drawer-env">
          <EnvironmentPanel />
        </div>
      </div>
    </div>
  );
}
