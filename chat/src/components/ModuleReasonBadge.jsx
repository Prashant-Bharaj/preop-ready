/**
 * ModuleReasonBadge — displayed in the chat thread after a plan_preview event
 * when hybrid modules are scheduled to run.
 *
 * Shows:
 *   - reason_codes as human-readable tags ("Adaptive content", "Research needed", etc.)
 *   - which modules will run (synthesis, retrieval, policy-checker)
 *   - confidence percentage
 *
 * Example: "AI assist: synthesis + policy-check (confidence 82%)"
 *
 * Props:
 *   modulePlan   — Array of { module, trigger, ... } | null
 *   reasonCodes  — Array of strings | []
 *   confidence   — number 0.0–1.0 | null
 */

const REASON_LABELS = {
  'adaptive-need': 'Adaptive content',
  'research-need': 'Research needed',
  'policy-check': 'Compliance check',
  'ambiguity': 'Clarified intent',
};

const MODULE_LABELS = {
  synthesis: 'synthesis',
  retrieval: 'retrieval',
  'policy-checker': 'policy-check',
};

const BADGE_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '3px 10px',
  borderRadius: '12px',
  fontSize: '11px',
  fontWeight: 500,
  background: 'rgba(139, 92, 246, 0.12)',
  border: '1px solid rgba(139, 92, 246, 0.25)',
  color: '#a78bfa',
  lineHeight: '1.4',
};

const ICON_STYLE = {
  width: 12,
  height: 12,
  opacity: 0.8,
};

export default function ModuleReasonBadge({ modulePlan, reasonCodes = [], confidence = null }) {
  if (!Array.isArray(modulePlan) || modulePlan.length === 0) return null;

  const moduleNames = modulePlan
    .map(e => MODULE_LABELS[e.module] || e.module)
    .filter(Boolean)
    .join(' + ');

  const confidencePct = typeof confidence === 'number'
    ? `${Math.round(confidence * 100)}%`
    : null;

  const reasonLabels = reasonCodes
    .map(code => REASON_LABELS[code] || code)
    .filter(Boolean);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
      <span style={BADGE_STYLE} title={reasonLabels.join(', ')}>
        {/* Sparkle icon */}
        <svg style={ICON_STYLE} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M6 0 L6.75 4.5 L11 6 L6.75 7.5 L6 12 L5.25 7.5 L1 6 L5.25 4.5 Z" />
        </svg>
        AI assist: {moduleNames}
        {confidencePct && ` (confidence ${confidencePct})`}
      </span>

      {reasonLabels.map(label => (
        <span
          key={label}
          style={{
            ...BADGE_STYLE,
            background: 'rgba(100, 116, 139, 0.10)',
            border: '1px solid rgba(100, 116, 139, 0.20)',
            color: '#94a3b8',
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
