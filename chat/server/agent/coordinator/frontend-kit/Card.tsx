import type { CSSProperties } from 'react';
import type { ReactNode } from 'react';

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: 'var(--kit-surface)', border: '1px solid var(--kit-border)', borderRadius: 'var(--kit-radius)', boxShadow: 'var(--kit-shadow)', ...style }}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--kit-border)' }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13, color: 'var(--kit-text-muted)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

export function CardContent({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ padding: 20, ...style }}>{children}</div>;
}
