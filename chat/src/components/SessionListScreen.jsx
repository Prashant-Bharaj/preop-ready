import { useState } from 'react';
import { timeAgo } from '../lib/time.js';

export default function SessionListScreen({ sessions, onResume, onNewSession }) {
  const [resuming, setResuming] = useState(null);

  async function handleResume(sessionId) {
    setResuming(sessionId);
    try {
      await onResume(sessionId);
    } finally {
      setResuming(null);
    }
  }

  return (
    <div className="session-list-screen">
      <div className="session-list-card">
        <div className="session-list-header">
          <span className="session-list-emoji" role="img" aria-label="chat">💬</span>
          <h2>Your conversations</h2>
          <p className="session-list-subtitle">Continue where you left off, or start something new.</p>
        </div>

        {sessions.length === 0 ? (
          <div className="session-empty">
            <span className="session-empty-emoji" role="img" aria-label="seedling">🌱</span>
            <p>No conversations yet. Start your first one!</p>
          </div>
        ) : (
          <div className="session-list">
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                className="session-item"
                onClick={() => handleResume(s.sessionId)}
                disabled={resuming !== null}
                aria-label={`Resume session: ${s.title || 'Untitled session'}`}
              >
                <div className="session-item-left">
                  <span className="session-title">{s.title || 'Untitled session'}</span>
                  <span className="session-time">{timeAgo(s.lastMessageAt || s.createdAt)}</span>
                </div>
                <span className="session-arrow">
                  {resuming === s.sessionId ? '...' : '\u203A'}
                </span>
              </button>
            ))}
          </div>
        )}

        <button className="session-new-btn" onClick={onNewSession} disabled={resuming !== null}>
          + New conversation
        </button>
      </div>
    </div>
  );
}
