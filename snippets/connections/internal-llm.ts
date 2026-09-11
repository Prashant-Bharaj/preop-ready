/**
 * scopes: [backend]
 * flags: [ai-chat, ai-rag]
 * description: Internal LLM API client (TypeScript, corp gateway). Use for ai-chat and ai-rag flows.
 */

/**
 * Internal LLM API Connection (TypeScript)
 *
 * Connect to the corporate internal LLM endpoint.
 * Supports non-streaming completions; extend with streaming as needed.
 *
 * Environment variables:
 *   LLM_BASE_URL  — Base URL for the LLM API (e.g. https://llm.internal.corp/api/v2)
 *   LLM_API_KEY   — API key for authentication
 *   LLM_MODEL     — Model ID to use (default: gpt-4o)
 *
 * Example:
 *   import { chatCompletion } from './internal-llm.js';
 *   const text = await chatCompletion([
 *     { role: 'system', content: 'You are a helpful assistant.' },
 *     { role: 'user', content: 'Hello!' },
 *   ]);
 */

const LLM_BASE_URL: string = process.env.LLM_BASE_URL || 'https://llm.internal.corp/api/v2';
const LLM_API_KEY: string | undefined = process.env.LLM_API_KEY;
const LLM_MODEL: string = process.env.LLM_MODEL || 'gpt-4o';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { role: ChatRole; content: string } }>;
}

export async function chatCompletion(
  messages: ChatMessage[],
  { model = LLM_MODEL, temperature = 0.7 }: ChatCompletionOptions = {}
): Promise<string> {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY is not set');
  }

  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  if (!res.ok) {
    throw new Error(`LLM API error (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  return data.choices[0].message.content;
}
