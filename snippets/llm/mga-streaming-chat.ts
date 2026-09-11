/**
 * scopes: [backend]
 * flags: [ai-chat]
 * description: Stream MGA assistant responses (TypeScript) to the frontend via SSE.
 */

/**
 * MGA Streaming Chat (SSE forwarder) — TypeScript
 *
 * Express middleware that opens a Server-Sent Events stream to the user's
 * browser, calls MGA's /chat/agent with stream=true, parses the incoming
 * SSE chunks, and forwards them as `data:` events on the outbound stream.
 *
 * Pairs with snippets/frontend/MgaChatComponent.tsx which consumes the
 * stream via EventSource.
 *
 * Why a server-side proxy: MGA_API_KEY must never reach the browser. The
 * backend is the only thing that holds the key; it proxies user messages
 * through.
 *
 * Dependencies: none (Node 18+ has fetch with streaming).
 *
 * Environment variables:
 *   MGA_API_KEY, MGA_BASE_URL, MGA_ASSISTANT_ID (written to .env by harness).
 *
 * Usage (Express):
 *   import { streamChat } from './mga-streaming-chat.js';
 *   app.post('/chat/stream', streamChat);
 *
 * Request shape:
 *   { message: string, conversationId?: string }
 *
 * Response stream (SSE):
 *   data: {"delta": "..."}            — content chunk
 *   data: {"conversationId": "..."}   — conversation id (once, near end)
 *   data: {"done": true}              — final marker
 *   data: {"error": "..."}            — only on failure
 *   (then connection closes)
 */

import type { Request, Response, RequestHandler } from 'express';

const MGA_API_KEY: string | undefined = process.env.MGA_API_KEY;
const MGA_BASE_URL: string =
  process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2';
const MGA_ASSISTANT_ID: string | undefined = process.env.MGA_ASSISTANT_ID;

if (!MGA_API_KEY || !MGA_ASSISTANT_ID) {
  throw new Error(
    'MGA not configured. Set MGA_API_KEY and MGA_ASSISTANT_ID in env.'
  );
}

interface StreamChatBody {
  message?: string;
  conversationId?: string;
}

interface StreamEvent {
  delta?: string;
  conversationId?: string;
  done?: boolean;
  error?: string;
}

interface MgaSseChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  conversation_id?: string;
}

interface MgaRequestBody {
  assistant_id: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  stream: boolean;
  hidden: boolean;
  conversation_id?: string;
}

// Express response may be wrapped by compression — only some have `flush()`.
type FlushableResponse = Response & { flush?: () => void };

export const streamChat: RequestHandler = async (req: Request, res: Response) => {
  const { message, conversationId } = (req.body || {}) as StreamChatBody;
  if (typeof message !== 'string' || message.length === 0) {
    res.status(400).json({ error: 'message required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (obj: StreamEvent): void => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const flushable = res as FlushableResponse;
    if (typeof flushable.flush === 'function') flushable.flush();
  };

  const body: MgaRequestBody = {
    assistant_id: MGA_ASSISTANT_ID as string,
    messages: [{ role: 'user', content: message }],
    stream: true,
    hidden: false,
  };
  if (conversationId) body.conversation_id = conversationId;

  try {
    const upstream = await fetch(
      `${MGA_BASE_URL.replace(/\/$/, '')}/chat/agent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MGA_API_KEY}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      }
    );

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      send({ error: `Upstream HTTP ${upstream.status}: ${txt.slice(0, 300)}` });
      res.end();
      return;
    }
    if (!upstream.body) {
      send({ error: 'Upstream returned no body stream' });
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let convoIdSent = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as MgaSseChunk;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) send({ delta });
          if (!convoIdSent && parsed.conversation_id) {
            send({ conversationId: parsed.conversation_id });
            convoIdSent = true;
          }
        } catch {
          // Non-JSON keepalive or comment — ignore.
        }
      }
    }
    send({ done: true });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ error: message });
    res.end();
  }
};
