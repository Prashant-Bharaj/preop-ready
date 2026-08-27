/**
 * scopes: [backend]
 * flags: [ai-chat]
 * description: Bayer MGA assistant client (TypeScript) — chat via /chat/agent with assistant_id + conversation_id.
 */

/**
 * Bayer MGA Assistant Client (TypeScript)
 *
 * Calls the assistant created for this app at /confirm time. Uses the
 * /chat/agent endpoint with `assistant_id` so the assistant's stored
 * instructions, model, and tools take effect. Pass `conversationId` to
 * continue a server-held conversation across HTTP turns; pass null/undefined
 * to start a fresh one (the response includes the new conversation_id).
 *
 * For streaming, see mga-streaming-chat.ts.
 * For image inputs, see mga-vision-chat.ts.
 * For end-user file uploads (RAG), see mga-file-upload.ts.
 *
 * Dependencies: none (uses global fetch in Node 18+).
 *
 * Environment variables:
 *   MGA_API_KEY      — bearer token
 *   MGA_BASE_URL     — e.g. https://chat.int.bayer.com/api/v2
 *   MGA_ASSISTANT_ID — the per-app assistant UUID
 *
 * Example:
 *   import { chatWithAssistant } from './mga-assistant-client.js';
 *   const r1 = await chatWithAssistant('Hello, what can you do?');
 *   const r2 = await chatWithAssistant('Tell me more', { conversationId: r1.conversationId });
 */

const MGA_API_KEY: string | undefined = process.env.MGA_API_KEY;
const MGA_BASE_URL: string =
  process.env.MGA_BASE_URL || 'https://chat.int.bayer.com/api/v2';
const MGA_ASSISTANT_ID: string | undefined = process.env.MGA_ASSISTANT_ID;

if (!MGA_API_KEY || !MGA_ASSISTANT_ID) {
  throw new Error(
    'MGA not configured. Set MGA_API_KEY and MGA_ASSISTANT_ID in env. ' +
      '(The harness writes these to .env at workspace root during /confirm.)'
  );
}

export interface ChatWithAssistantOptions {
  /** Continue a prior conversation. */
  conversationId?: string | null;
  /**
   * Per-call tool override. When set, the assistant's stored tools
   * (and chat-agent defaults: document_question_answering,
   * document_summarizer, uploaded_docs) are replaced with this list
   * for this turn only. Usually leave undefined.
   */
  toolKeys?: string[] | null;
}

export interface ChatWithAssistantResult {
  text: string;
  conversationId: string | null;
}

interface ChatAgentBody {
  assistant_id: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  stream: boolean;
  hidden: boolean;
  conversation_id?: string;
  tool_keys?: string[];
}

interface ChatAgentResponse {
  choices?: Array<{ message?: { content?: string } }>;
  conversation_id?: string | null;
}

export async function chatWithAssistant(
  message: string,
  { conversationId = null, toolKeys = null }: ChatWithAssistantOptions = {}
): Promise<ChatWithAssistantResult> {
  const body: ChatAgentBody = {
    assistant_id: MGA_ASSISTANT_ID as string,
    messages: [{ role: 'user', content: message }],
    stream: false,
    hidden: false,
  };
  if (conversationId) body.conversation_id = conversationId;
  if (Array.isArray(toolKeys)) body.tool_keys = toolKeys;

  const res = await fetch(`${MGA_BASE_URL.replace(/\/$/, '')}/chat/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MGA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MGA chat failed: HTTP ${res.status} — ${txt.slice(0, 300)}`);
  }
  const data = (await res.json()) as ChatAgentResponse;
  return {
    text: data.choices?.[0]?.message?.content || '',
    conversationId: data.conversation_id || null,
  };
}
