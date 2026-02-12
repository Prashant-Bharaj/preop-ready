/**
 * LLM Assistant Router — routes user messages through a pre-configured
 * assistant on the corp LLM platform before sending to Cline.
 *
 * The assistant either:
 *   1. Asks clarifying questions (action: "clarify") → relayed to user
 *   2. Produces a task specification (action: "execute") → sent to Cline
 *
 * Multi-turn conversation is maintained via the platform's conversation_id.
 */

import { getCredentials } from '../auth.js';

/**
 * Derive the platform API base from the OpenAI-compatible base URL.
 * Strips the trailing /v1 but keeps the rest of the path.
 * e.g. "https://chat.int.bayer.com/api/v1" → "https://chat.int.bayer.com/api"
 */
function getPlatformBase(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

/**
 * Route a user message through the assistant LLM.
 * Uses streaming (SSE) to reduce perceived latency — the onProgress callback
 * fires periodically with accumulated token count so the UI can show activity.
 *
 * @param {string} userMessage - The raw user message
 * @param {object} envContext - Project environment context from env-context.js
 * @param {object} opts
 * @param {string|null} opts.conversationId - Existing conversation ID for multi-turn
 * @param {function|null} opts.onProgress - Called with { chars, elapsedMs } during streaming
 * @returns {{ action: string, message: string, tasks: Array, conversationId: string|null }}
 */
export async function routeMessage(userMessage, envContext, { conversationId = null, onProgress = null } = {}) {
  const creds = getCredentials();
  if (!creds) throw new Error('No credentials configured');

  const assistantId = process.env.ASSISTANT_ID || creds.assistantId;
  if (!assistantId) {
    console.warn('[router] No ASSISTANT_ID configured — bypassing router, sending directly to Cline');
    return {
      action: 'execute',
      message: '',
      task: userMessage,
      rules: [],
      snippets: [],
      conversationId: null,
    };
  }

  const platformBase = getPlatformBase(creds.baseUrl);
  const url = `${platformBase}/chat/agent`;

  const enrichedMessage = buildRouterMessage(userMessage, envContext);

  const body = {
    messages: [{ role: 'user', content: enrichedMessage }],
    assistant_id: assistantId,
    stream: true,
    buffer_length: 10,
    hidden: true,       // hide from platform UI — these are automated routing calls
    tool_keys: [],      // no tools needed for routing
  };

  if (conversationId) {
    body.conversation_id = conversationId;
  }

  console.log('[router] Calling assistant (streaming): url=%s assistant=%s conversation=%s',
    url, assistantId, conversationId || 'new');

  const startTime = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown');
    throw new Error(`Router API error (${res.status}): ${errText}`);
  }

  // Parse SSE stream and accumulate content
  const { content, responseConversationId } = await parseSSEResponse(res, conversationId, {
    startTime,
    onProgress,
  });

  console.log('[router] Response in %dms (%d chars): conversation=%s',
    Date.now() - startTime, content.length, responseConversationId);

  // Parse the assistant's JSON response
  return parseRouterJSON(content, responseConversationId);
}

/**
 * Parse an SSE (Server-Sent Events) streaming response from the platform.
 * Accumulates delta content tokens into a single string.
 * Extracts conversation_id from the stream metadata.
 */
async function parseSSEResponse(res, fallbackConversationId, { startTime, onProgress }) {
  let content = '';
  let responseConversationId = fallbackConversationId;
  let lastProgressAt = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6));

        // Extract content delta (OpenAI-compatible format)
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
        }

        // Also handle non-delta content (some platforms send full content)
        if (!delta && data.choices?.[0]?.message?.content) {
          content = data.choices[0].message.content;
        }

        // Extract conversation_id from any chunk that has it
        if (data.conversation_id) {
          responseConversationId = data.conversation_id;
        }
        if (data.metadata?.conversation_id) {
          responseConversationId = data.metadata.conversation_id;
        }
      } catch {
        // Skip malformed SSE lines
      }
    }

    // Fire progress callback at most every 500ms
    if (onProgress && Date.now() - lastProgressAt > 500) {
      lastProgressAt = Date.now();
      onProgress({ chars: content.length, elapsedMs: Date.now() - startTime });
    }
  }

  return { content, responseConversationId };
}

/**
 * Parse the router's JSON response from accumulated content.
 * Handles markdown code blocks, normalizes to tasks array format.
 */
function parseRouterJSON(content, conversationId) {
  try {
    // Handle markdown code blocks wrapping JSON (common LLM behavior)
    const cleaned = content
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // Normalize to tasks array format (support both old single-task and new multi-task)
    let tasks;
    if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
      // New format: tasks array with scopes
      tasks = parsed.tasks.map(t => ({
        scope: t.scope || 'fullstack',
        task: t.task || '',
        rules: Array.isArray(t.rules) ? t.rules : [],
        snippets: Array.isArray(t.snippets) ? t.snippets : [],
      }));
    } else if (parsed.task) {
      // Old format: single task string — wrap in array
      tasks = [{
        scope: 'fullstack',
        task: parsed.task,
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],
      }];
    } else {
      tasks = [];
    }

    console.log('[router] Parsed: action=%s tasks=%d scopes=[%s]',
      parsed.action, tasks.length, tasks.map(t => t.scope).join(', '));

    return {
      action: parsed.action || 'clarify',
      message: parsed.message || '',
      tasks,
      conversationId,
    };
  } catch (err) {
    console.warn('[router] Failed to parse response as JSON: %s — treating as clarification', err.message);
    return {
      action: 'clarify',
      message: content,
      tasks: [],
      conversationId,
    };
  }
}

/**
 * Build the message sent to the router assistant.
 * Prepends project context + platform rules summary so the assistant can make
 * informed routing decisions without asking about technology choices.
 */
function buildRouterMessage(userMessage, envContext) {
  if (!envContext) return userMessage;

  const lines = ['[Project Context]'];
  lines.push(`Environment: ${envContext.environment === 'codespaces' ? 'GitHub Codespace' : 'Local'}`);
  lines.push(`Phase: ${envContext.projectPhase}`);

  const parts = [];
  if (envContext.hasStructure?.frontend) parts.push('frontend');
  if (envContext.hasStructure?.backend) parts.push('backend');
  if (envContext.hasStructure?.database) parts.push('database');
  if (envContext.hasStructure?.vectordb) parts.push('vectordb');
  lines.push(`Structure: ${parts.length > 0 ? parts.join(' + ') : 'none (fresh project)'}`);

  if (envContext.projectStatus?.idea) {
    lines.push(`Idea: ${envContext.projectStatus.idea}`);
  }
  if (envContext.projectStatus?.stack) {
    lines.push(`Stack: ${envContext.projectStatus.stack}`);
  }
  if (envContext.projectStatus?.completedTasks?.length > 0) {
    lines.push(`Recent tasks: ${envContext.projectStatus.completedTasks.slice(-3).join('; ')}`);
  }

  lines.push('');
  lines.push('[User Message]');
  lines.push(userMessage);

  return lines.join('\n');
}
