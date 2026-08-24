/**
 * DropZone — full-container overlay shown while the user is dragging files
 * over the chat input. Purely presentational; the parent handles the actual
 * drag events and the file upload itself.
 */
export default function DropZone({ visible }) {
  if (!visible) return null;
  return (
    <div className="dropzone-overlay" role="presentation">
      <div className="dropzone-inner">
        <div className="dropzone-title">Drop to attach</div>
        <div className="dropzone-hint">Files land in <code>context/</code> and the AI can reference them.</div>
      </div>
    </div>
  );
}
