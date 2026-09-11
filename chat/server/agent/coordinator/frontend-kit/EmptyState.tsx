import type { ReactNode } from 'react';

/** Render when a list/query returns nothing. Always offer the next action. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--kit-text-muted)' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--kit-text)' }}>{title}</div>
      {hint && <div style={{ fontSize: 13, marginTop: 6 }}>{hint}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
