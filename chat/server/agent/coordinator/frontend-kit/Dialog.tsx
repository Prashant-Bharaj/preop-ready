import type { ReactNode } from 'react';
import { Button } from './Button.js';

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(16,24,40,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--kit-surface)', borderRadius: 'var(--kit-radius)', boxShadow: 'var(--kit-shadow-lg)', width: 'min(520px, calc(100vw - 32px))', maxHeight: '85vh', overflowY: 'auto' }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--kit-border)', fontWeight: 700, fontSize: 16 }}>{title}</div>
        <div style={{ padding: 20 }}>{children}</div>
        {footer && <div style={{ padding: '12px 20px', borderTop: '1px solid var(--kit-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Use for every destructive action (delete, close, overwrite). */
export function ConfirmDialog({ open, title = 'Are you sure?', message, confirmLabel = 'Confirm', danger = true, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Dialog
      open={open} title={title} onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      <div style={{ fontSize: 14, color: 'var(--kit-text-muted)' }}>{message}</div>
    </Dialog>
  );
}
