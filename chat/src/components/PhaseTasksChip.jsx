import { useState, useMemo } from 'react';

/**
 * PhaseTasksChip — Part B Phase 2 affordance.
 *
 * Shows a compact pill summarizing in-flight phase agents dispatched by the
 * Orchestrator (USE_LLM_ORCHESTRATOR=true path). Click to expand a drawer
 * listing every task with scope, description, elapsed time, and final state.
 *
 * Source of truth: `phaseTasks` Map maintained in ChatScreen, populated from
 * cline events whose `say === 'phase_status'`. Each event payload's `text`
 * field is JSON of shape:
 *   { taskId, scope, description?, state, mode?, startedAt, error?,
 *     writtenPaths?, tokens? }
 *
 * The chip hides itself when there are no tasks at all (running OR completed
 * within the current run). When tasks exist, it always shows so the user can
 * inspect what just ran.
 */

const SCOPE_LABEL = {
  database: 'Database',
  backend: 'Backend',
  frontend: 'Frontend',
  vectordb: 'VectorDB',
  integration: 'Integration',
  verifier: 'Verifier',
};

function formatElapsed(startedAt) {
  if (!startedAt) return '';
  const ms = Date.now() - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function StateDot({ state }) {
  const color = {
    running:   '#facc15', // amber
    completed: '#22c55e', // green
    failed:    '#ef4444', // red
    cancelled: '#94a3b8', // slate
  }[state] || '#94a3b8';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginRight: 8,
      }}
      aria-label={state}
    />
  );
}

export default function PhaseTasksChip({ phaseTasks }) {
  const [expanded, setExpanded] = useState(false);

  const tasks = useMemo(() => Array.from(phaseTasks.values()), [phaseTasks]);
  const runningCount = tasks.filter((t) => t.state === 'running').length;

  if (tasks.length === 0) return null;

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        title={runningCount > 0 ? `${runningCount} phase agents running` : `${tasks.length} phase agents (all done)`}
        style={{
          background: runningCount > 0 ? 'rgba(250, 204, 21, 0.15)' : 'rgba(34, 197, 94, 0.15)',
          color: runningCount > 0 ? '#facc15' : '#22c55e',
          border: '1px solid currentColor',
          borderRadius: 999,
          padding: '4px 10px',
          fontSize: 12,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
        {runningCount > 0
          ? `${runningCount} running · ${tasks.length} total`
          : `${tasks.length} phase agents`}
      </button>

      {expanded && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 320,
            maxWidth: 480,
            maxHeight: 360,
            overflowY: 'auto',
            background: '#0f172a',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            zIndex: 50,
            fontSize: 12,
          }}
          role="dialog"
          aria-label="Phase agents"
        >
          <div style={{ fontWeight: 600, marginBottom: 8, color: '#cbd5e1' }}>
            Phase agents ({runningCount} running, {tasks.length} total)
          </div>
          {tasks.map((t) => (
            <div
              key={t.taskId}
              style={{
                padding: '6px 0',
                borderTop: '1px solid #1e293b',
                color: '#e2e8f0',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
              }}
            >
              <StateDot state={t.state} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>
                  {SCOPE_LABEL[t.scope] || t.scope}
                  <span style={{ color: '#64748b', marginLeft: 8, fontWeight: 400 }}>
                    {t.state}
                    {t.startedAt ? ` · ${formatElapsed(t.startedAt)}` : ''}
                  </span>
                </div>
                {t.description && (
                  <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.description}
                  </div>
                )}
                {t.error && (
                  <div style={{ color: '#ef4444', fontSize: 11, marginTop: 2 }}>{t.error}</div>
                )}
                {t.writtenPaths && t.writtenPaths.length > 0 && (
                  <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>
                    {t.writtenPaths.length} file{t.writtenPaths.length === 1 ? '' : 's'} written
                  </div>
                )}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 8, paddingTop: 6, borderTop: '1px solid #1e293b' }}>
            Cancel via orchestrator (USE_LLM_ORCHESTRATOR=true). Cancel UI: TBD.
          </div>
        </div>
      )}
    </div>
  );
}
