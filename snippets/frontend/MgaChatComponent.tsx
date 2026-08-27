/**
 * scopes: [frontend]
 * flags: [ai-chat]
 * description: React chat UI (TypeScript + Tailwind) consuming the backend's SSE proxy to MGA. Pairs with snippets/llm/mga-streaming-chat.ts.
 */

/**
 * MGA Chat Component (TypeScript + Tailwind)
 *
 * Minimal React chat UI that:
 *   - Renders a scrolling message log (user / assistant turns)
 *   - POSTs the user's message to /api/chat/stream
 *   - Parses the streamed SSE response (delta / conversationId / done / error)
 *   - Renders the assistant's reply token-by-token as it arrives
 *   - Persists conversationId across turns (server-held memory)
 *
 * Uses fetch + ReadableStream rather than EventSource because EventSource
 * only supports GET and we need to POST the message body. The parsing logic
 * mirrors what backend's mga-streaming-chat.ts writes out.
 *
 * Dependencies: React 18+. Uses shadcn Button / Input.
 *
 * Backend contract (provide via mga-streaming-chat.ts):
 *   POST /api/chat/stream  body: { message, conversationId? }
 *   Response: text/event-stream
 *     data: {"delta":"..."}
 *     data: {"conversationId":"..."}
 *     data: {"done":true}
 *     data: {"error":"..."}
 *
 * Usage:
 *   import ChatPanel from './ChatPanel.js';
 *   <ChatPanel apiUrl="/api/chat/stream" />
 */

import * as React from 'react';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { cn } from './lib/utils.js';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface SseEvent {
  delta?: string;
  conversationId?: string;
  done?: boolean;
  error?: string;
}

export interface ChatPanelProps {
  apiUrl?: string;
  className?: string;
}

export default function ChatPanel({
  apiUrl = '/api/chat/stream',
  className,
}: ChatPanelProps): React.JSX.Element {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const conversationIdRef = React.useRef<string | null>(null);
  const logEndRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(e?: React.FormEvent<HTMLFormElement>): Promise<void> {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setMessages((m) => [
      ...m,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversationId: conversationIdRef.current,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('No response body stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          try {
            const parsed = JSON.parse(payload) as SseEvent;
            if (parsed.delta) {
              setMessages((m) => {
                const copy = m.slice();
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = {
                  role: 'assistant',
                  content: last.content + parsed.delta,
                };
                return copy;
              });
            }
            if (parsed.conversationId) {
              conversationIdRef.current = parsed.conversationId;
            }
            if (parsed.error) {
              setMessages((m) => {
                const copy = m.slice();
                copy[copy.length - 1] = {
                  role: 'assistant',
                  content: `[error] ${parsed.error}`,
                };
                return copy;
              });
            }
          } catch {
            // non-JSON keepalive, ignore
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages((m) => {
        const copy = m.slice();
        copy[copy.length - 1] = {
          role: 'assistant',
          content: `[error] ${message}`,
        };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        'mx-auto flex h-full max-w-3xl flex-col font-sans',
        className
      )}
    >
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mt-10 text-center text-slate-400">
            Send a message to start the conversation.
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              'max-w-[85%] rounded-lg px-3 py-2',
              m.role === 'user'
                ? 'self-end bg-sky-100 text-slate-900'
                : 'self-start bg-slate-100 text-slate-900'
            )}
          >
            <div className="mb-0.5 text-xs font-semibold uppercase text-slate-500">
              {m.role}
            </div>
            <div className="whitespace-pre-wrap break-words">
              {m.content || (m.role === 'assistant' && busy ? '…' : '')}
            </div>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
      <form
        onSubmit={send}
        className="flex gap-2 border-t border-slate-200 p-3"
      >
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={busy}
          autoFocus
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
