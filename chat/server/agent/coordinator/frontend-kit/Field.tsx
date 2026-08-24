import type { CSSProperties } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';

const controlStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14,
  border: '1px solid var(--kit-border-strong)', borderRadius: 'var(--kit-radius-sm)',
  background: 'var(--kit-surface)', color: 'var(--kit-text)', fontFamily: 'var(--kit-font)',
};

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...controlStyle, ...props.style }} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...controlStyle, minHeight: 90, resize: 'vertical', ...props.style }} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...controlStyle, ...props.style }} />;
}

export interface FormFieldProps {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}

/** Label + control + validation message. Wrap every form control in one. */
export function FormField({ label, required, error, hint, children }: FormFieldProps) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 5 }}>
        {label}{required && <span style={{ color: 'var(--kit-danger)' }}> *</span>}
      </label>
      {children}
      {hint && !error && <div style={{ fontSize: 12, color: 'var(--kit-text-muted)', marginTop: 4 }}>{hint}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--kit-danger)', marginTop: 4 }}>{error}</div>}
    </div>
  );
}
