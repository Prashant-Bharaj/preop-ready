import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface FileDropzoneProps {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Called with the selected/dropped files. Do the upload in the parent. */
  onFiles: (files: File[]) => void;
  children?: ReactNode;
}

/** Drag-and-drop + click-to-browse file input with visible feedback. */
export function FileDropzone({ accept, multiple = false, disabled = false, onFiles, children }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const handle = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };
  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) handle(e.dataTransfer.files); }}
      style={{
        border: `2px dashed ${over ? 'var(--kit-accent)' : 'var(--kit-border-strong)'}`,
        background: over ? 'var(--kit-accent-soft)' : 'var(--kit-surface)',
        borderRadius: 'var(--kit-radius)', padding: 28, textAlign: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer', color: 'var(--kit-text-muted)', fontSize: 14,
      }}
    >
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} hidden
        onChange={(e) => { handle(e.target.files); e.target.value = ''; }} />
      {children || <span>Drop files here or <span style={{ color: 'var(--kit-accent)', fontWeight: 600 }}>browse</span></span>}
    </div>
  );
}
