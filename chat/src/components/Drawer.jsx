import { useEffect, useRef, useState } from 'react';
import { CloseIcon, SettingsIcon, KeyIcon } from './Icon.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import { timeAgo } from '../lib/time.js';

export default function Drawer({
  open, onClose, sessions, onResume, onNewSession, onOpenSettings, onOpenAppSecrets,
  currentSessionId, onRename, onDelete,
}) {
  const panelRef = useRef(null);
  const [resuming, setResuming] = useState(null);

  // per-session UI state
  const [menuOpenId, setMenuOpenId] = useState(null);   // which session has the ⋯ menu open
  const [renamingId, setRenamingId] = useState(null);   // which session is in rename-edit mode
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null); // which session shows delete confirm
  const renameInputRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') {
        if (renamingId) { setRenamingId(null); return; }
        if (menuOpenId) { setMenuOpenId(null); return; }
        if (confirmDeleteId) { setConfirmDeleteId(null); return; }
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, renamingId, menuOpenId, confirmDeleteId]);

  // Focus trap: focus panel when opened
  useEffect(() => {
    if (open && panelRef.current) panelRef.current.focus();
  }, [open]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId && renameInputRef.current) renameInputRef.current.focus();
  }, [renamingId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    function handleClick() { setMenuOpenId(null); }
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [menuOpenId]);

  async function handleResume(sessionId) {
    if (sessionId === currentSessionId) { onClose(); return; }
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

  function openMenu(e, sessionId) {
    e.stopPropagation();
    setMenuOpenId(prev => (prev === sessionId ? null : sessionId));
    setConfirmDeleteId(null);
  }

  function startRename(e, session) {
    e.stopPropagation();
    setMenuOpenId(null);
    setRenamingId(session.sessionId);
    setRenameValue(session.title || 'Untitled session');
  }

  async function commitRename(sessionId) {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    try {
      await onRename(sessionId, trimmed);
    } catch { /* parent shows toast */ }
  }

  function handleRenameKey(e, sessionId) {
    if (e.key === 'Enter') commitRename(sessionId);
    if (e.key === 'Escape') setRenamingId(null);
  }

  function askDeleteConfirm(e, sessionId) {
    e.stopPropagation();
    setMenuOpenId(null);
    setConfirmDeleteId(sessionId);
  }

  async function confirmDelete(sessionId) {
    setConfirmDeleteId(null);
    try {
      await onDelete(sessionId);
    } catch { /* parent shows toast */ }
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
            sessions.map((s) => {
              const isActive   = s.sessionId === currentSessionId;
              const isRenaming = renamingId === s.sessionId;
              const isMenuOpen = menuOpenId === s.sessionId;
              const isDeleting = confirmDeleteId === s.sessionId;
              const isResuming = resuming === s.sessionId;

              return (
                <div
                  key={s.sessionId}
                  className={`drawer-session-row${isActive ? ' active' : ''}`}
                >
                  {/* ── Main session button ── */}
                  {isRenaming ? (
                    <div className="drawer-session-rename-row">
                      <input
                        ref={renameInputRef}
                        className="drawer-rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => handleRenameKey(e, s.sessionId)}
                        onBlur={() => commitRename(s.sessionId)}
                        maxLength={120}
                        aria-label="Rename conversation"
                      />
                      <button
                        className="drawer-rename-confirm-btn"
                        onMouseDown={e => { e.preventDefault(); commitRename(s.sessionId); }}
                        aria-label="Confirm rename"
                      >✓</button>
                    </div>
                  ) : (
                    <button
                      className={`drawer-session-item${isActive ? ' active' : ''}${isResuming ? ' resuming' : ''}`}
                      onClick={() => handleResume(s.sessionId)}
                      disabled={resuming !== null}
                      aria-label={`Resume: ${s.title || 'Untitled session'}`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                        {isResuming && <span className="session-spinner" aria-hidden="true" />}
                        <span className="drawer-session-title">
                          {isResuming ? 'Loading...' : (s.title || 'Untitled session')}
                        </span>
                      </div>
                      <span className="drawer-session-time">{timeAgo(s.lastMessageAt || s.createdAt)}</span>
                    </button>
                  )}

                  {/* ── ⋯ menu trigger (hidden while renaming or confirming delete) ── */}
                  {!isRenaming && !isDeleting && (
                    <button
                      className={`drawer-session-menu-btn${isMenuOpen ? ' open' : ''}`}
                      onClick={e => openMenu(e, s.sessionId)}
                      aria-label="More options"
                      aria-expanded={isMenuOpen}
                      tabIndex={0}
                    >
                      ⋯
                    </button>
                  )}

                  {/* ── Context menu ── */}
                  {isMenuOpen && (
                    <div
                      className="drawer-session-context-menu"
                      onClick={e => e.stopPropagation()}
                    >
                      <button onClick={e => startRename(e, s)}>
                        ✏️ Rename
                      </button>
                      <button
                        className="danger"
                        onClick={e => askDeleteConfirm(e, s.sessionId)}
                      >
                        🗑 Delete
                      </button>
                    </div>
                  )}

                  {/* ── Inline delete confirmation ── */}
                  {isDeleting && (
                    <div className="drawer-session-delete-confirm" onClick={e => e.stopPropagation()}>
                      <span>Delete this conversation?</span>
                      <div className="drawer-delete-actions">
                        <button
                          className="drawer-delete-confirm-btn"
                          onClick={() => confirmDelete(s.sessionId)}
                        >Delete</button>
                        <button
                          className="drawer-delete-cancel-btn"
                          onClick={() => setConfirmDeleteId(null)}
                        >Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="drawer-divider" />

        <div className="drawer-env">
          <EnvironmentPanel />
        </div>

        <div className="drawer-divider" />

        {onOpenAppSecrets && (
          <button className="drawer-settings-btn" onClick={onOpenAppSecrets}>
            <KeyIcon size={16} />
            App secrets
          </button>
        )}

        <button className="drawer-settings-btn" onClick={onOpenSettings}>
          <SettingsIcon size={16} />
          Settings
        </button>
      </div>
    </div>
  );
}
