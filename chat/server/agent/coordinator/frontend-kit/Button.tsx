import type { CSSProperties } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner.js';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const base: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  borderRadius: 'var(--kit-radius-sm)', fontWeight: 600, cursor: 'pointer',
  border: '1px solid transparent', transition: 'background 120ms, border-color 120ms',
  fontFamily: 'var(--kit-font)',
};
const variants: Record<Variant, CSSProperties> = {
  primary: { background: 'var(--kit-accent)', color: '#fff' },
  secondary: { background: 'var(--kit-surface)', color: 'var(--kit-text)', borderColor: 'var(--kit-border-strong)' },
  danger: { background: 'var(--kit-danger)', color: '#fff' },
  ghost: { background: 'transparent', color: 'var(--kit-accent)' },
};
const sizes: Record<Size, CSSProperties> = {
  sm: { padding: '5px 10px', fontSize: 13 },
  md: { padding: '8px 14px', fontSize: 14 },
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading = false, disabled, children, style, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      style={{ ...base, ...variants[variant], ...sizes[size], opacity: disabled || loading ? 0.6 : 1, ...style }}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}
