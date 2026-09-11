import { useState, useEffect } from 'react';

export default function WelcomeModal({ open, onDismiss }) {
  const [mode, setMode] = useState('beginner');

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') onDismiss({ mode });
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onDismiss, mode]);

  if (!open) return null;

  return (
    <div className="welcome-overlay" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="welcome-card">
        <span className="welcome-emoji" role="img" aria-label="sparkles">✨</span>
        <h2>Welcome to your AI coding assistant</h2>
        <p className="welcome-subtitle">
          Describe what you want to build and your assistant will create it for you — no coding required.
        </p>

        <div className="welcome-tips">
          <div className="tip">
            <span className="tip-num">1</span>
            <span>Describe your app idea in plain language</span>
          </div>
          <div className="tip">
            <span className="tip-num">2</span>
            <span>The AI writes all the code and sets everything up</span>
          </div>
          <div className="tip">
            <span className="tip-num">3</span>
            <span>When you're happy, it deploys your app live</span>
          </div>
        </div>

        <div className="welcome-section">
          <span className="welcome-label">How should the AI talk to you?</span>
          <div className="mode-buttons">
            <button
              className={mode === 'beginner' ? 'active' : ''}
              onClick={() => setMode('beginner')}
              aria-pressed={mode === 'beginner'}
            >
              <span className="mode-emoji">🎓</span>
              <strong>Beginner</strong>
              <small>Simple language, does everything for you</small>
            </button>
            <button
              className={mode === 'developer' ? 'active' : ''}
              onClick={() => setMode('developer')}
              aria-pressed={mode === 'developer'}
            >
              <span className="mode-emoji">💻</span>
              <strong>Developer</strong>
              <small>Technical, concise, shows details</small>
            </button>
          </div>
        </div>

        <button className="welcome-btn" onClick={() => onDismiss({ mode })}>
          Get Started →
        </button>
      </div>
    </div>
  );
}
