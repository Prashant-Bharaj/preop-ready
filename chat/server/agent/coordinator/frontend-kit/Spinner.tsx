export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-label="Loading"
      style={{
        width: size, height: size, display: 'inline-block',
        border: '2px solid var(--kit-border)', borderTopColor: 'var(--kit-accent)',
        borderRadius: '50%', animation: 'kit-spin 700ms linear infinite',
      }}
    >
      <style>{'@keyframes kit-spin { to { transform: rotate(360deg); } }'}</style>
    </span>
  );
}
