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
 * Derive the API host (origin) from the OpenAI-compatible base URL.
 * e.g. "https://genai-api.bayer.com/v1" → "https://genai-api.bayer.com"
 */
function getApiHost(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/v1\/?$/, '');
  }
}

/**
 * Route a user message through the assistant LLM.
 *
 * @param {string} userMessage - The raw user message
 * @param {object} envContext - Project environment context from env-context.js
 * @param {object} opts
 * @param {string|null} opts.conversationId - Existing conversation ID for multi-turn
 * @returns {{ action, message, task?, rules?, snippets?, conversationId }}
 */
export async function routeMessage(userMessage, envContext, { conversationId = null } = {}) {
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

  const apiHost = getApiHost(creds.baseUrl);
  const url = `${apiHost}/chat/agent`;

  const enrichedMessage = buildRouterMessage(userMessage, envContext);

  const body = {
    messages: [{ role: 'user', content: enrichedMessage }],
    assistant_id: assistantId,
    stream: false,
    buffer_length: 10,
    hidden: true,       // hide from platform UI — these are automated routing calls
    tool_keys: [],      // no tools needed for routing
  };

  if (conversationId) {
    body.conversation_id = conversationId;
  }

  console.log('[router] Calling assistant: host=%s assistant=%s conversation=%s',
    apiHost, assistantId, conversationId || 'new');

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

  const data = await res.json();

  // Extract response content — handle OpenAI format and platform-specific format
  const content =
    data.choices?.[0]?.message?.content ||
    data.message?.content ||
    data.content ||
    '';

  // Extract conversation_id from response for multi-turn continuity
  const responseConversationId =
    data.conversation_id ||
    data.metadata?.conversation_id ||
    conversationId;

  console.log('[router] Response in %dms: conversation=%s action-hint=%s',
    Date.now() - startTime,
    responseConversationId,
    content.slice(0, 30));

  // Parse the assistant's JSON response
  try {
    // Handle markdown code blocks wrapping JSON (common LLM behavior)
    const cleaned = content
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    return {
      action: parsed.action || 'clarify',
      message: parsed.message || '',
      task: parsed.task || '',
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],
      conversationId: responseConversationId,
    };
  } catch (err) {
    console.warn('[router] Failed to parse response as JSON: %s — treating as clarification', err.message);
    return {
      action: 'clarify',
      message: content,
      conversationId: responseConversationId,
    };
  }
}

/**
 * Build the message sent to the router assistant.
 * Prepends project context so the assistant can make informed routing decisions
 * without needing to query the environment itself.
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
