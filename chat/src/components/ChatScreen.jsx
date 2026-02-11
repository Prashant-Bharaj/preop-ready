import { useState, useEffect, useRef, useCallback } from 'react';
import { sendMessage, resetSession, connectStream } from '../lib/api.js';
import MessageBubble from './MessageBubble.jsx';
import { SendIcon, ChevronDownIcon, MenuIcon } from './Icon.jsx';

const QUICK_ACTIONS = [
  { emoji: '🧪', label: 'Test locally', prompt: 'Run my application locally with docker compose and test it' },
  { emoji: '🚀', label: 'Deploy', prompt: 'Deploy my application to production' },
  { emoji: '📊', label: 'Project status', prompt: 'What is the current status of my project? What has been done and what is left?' },
  { emoji: '🔧', label: 'Fix errors', prompt: 'Check my application for errors and fix any issues you find' },
];

const SUGGESTIONS = [
  { emoji: '💡', text: 'Build me a simple to-do list app' },
  { emoji: '🌐', text: 'Create a landing page for my idea' },
  { emoji: '📝', text: 'Help me plan my application' },
  { emoji: '🤔', text: "What can you help me with?" },
];

export default function ChatScreen({ sessionId, onReset, onOpenDrawer }) {
  const [events, setEvents] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [meta, setMeta] = useState({ branch: '—', commitSha: '—' });
  const [status, setStatus] = useState('working');
  const [activity, setActivity] = useState('Initializing...');
  const [wsStatus, setWsStatus] = useState('connected');
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const textareaRef = useRef(null);
  const streamRef = useRef(null);
  const lastFailedMsg = useRef(null);

  function findLastTextIndex(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]?.type === 'cline' && arr[i]?.payload?.say === 'text') return i;
    }
    return -1;
  }

  function processHistoryBatch(rawEvents) {
    const result = [];
    for (const event of rawEvents) {
      if (event.type === 'meta' || event.type === 'status') continue;
      if (event.type === 'cline') {
        const say = event.payload?.say;
        if (say === 'api_req_started') continue;
        if (say === 'text') {
          const last = result[result.length - 1];
          if (last?.type === 'cline' && last?.payload?.say === 'text') {
            result[result.length - 1] = event;
            continue;
          }
        }
        if (say === 'completion_result') {
          const idx = findLastTextIndex(result);
          if (idx !== -1) { result[idx] = event; continue; }
        }
      }
      result.push(event);
    }
    return result;
  }

  useEffect(() => {
    if (!sessionId) return;

    const stream = connectStream(sessionId, (event) => {
      if (event.type === 'history_batch') {
        const restored = processHistoryBatch(event.events || []);
        setEvents(restored);
        const lastStatus = [...(event.events || [])].reverse().find(e => e.type === 'status');
        if (lastStatus) {
          const s = lastStatus.payload.status;
          setStatus(s);
          if (s === 'idle') setActivity('');
          else if (s === 'working') setActivity('Thinking...');
        }
        return;
      }

      if (event.type === 'meta') {
        setMeta(event.payload);
      } else if (event.type === 'status') {
        const s = event.payload.status;
        setStatus(s);
        if (s === 'idle') setActivity('');
        else if (s === 'working') setActivity((prev) => prev || 'Thinking...');
      } else if (event.type === 'cline') {
        const say = event.payload?.say;
        if (say === 'api_req_started') return;

        if (say === 'tool') {
          try {
            const info = JSON.parse(event.payload.text);
            if (['read_file', 'list_files', 'search_files', 'list_code_definition_names'].includes(info.tool)) {
              setActivity('Reading files...');
            } else if (info.tool === 'write_to_file' || info.tool === 'replace_in_file') {
              setActivity('Writing code...');
            } else {
              setActivity('Working...');
            }
          } catch { setActivity('Working...'); }
        } else if (say === 'command') {
          setActivity('Running command...');
        } else if (say === 'text') {
          setActivity('Responding...');
        } else if (say === 'completion_result') {
          setActivity('');
        }

        if (say === 'text') {
          setEvents((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === 'cline' && last?.payload?.say === 'text') {
              return [...prev.slice(0, -1), event];
            }
            return [...prev, event];
          });
          return;
        }

        if (say === 'completion_result') {
          setEvents((prev) => {
            const idx = findLastTextIndex(prev);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = event;
              return next;
            }
            return [...prev, event];
          });
          return;
        }

        setEvents((prev) => [...prev, event]);
      } else {
        setEvents((prev) => [...prev, event]);
      }
    }, (connStatus) => {
      setWsStatus(connStatus);
    });

    streamRef.current = stream;
    return () => stream.close();
  }, [sessionId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  // Scroll position detection for scroll-to-bottom button
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(distFromBottom > 200);
  }, []);

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  // Auto-resize textarea
  function handleInputChange(e) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend(e) {
    if (e) e.preventDefault();
    const msg = input.trim();
    if (!msg || !sessionId) return;

    setInput('');
    setSending(true);
    setSendError(null);
    lastFailedMsg.current = msg;

    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      await sendMessage(sessionId, msg);
    } catch (err) {
      console.error('Send failed:', err);
      setSendError('Message failed to send.');
    } finally {
      setSending(false);
    }
  }

  async function handleRetry() {
    if (!lastFailedMsg.current || !sessionId) return;
    setSending(true);
    setSendError(null);
    try {
      await sendMessage(sessionId, lastFailedMsg.current);
    } catch (err) {
      console.error('Retry failed:', err);
      setSendError('Still unable to send. Check your connection.');
    } finally {
      setSending(false);
    }
  }

  async function handleQuickAction(prompt) {
    if (status === 'working' || sending) return;
    setSending(true);
    setSendError(null);
    lastFailedMsg.current = prompt;
    try {
      await sendMessage(sessionId, prompt);
    } catch (err) {
      console.error('Quick action failed:', err);
      setSendError('Action failed to send.');
    } finally {
      setSending(false);
    }
  }

  async function handleSuggestion(text) {
    if (status === 'working' || sending) return;
    setInput('');
    setSending(true);
    setSendError(null);
    lastFailedMsg.current = text;
    try {
      await sendMessage(sessionId, text);
    } catch (err) {
      console.error('Suggestion failed:', err);
      setSendError('Failed to send. Please try again.');
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

  const isWorking = status === 'working';
  const statusLabel = isWorking ? (activity || 'Working') : status === 'error' ? 'Error' : 'Ready';
  const statusColor = { working: '#f59e0b', idle: '#10b981', error: '#ef4444' };

  // Separate bootstrap events from real user conversation.
  // The server runs a bootstrap prompt on session start, producing events before
  // the user sends anything. Show the welcome state until the first real user message.
  const firstUserIdx = events.findIndex(e => e.type === 'user' && e.payload?.source !== 'system');
  const hasUserMessages = firstUserIdx !== -1;
  const displayEvents = hasUserMessages ? events.slice(firstUserIdx) : [];

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <div className="header-left">
          <button className="btn-menu" onClick={onOpenDrawer} aria-label="Open menu">
            <MenuIcon />
          </button>
          <h2>Chat</h2>
          <span className="status-badge" style={{ backgroundColor: statusColor[status] || '#6b7280' }}>
            {isWorking && <span className="status-dot" />}
            {statusLabel}
          </span>
        </div>
        <div className="header-right">
          <span className="git-info" title={meta.commitSha}>
            {meta.branch} @ {meta.commitSha?.slice(0, 7)}
          </span>
          <button className="btn-reset" onClick={handleReset} aria-label="Start a new session">
            New chat
          </button>
        </div>
      </header>

      {wsStatus === 'disconnected' && (
        <div className="connection-banner" role="alert">
          Connection lost. Trying to reconnect...
        </div>
      )}
      {wsStatus === 'reconnecting' && (
        <div className="connection-banner reconnecting" role="status">
          Reconnecting...
        </div>
      )}

      <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
        {displayEvents.length === 0 && !isWorking && (
          <div className="empty-state">
            <span className="empty-state-emoji" role="img" aria-label="wave">👋</span>
            <h3>What would you like to build?</h3>
            <p>Describe your idea and the AI will create it for you. You can also pick a suggestion below.</p>
            <div className="suggestion-cards">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text}
                  className="suggestion-card"
                  onClick={() => handleSuggestion(s.text)}
                  disabled={sending}
                >
                  <span>{s.emoji}</span> {s.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {displayEvents.length === 0 && isWorking && (
          <div className="empty-state">
            <div className="loading-spinner" />
            <p style={{ marginTop: '1rem' }}>Setting up your session...</p>
          </div>
        )}

        {displayEvents.map((event, i) => (
          <MessageBubble key={i} type={event.type} payload={event.payload} />
        ))}

        {isWorking && displayEvents.length > 0 && (
          <div className="typing-indicator">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-label">{activity || 'Thinking...'}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {showScrollBtn && (
        <button className="scroll-bottom-btn" onClick={scrollToBottom} aria-label="Scroll to bottom">
          <ChevronDownIcon />
        </button>
      )}

      {!isWorking && displayEvents.length > 0 && (
        <div className="quick-actions">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              className="quick-action-btn"
              onClick={() => handleQuickAction(action.prompt)}
              disabled={sending}
            >
              <span>{action.emoji}</span> {action.label}
            </button>
          ))}
        </div>
      )}

      {sendError && (
        <div className="send-error" role="alert">
          <span>{sendError}</span>
          <button onClick={handleRetry}>Retry</button>
        </div>
      )}

      <form className="chat-input-bar" onSubmit={handleSend}>
        <textarea
          ref={textareaRef}
          placeholder={isWorking ? (activity || 'Working...') : 'Describe what you want to build...'}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={sending || isWorking}
          rows={1}
          aria-label="Message input"
        />
        <button
          type="submit"
          className="send-btn"
          disabled={sending || !input.trim() || isWorking}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
