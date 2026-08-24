import { useState, useEffect } from 'react';
import { getEnvironment, refreshEnvironment } from '../lib/api.js';

const PHASE_LABELS = {
  empty: { emoji: '🌱', label: 'Getting started', description: 'Describe your idea to begin' },
  building: { emoji: '🔨', label: 'Building', description: 'Your app is being created' },
  testing: { emoji: '🧪', label: 'Ready to test', description: 'You can test your app locally' },
  deployed: { emoji: '🚀', label: 'Deployed', description: 'Your app is live' },
};

const STATUS_ICONS = { pass: '✅', warn: '⚠️', fail: '❌', pending: '⏳' };

export default function EnvironmentPanel() {
  const [env, setEnv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    loadEnvironment();
  }, []);

  async function loadEnvironment() {
    try {
      const data = await getEnvironment();
      setEnv(data);
    } catch {
      // Silently fail — panel just won't show
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    try {
      const data = await refreshEnvironment();
      setEnv(data);
    } catch { /* ignore */ }
  }

  if (loading || !env) return null;

  const phase = PHASE_LABELS[env.projectPhase] || PHASE_LABELS.empty;
  const { preflight, projectStatus, templateVersion, codespaceUrl, environment } = env;

  // When no app code exists yet, reframe the checklist as "Platform ready" and
  // exclude the pending app-code check from the count — it isn't a failing item,
  // it's the next step for the user. Counting it as 3/4 made the panel look
  // like 75%-done progress toward a project that hasn't been started.
  const appCodeCheck = preflight?.checks?.find(c => c.id === 'project-folders');
  const noAppCodeYet = appCodeCheck?.status === 'pending';

  const displayChecks = noAppCodeYet
    ? preflight.checks.filter(c => c.id !== 'project-folders')
    : preflight?.checks || [];
  const displayPassed = displayChecks.filter(c => c.status === 'pass').length;
  const displayTotal = displayChecks.length;
  const displayFailedOrWarn = displayChecks.some(c => c.status === 'fail' || c.status === 'warn' || c.status === 'pending');
  const passedAll = !displayFailedOrWarn;
  const panelLabel = noAppCodeYet ? 'Platform ready' : 'Project readiness';

  return (
    <div className="env-panel">
      {/* Update banner */}
      {templateVersion?.needsUpdate && (
        <div className="env-update-banner">
          🔄 A template update is available ({templateVersion.current} → {templateVersion.latest})
        </div>
      )}

      {/* Phase + environment row */}
      <div className="env-info-row">
        <span className="env-phase-badge">
          <span>{phase.emoji}</span>
          <span>{phase.label}</span>
        </span>

        <span className="env-environment">
          {environment === 'codespaces' ? '☁️ Codespaces' : '💻 Local'}
        </span>

        {codespaceUrl && (
          <a className="env-url" href={codespaceUrl} target="_blank" rel="noopener noreferrer">
            🔗 Preview URL
          </a>
        )}
      </div>

      {/* Project idea if set */}
      {projectStatus?.idea && (
        <div className="env-project-idea">
          <strong>Project:</strong> {projectStatus.idea}
        </div>
      )}

      {/* Readiness checklist */}
      {preflight && (
        <div className="env-checklist">
          <button
            className="env-checklist-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            <span>
              {passedAll ? '✅' : '📋'} {panelLabel}
              <span className="env-checklist-summary">
                {displayPassed}/{displayTotal} checks passed
              </span>
            </span>
            <span className="env-chevron">{expanded ? '▲' : '▼'}</span>
          </button>

          {expanded && (
            <div className="env-checklist-items">
              {displayChecks.map((check) => (
                <div key={check.id} className={`env-check env-check-${check.status}`}>
                  <span className="env-check-icon">{STATUS_ICONS[check.status]}</span>
                  <div className="env-check-content">
                    <span className="env-check-label">{check.label}</span>
                    <span className="env-check-desc">{check.description}</span>
                  </div>
                </div>
              ))}
              {noAppCodeYet && (
                <div className="env-check env-check-hint">
                  <span className="env-check-icon">→</span>
                  <div className="env-check-content">
                    <span className="env-check-label">Next: describe your idea</span>
                    <span className="env-check-desc">The chat will create app code once you say what to build</span>
                  </div>
                </div>
              )}
              <button className="env-refresh-btn" onClick={handleRefresh}>
                🔄 Refresh checks
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
