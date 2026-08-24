import { useState, useEffect } from 'react';

export default function Toast({ message, type = 'info', duration = 4000, onDismiss }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  function handleClose() {
    setVisible(false);
    setTimeout(onDismiss, 300);
  }

  return (
    <div className={`toast toast-${type} ${visible ? 'toast-enter' : 'toast-exit'}`} role="alert">
      <span className="toast-icon">
        {type === 'error' ? '!' : type === 'success' ? '\u2713' : 'i'}
      </span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" onClick={handleClose} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
