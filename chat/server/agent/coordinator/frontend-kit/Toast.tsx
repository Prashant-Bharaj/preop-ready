import type { CSSProperties } from 'react';
import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: string }
type ToastFn = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastFn>(() => {});

/** Read the toast function anywhere below <ToastProvider>. */
export function useToast(): ToastFn {
  return useContext(ToastContext);
}

const kindStyles: Record<ToastKind, CSSProperties> = {
  success: { background: 'var(--kit-success-soft)', color: 'var(--kit-success)', borderColor: 'var(--kit-success)' },
  error: { background: 'var(--kit-danger-soft)', color: 'var(--kit-danger)', borderColor: 'var(--kit-danger)' },
  info: { background: 'var(--kit-accent-soft)', color: 'var(--kit-accent)', borderColor: 'var(--kit-accent)' },
};

/** Mount ONCE around the app (AppShell does this for you). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback<ToastFn>((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 2000 }}>
        {items.map((t) => (
          <div key={t.id} role="status" style={{ padding: '10px 14px', borderRadius: 'var(--kit-radius-sm)', border: '1px solid', boxShadow: 'var(--kit-shadow)', fontSize: 14, maxWidth: 380, ...kindStyles[t.kind] }}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
