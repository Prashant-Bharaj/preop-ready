/**
 * SNIPPET: Bayer MGA Assistants API Client
 * CATEGORY: AI / LLM
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Client for Bayer's MGA platform using the OpenAI Assistants API.
 *   Creates threads, sends messages, runs assistants, and polls for results.
 *   Falls back to mock responses when credentials are not configured (local dev).
 *
 * DEPENDENCIES:
 *   npm install axios
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL (e.g. https://your-mga.com/v1)
 *   APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
 *
 *   For local development, set these directly or use descriptive names:
 *     LLM_ENDPOINT, LLM_API_KEY
 *
 *   MGA_ASSISTANT_ID  ->  Default assistant ID (can be overridden per call
 *                         or stored in DB via app-settings for runtime changes)
 *
 * USAGE:
 *   const { askAssistant, testAssistantConnection } = require('./mga-assistant-client');
 *
 *   // Simple call (uses MGA_ASSISTANT_ID from env or app-settings)
 *   const answer = await askAssistant('What are the side effects of aspirin?');
 *
 *   // With specific assistant
 *   const answer = await askAssistant('Summarize this document...', {
 *     assistantId: 'asst_abc123',
 *   });
 *
 *   // Continue a conversation
 *   const answer = await askAssistant('Follow up question...', {
 *     threadId: 'thread_xyz789',
 *   });
 *
 * EXAMPLE EXPRESS ROUTE:
 *   app.post('/ask-assistant', async (req, res) => {
 *     try {
 *       const { question, threadId } = req.body;
 *       const answer = await askAssistant(question, { threadId });
 *       res.json({ success: true, answer });
 *     } catch (error) {
 *       res.status(500).json({ success: false, error: error.message });
 *     }
 *   });
 *
 * RELATED:
 *   - snippets/llm/bayer-llm-client.js (direct chat completions)
 *   - snippets/config/app-settings.js (runtime config for assistant ID)
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// Configuration (reads from environment variables)
// ---------------------------------------------------------------------------
const MGA_CONFIG = {
  // Production: APP_SECRET_1 -> SECRET_1, Local: LLM_ENDPOINT
  endpoint: process.env.SECRET_1 || process.env.LLM_ENDPOINT,
  // Production: APP_API_KEY -> API_KEY, Local: LLM_API_KEY
  apiKey: process.env.API_KEY || process.env.LLM_API_KEY,
  // Default assistant ID (can be overridden per call or via app-settings DB)
  assistantId: process.env.MGA_ASSISTANT_ID,
};

/**
 * Build axios instance with auth headers.
 * @returns {import('axios').AxiosInstance}
 */
function createClient() {
  return axios.create({
    baseURL: MGA_CONFIG.endpoint,
    headers: {
      'Authorization': `Bearer ${MGA_CONFIG.apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    },
    timeout: 120000,
  });
}

// ---------------------------------------------------------------------------
// Mock fallback for local dev
// ---------------------------------------------------------------------------

function isMockMode() {
  return !MGA_CONFIG.endpoint || !MGA_CONFIG.apiKey;
}

function mockResponse(type) {
  const mockThread = { id: 'thread_mock_' + Date.now(), object: 'thread', created_at: Date.now() };
  const mockMessage = {
    id: 'msg_mock_' + Date.now(),
    object: 'thread.message',
    role: 'assistant',
    content: [{ type: 'text', text: { value: 'Mock response: MGA is not configured. Set SECRET_1 (endpoint) and API_KEY.' } }],
  };
  const mockRun = { id: 'run_mock_' + Date.now(), object: 'thread.run', status: 'completed' };

  switch (type) {
    case 'thread': return mockThread;
    case 'message': return mockMessage;
    case 'run': return mockRun;
    case 'messages': return [mockMessage];
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Create a new thread.
 * @returns {Promise<object>} Thread object with id
 */
async function createThread() {
  if (isMockMode()) {
    console.warn('[MGA] No endpoint/API key configured, using mock response');
    return mockResponse('thread');
  }

  try {
    const client = createClient();
    const response = await client.post('/threads');
    return response.data;
  } catch (error) {
    console.error('[MGA] Failed to create thread:', error.response?.data || error.message);
    throw new Error(`MGA: Failed to create thread: ${error.message}`);
  }
}

/**
 * Add a user message to a thread.
 * @param {string} threadId - Thread ID
 * @param {string} content - Message content
 * @returns {Promise<object>} Message object
 */
async function addMessage(threadId, content) {
  if (isMockMode()) {
    console.warn('[MGA] No endpoint/API key configured, using mock response');
    return mockResponse('message');
  }

  try {
    const client = createClient();
    const response = await client.post(`/threads/${threadId}/messages`, {
      role: 'user',
      content: content,
    });
    return response.data;
  } catch (error) {
    console.error('[MGA] Failed to add message:', error.response?.data || error.message);
    throw new Error(`MGA: Failed to add message: ${error.message}`);
  }
}

/**
 * Create a run on a thread with the specified assistant.
 * @param {string} threadId - Thread ID
 * @param {string} assistantId - Assistant ID
 * @returns {Promise<object>} Run object
 */
async function createRun(threadId, assistantId) {
  if (isMockMode()) {
    console.warn('[MGA] No endpoint/API key configured, using mock response');
    return mockResponse('run');
  }

  try {
    const client = createClient();
    const response = await client.post(`/threads/${threadId}/runs`, {
      assistant_id: assistantId,
    });
    return response.data;
  } catch (error) {
    console.error('[MGA] Failed to create run:', error.response?.data || error.message);
    throw new Error(`MGA: Failed to create run: ${error.message}`);
  }
}

/**
 * Poll a run until it reaches a terminal status.
 * Uses exponential backoff starting at 1s, max 5s between polls.
 *
 * @param {string} threadId - Thread ID
 * @param {string} runId - Run ID
 * @param {object} [options]
 * @param {number} [options.maxWait=120000] - Maximum wait time in ms (default 120s)
 * @param {number} [options.interval=1000] - Initial polling interval in ms
 * @returns {Promise<object>} Completed run object
 */
async function pollRunStatus(threadId, runId, options = {}) {
  if (isMockMode()) {
    return mockResponse('run');
  }

  const maxWait = options.maxWait || 120000;
  const initialInterval = options.interval || 1000;
  const maxInterval = 5000;
  const terminalStatuses = ['completed', 'failed', 'cancelled', 'expired'];

  const client = createClient();
  const startTime = Date.now();
  let interval = initialInterval;

  while (Date.now() - startTime < maxWait) {
    try {
      const response = await client.get(`/threads/${threadId}/runs/${runId}`);
      const run = response.data;

      if (terminalStatuses.includes(run.status)) {
        if (run.status !== 'completed') {
          console.warn(`[MGA] Run ended with status: ${run.status}`, run.last_error || '');
        }
        return run;
      }

      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 1.5, maxInterval);
    } catch (error) {
      console.error('[MGA] Failed to poll run status:', error.response?.data || error.message);
      throw new Error(`MGA: Failed to poll run status: ${error.message}`);
    }
  }

  throw new Error(`MGA: Run timed out after ${maxWait / 1000}s (run: ${runId})`);
}

/**
 * Get messages from a thread (newest first).
 * @param {string} threadId - Thread ID
 * @returns {Promise<object[]>} Array of message objects
 */
async function getMessages(threadId) {
  if (isMockMode()) {
    console.warn('[MGA] No endpoint/API key configured, using mock response');
    return mockResponse('messages');
  }

  try {
    const client = createClient();
    const response = await client.get(`/threads/${threadId}/messages`);
    return response.data.data || response.data;
  } catch (error) {
    console.error('[MGA] Failed to get messages:', error.response?.data || error.message);
    throw new Error(`MGA: Failed to get messages: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// High-level convenience function
// ---------------------------------------------------------------------------

/**
 * Ask an assistant a question. Creates a thread (or reuses one),
 * sends the message, runs the assistant, polls for completion,
 * and returns the assistant's response text.
 *
 * @param {string} question - The question to ask
 * @param {object} [options]
 * @param {string} [options.assistantId] - Override assistant ID (default: MGA_ASSISTANT_ID env var)
 * @param {string} [options.threadId] - Existing thread ID to continue a conversation
 * @returns {Promise<string>} Assistant's response text
 */
async function askAssistant(question, options = {}) {
  const assistantId = options.assistantId || MGA_CONFIG.assistantId;
  if (!assistantId && !isMockMode()) {
    throw new Error('MGA: No assistant ID configured. Set MGA_ASSISTANT_ID env var or pass assistantId option.');
  }

  // Create or reuse thread
  let threadId = options.threadId;
  if (!threadId) {
    const thread = await createThread();
    threadId = thread.id;
  }

  // Add user message
  await addMessage(threadId, question);

  // Create and poll run
  const run = await createRun(threadId, assistantId);
  const completedRun = await pollRunStatus(threadId, run.id);

  if (completedRun.status !== 'completed') {
    throw new Error(`MGA: Run failed with status: ${completedRun.status} - ${completedRun.last_error?.message || 'Unknown error'}`);
  }

  // Get the assistant's response (newest message first)
  const messages = await getMessages(threadId);
  const assistantMessage = messages.find((m) => m.role === 'assistant');

  if (!assistantMessage) {
    throw new Error('MGA: No assistant response found in thread');
  }

  // Extract text from content array
  const textContent = assistantMessage.content.find((c) => c.type === 'text');
  return textContent ? textContent.text.value : '';
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/**
 * Test the MGA assistant connection. Verifies endpoint, auth, and assistant ID.
 * @returns {Promise<object>} { success, message, config }
 */
async function testAssistantConnection() {
  if (!MGA_CONFIG.endpoint || !MGA_CONFIG.apiKey) {
    return {
      success: false,
      message: 'MGA not configured',
      config: {
        endpoint: !!MGA_CONFIG.endpoint,
        apiKey: !!MGA_CONFIG.apiKey,
        assistantId: MGA_CONFIG.assistantId || null,
      },
    };
  }

  if (!MGA_CONFIG.assistantId) {
    return {
      success: false,
      message: 'MGA_ASSISTANT_ID not set',
      config: {
        endpoint: true,
        apiKey: true,
        assistantId: null,
      },
    };
  }

  const startTime = Date.now();
  try {
    // Verify by creating a thread (lightweight operation)
    const client = createClient();
    const response = await client.post('/threads');

    return {
      success: true,
      message: 'MGA connection successful',
      responseTime: Date.now() - startTime,
      assistantId: MGA_CONFIG.assistantId,
      threadId: response.data.id,
    };
  } catch (error) {
    return {
      success: false,
      message: `MGA connection failed: ${error.response?.status || ''} ${error.message}`,
      responseTime: Date.now() - startTime,
      assistantId: MGA_CONFIG.assistantId,
    };
  }
}

module.exports = {
  createThread,
  addMessage,
  createRun,
  pollRunStatus,
  getMessages,
  askAssistant,
  testAssistantConnection,
  MGA_CONFIG,
};
