import type { ReactNode } from 'react';
import { ToastProvider } from './Toast.js';

export interface AppShellProps {
  /** App name shown top-left. */
  title: ReactNode;
  /** Nav entries (render your links/buttons; highlight the active one). */
  nav?: ReactNode;
  /** Right side of the header — identity, role switcher. */
  headerRight?: ReactNode;
  children: ReactNode;
}

/**
 * Standard app frame: header with title + nav + identity, centered content
 * column, toast provider mounted. Wrap the whole app in this (inside
 * ErrorBoundary).
 */
export function AppShell({ title, nav, headerRight, children }: AppShellProps) {
  return (
    <ToastProvider>
      <header style={{
        background: 'var(--kit-surface)', borderBottom: '1px solid var(--kit-border)',
        padding: '0 24px', display: 'flex', alignItems: 'center', gap: 24, height: 56,
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ fontWeight: 800, fontSize: 16, whiteSpace: 'nowrap' }}>{title}</div>
        <nav style={{ display: 'flex', gap: 4, flex: 1 }}>{nav}</nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--kit-text-muted)' }}>{headerRight}</div>
      </header>
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: 24 }}>{children}</main>
    </ToastProvider>
  );
}

/** Header nav link — pass active to highlight the current page. */
export function NavLink({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: '6px 12px',
        borderRadius: 'var(--kit-radius-sm)', fontFamily: 'var(--kit-font)',
        background: active ? 'var(--kit-accent-soft)' : 'transparent',
        color: active ? 'var(--kit-accent)' : 'var(--kit-text-muted)',
      }}
    >
      {children}
    </button>
  );
}
