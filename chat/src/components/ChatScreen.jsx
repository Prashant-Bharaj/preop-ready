import { useState, useEffect, useRef } from 'react';
import { sendMessage, resetSession, connectStream } from '../lib/api.js';
import MessageBubble from './MessageBubble.jsx';

export default function ChatScreen({ sessionId, onReset }) {
  const [events, setEvents] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [meta, setMeta] = useState({ branch: '—', commitSha: '—' });
  const [status, setStatus] = useState('working');
  const messagesEndRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return;

    const ws = connectStream(sessionId, (event) => {
      if (event.type === 'meta') {
        setMeta(event.payload);
      } else if (event.type === 'status') {
        setStatus(event.payload.status);
        setEvents((prev) => [...prev, event]);
      } else if (event.type === 'cline') {
        // Skip noisy internal events from display
        const say = event.payload?.say;
        if (say === 'api_req_started') return;
        setEvents((prev) => [...prev, event]);
        // Update status based on Cline activity
        if (say === 'completion_result') {
          setStatus('idle');
        } else if (say === 'text' || say === 'command' || say === 'tool') {
          setStatus('working');
        }
      } else {
        setEvents((prev) => [...prev, event]);
      }
    });

    wsRef.current = ws;
    return () => ws.close();
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  async function handleSend(e) {
    e.preventDefault();
    const msg = input.trim();
    if (!msg || !sessionId) return;

    setInput('');
    setSending(true);
    try {
      await sendMessage(sessionId, msg);
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  }

  async function handleReset() {
    if (!sessionId) return;
    try { await resetSession(sessionId); } catch { /* ignore */ }
    setEvents([]);
    onReset();
  }

  const statusLabel = { working: 'Working', idle: 'Idle', error: 'Error', completed: 'Completed' };
  const statusColor = { working: '#f59e0b', idle: '#10b981', error: '#ef4444', completed: '#10b981' };

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <div className="header-left">
          <h2>Chat</h2>
          <span className="status-badge" style={{ backgroundColor: statusColor[status] || '#6b7280' }}>
            {statusLabel[status] || status}
          </span>
        </div>
        <div className="header-right">
          <span className="git-info" title={meta.commitSha}>
            {meta.branch} @ {meta.commitSha?.slice(0, 7)}
          </span>
          <button className="btn-reset" onClick={handleReset}>Reset Session</button>
        </div>
      </header>

      <div className="messages-container">
        {events.length === 0 && (
          <div className="empty-state">Session started. Cline is initializing...</div>
        )}
        {events.map((event, i) => (
          <MessageBubble key={i} type={event.type} payload={event.payload} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form className="chat-input-bar" onSubmit={handleSend}>
        <input
          type="text"
          placeholder={status === 'working' ? 'Cline is working...' : 'Type your message...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending || status === 'working'}
          autoFocus
        />
        <button type="submit" disabled={sending || !input.trim() || status === 'working'}>
          {status === 'working' ? 'Working...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
