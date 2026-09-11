/**
 * TracePanel — expandable drawer showing the per-step hybrid module trace.
 *
 * Opened by a "View AI trace" button rendered in the chat thread when
 * session.hybridTrace is non-empty. Fetches trace data via hybridApi.js.
 *
 * Each step shows:
 *   - module name + status badge
 *   - input summary
 *   - output summary (truncated)
 *   - duration in ms
 *
 * Props:
 *   sessionId  — string, current session id
 *   open       — boolean, controls visibility
 *   onClose    — () => void
 */

import { useState, useEffect, useRef } from 'react';
import { fetchTrace } from '../lib/hybridApi.js';

const STATUS_COLOR = {
  completed: '#22c55e',
  failed: '#ef4444',
  skipped: '#94a3b8',
};

const MODULE_LABEL = {
  synthesis: 'Synthesis',
  retrieval: 'Retrieval',
  'policy-checker': 'Policy Check',
};

function StatusDot({ status }) {
  return (
    <span style={{
      display: 'inline-block',
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: STATUS_COLOR[status] || '#94a3b8',
      flexShrink: 0,
      marginTop: 2,
    }} />
  );
}

function DurationBadge({ ms }) {
  if (!ms) return null;
  const label = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  return (
    <span style={{
      fontSize: 10,
      color: '#64748b',
      background: 'rgba(100,116,139,0.1)',
      borderRadius: 4,
      padding: '1px 5px',
    }}>
      {label}
    </span>
  );
}

function TraceStep({ step, index }) {
  const [expanded, setExpanded] = useState(false);
  const moduleName = MODULE_LABEL[step.module] || step.module;

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(255,255,255,0.03)',
      marginBottom: 8,
      overflow: 'hidden',
    }}>
      {/* Header row */}
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
        <span style={{ color: '#64748b', fontSize: 11, minWidth: 16 }}>{index + 1}</span>
        <StatusDot status={step.status} />
        <span style={{ fontWeight: 500, fontSize: 13, flex: 1, color: '#e2e8f0' }}>
          {moduleName}
        </span>
        <DurationBadge ms={step.durationMs} />
        <span style={{ color: '#64748b', fontSize: 11, marginLeft: 4 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          {step.input && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                Input
              </div>
              <pre style={{
                fontSize: 11, color: '#94a3b8', background: 'rgba(0,0,0,0.2)',
                borderRadius: 4, padding: '6px 8px', margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto',
              }}>
                {step.input}
              </pre>
            </div>
          )}
          {step.output && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                Output
              </div>
              <pre style={{
                fontSize: 11, color: '#94a3b8', background: 'rgba(0,0,0,0.2)',
                borderRadius: 4, padding: '6px 8px', margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto',
              }}>
                {step.output}
              </pre>
            </div>
          )}
          {!step.input && !step.output && (
            <p style={{ fontSize: 12, color: '#64748b', margin: '10px 0 0' }}>No detail recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function TracePanel({ sessionId, open, onClose }) {
  const [trace, setTrace] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const panelRef = useRef(null);

  // Fetch trace when opened
  useEffect(() => {
    if (!open || !sessionId) return;
    setLoading(true);
    setError(null);
    fetchTrace(sessionId)
      .then(data => setTrace(data.trace || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, sessionId]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Focus panel when opened
  useEffect(() => {
    if (open && panelRef.current) panelRef.current.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="drawer-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="AI module trace"
    >
      <div
        ref={panelRef}
        className="drawer-panel"
        tabIndex={-1}
        style={{ width: 420, maxWidth: '92vw' }}
      >
        {/* Header */}
        <div className="drawer-header" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Sparkle icon */}
            <svg width={14} height={14} viewBox="0 0 12 12" fill="#a78bfa" aria-hidden="true">
              <path d="M6 0 L6.75 4.5 L11 6 L6.75 7.5 L6 12 L5.25 7.5 L1 6 L5.25 4.5 Z" />
            </svg>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
              AI Module Trace
            </h3>
          </div>
          <button
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="Close trace panel"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, paddingRight: 2 }}>
          {loading && (
            <p style={{ color: '#64748b', fontSize: 13, textAlign: 'center', marginTop: 32 }}>
              Loading trace…
            </p>
          )}

          {error && (
            <p style={{ color: '#ef4444', fontSize: 13, textAlign: 'center', marginTop: 32 }}>
              {error}
            </p>
          )}

          {!loading && !error && trace.length === 0 && (
            <div style={{ textAlign: 'center', marginTop: 40, color: '#64748b' }}>
              <svg width={32} height={32} viewBox="0 0 12 12" fill="currentColor" style={{ opacity: 0.3, marginBottom: 8 }} aria-hidden="true">
                <path d="M6 0 L6.75 4.5 L11 6 L6.75 7.5 L6 12 L5.25 7.5 L1 6 L5.25 4.5 Z" />
              </svg>
              <p style={{ fontSize: 13, margin: 0 }}>No AI modules ran for this build.</p>
              <p style={{ fontSize: 11, marginTop: 4 }}>This was a fully deterministic build.</p>
            </div>
          )}

          {!loading && !error && trace.length > 0 && (
            <>
              <p style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
                {trace.length} module{trace.length !== 1 ? 's' : ''} ran for this build.
              </p>
              {trace.map((step, i) => (
                <TraceStep key={`${step.module}-${i}`} step={step} index={i} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
