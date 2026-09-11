/**
 * scopes: [backend]
 * flags: [ai-chat, ai-rag]
 * description: Direct chat completion client (TypeScript) against the corp LLM gateway.
 */

/**
 * Bayer Internal LLM Client (TypeScript)
 *
 * Connects to Bayer's internal LLM platform using the OpenAI-compatible API.
 * Handles authentication, endpoint resolution, and error handling.
 * Falls back to mock responses when credentials are not configured (local dev).
 *
 * Dependencies:
 *   npm install axios
 *
 * Environment variables (GitHub Secrets -> Container):
 *   SECRET_1 / LLM_ENDPOINT — LLM endpoint URL (e.g. https://your-llm.com/v1)
 *   API_KEY / LLM_API_KEY  — Bearer token
 *   SECRET_2 / LLM_MODEL   — Model name (e.g. gpt-4)
 *
 * Example:
 *   import { callLLM } from './bayer-llm-client.js';
 *   const answer = await callLLM('What is the capital of France?');
 */

import axios, { type AxiosError } from 'axios';

// ---------------------------------------------------------------------------
// Configuration (reads from environment variables)
// ---------------------------------------------------------------------------
export interface LlmConfig {
  endpoint: string | undefined;
  apiKey: string | undefined;
  model: string;
  temperature: number;
  maxTokens: number | undefined;
}

export const LLM_CONFIG: LlmConfig = {
  endpoint: process.env.SECRET_1 || process.env.LLM_ENDPOINT,
  apiKey: process.env.API_KEY || process.env.LLM_API_KEY,
  model: process.env.SECRET_2 || process.env.LLM_MODEL || 'gpt-4',
  temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.1') || 0.1,
  maxTokens: process.env.LLM_MAX_TOKENS
    ? parseInt(process.env.LLM_MAX_TOKENS, 10)
    : undefined,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CallLlmOptions {
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  skipMock?: boolean;
}

interface ChatCompletionChoice {
  message: { role: string; content: string };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

interface ChatCompletionBody {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  max_tokens?: number;
}

// ---------------------------------------------------------------------------
// Core LLM function
// ---------------------------------------------------------------------------

/**
 * Call the Bayer internal LLM API (OpenAI-compatible format).
 */
export async function callLLM(
  prompt: string,
  options: CallLlmOptions = {}
): Promise<string> {
  const { endpoint, apiKey, model, temperature, maxTokens } = LLM_CONFIG;

  if (!endpoint || !apiKey) {
    if (options.skipMock) {
      throw new Error(
        'LLM not configured - set SECRET_1 and API_KEY environment variables'
      );
    }
    console.warn('[LLM] No endpoint/API key configured, using mock response');
    return 'Mock response: LLM is not configured. Set SECRET_1 (endpoint) and API_KEY.';
  }

  const selectedModel = options.model || model;

  // Auto-append /chat/completions if not already present
  const fullEndpoint = endpoint.endsWith('/chat/completions')
    ? endpoint
    : `${endpoint}/chat/completions`;

  const systemPrompt = options.systemPrompt || 'You are a helpful assistant.';

  const body: ChatCompletionBody = {
    model: selectedModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: options.temperature ?? temperature,
  };

  const tokenLimit = options.maxTokens ?? maxTokens;
  if (tokenLimit) {
    body.max_tokens = tokenLimit;
  }

  try {
    const response = await axios.post<ChatCompletionResponse>(fullEndpoint, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    const axiosErr = error as AxiosError;
    const errPayload = axiosErr.response?.data ?? axiosErr.message;
    console.error('[LLM] API call failed:', errPayload);
    const message = axiosErr.message || String(error);
    throw new Error(`LLM API call failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export interface LlmConnectionTestResult {
  success: boolean;
  message: string;
  responseTime?: number;
  model: string;
  config?: {
    endpoint: boolean;
    apiKey: boolean;
    model: string;
  };
}

export async function testLLMConnection(): Promise<LlmConnectionTestResult> {
  if (!LLM_CONFIG.endpoint || !LLM_CONFIG.apiKey) {
    return {
      success: false,
      message: 'LLM not configured',
      model: LLM_CONFIG.model,
      config: {
        endpoint: !!LLM_CONFIG.endpoint,
        apiKey: !!LLM_CONFIG.apiKey,
        model: LLM_CONFIG.model,
      },
    };
  }

  const startTime = Date.now();
  try {
    await callLLM('Respond with exactly one word: "OK"', {
      maxTokens: 10,
      skipMock: true,
    });
    return {
      success: true,
      message: 'LLM connection successful',
      responseTime: Date.now() - startTime,
      model: LLM_CONFIG.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `LLM connection failed: ${message}`,
      responseTime: Date.now() - startTime,
      model: LLM_CONFIG.model,
    };
  }
}
