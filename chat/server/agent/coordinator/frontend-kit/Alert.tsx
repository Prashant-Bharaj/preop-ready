import type { ReactNode } from 'react';

type Kind = 'info' | 'success' | 'warning' | 'danger';
const kinds: Record<Kind, { bg: string; fg: string }> = {
  info: { bg: 'var(--kit-accent-soft)', fg: 'var(--kit-accent)' },
  success: { bg: 'var(--kit-success-soft)', fg: 'var(--kit-success)' },
  warning: { bg: 'var(--kit-warning-soft)', fg: 'var(--kit-warning)' },
  danger: { bg: 'var(--kit-danger-soft)', fg: 'var(--kit-danger)' },
};

export function Alert({ kind = 'info', title, children }: { kind?: Kind; title?: ReactNode; children: ReactNode }) {
  const c = kinds[kind];
  return (
    <div role={kind === 'danger' ? 'alert' : 'status'} style={{ background: c.bg, color: c.fg, border: `1px solid ${'currentColor'}`, borderRadius: 'var(--kit-radius-sm)', padding: '10px 14px', fontSize: 14, marginBottom: 12 }}>
      {title && <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>}
      <div>{children}</div>
    </div>
  );
}

export function Badge({ children, kind = 'info' }: { children: ReactNode; kind?: Kind }) {
  const c = kinds[kind];
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}
