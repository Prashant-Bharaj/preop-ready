/**
 * SNIPPET: Bayer MGA Assistant Client
 * CATEGORY: AI / LLM
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Connects to a Bayer MGA assistant using the ChatCompletion API.
 *   Same pattern as bayer-llm-client.js but for MGA-hosted assistants.
 *   Falls back to mock responses when credentials are not configured (local dev).
 *
 * DEPENDENCIES:
 *   npm install axios
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL (e.g. https://your-mga.com)
 *   APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
 *   APP_SECRET_2  ->  SECRET_2   ->  Model / assistant ID
 *
 *   For local development, set these directly or use descriptive names:
 *     MGA_ENDPOINT, MGA_API_KEY, MGA_MODEL
 *
 * USAGE:
 *   const { callAssistant } = require('./mga-assistant-client');
 *
 *   // Simple call
 *   const answer = await callAssistant('What are the side effects of aspirin?');
 *
 *   // With conversation history
 *   const answer = await callAssistant('Tell me more', {
 *     messages: [
 *       { role: 'user', content: 'What is aspirin?' },
 *       { role: 'assistant', content: 'Aspirin is a pain reliever...' },
 *       { role: 'user', content: 'Tell me more' },
 *     ],
 *   });
 *
 * EXAMPLE EXPRESS ROUTE:
 *   app.post('/ask-assistant', async (req, res) => {
 *     try {
 *       const { question } = req.body;
 *       const answer = await callAssistant(question);
 *       res.json({ success: true, answer });
 *     } catch (error) {
 *       res.status(500).json({ success: false, error: error.message });
 *     }
 *   });
 *
 * RELATED:
 *   - snippets/llm/bayer-llm-client.js (direct LLM chat completions)
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// Configuration (reads from environment variables)
// ---------------------------------------------------------------------------
const MGA_CONFIG = {
  // Production: APP_SECRET_1 -> SECRET_1, Local: MGA_ENDPOINT
  endpoint: process.env.SECRET_1 || process.env.MGA_ENDPOINT,
  // Production: APP_API_KEY -> API_KEY, Local: MGA_API_KEY
  apiKey: process.env.API_KEY || process.env.MGA_API_KEY,
  // Production: APP_SECRET_2 -> SECRET_2, Local: MGA_MODEL
  model: process.env.SECRET_2 || process.env.MGA_MODEL,
};

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Call an MGA assistant via the ChatCompletion API.
 *
 * @param {string} prompt - The user message to send
 * @param {object} [options] - Additional options
 * @param {string} [options.model] - Model override
 * @param {object[]} [options.messages] - Full message history (overrides prompt)
 * @param {boolean} [options.stream] - Enable streaming (default: false)
 * @param {string} [options.project] - Optional project identifier header
 * @param {boolean} [options.skipMock] - If true, throw instead of using mock
 * @returns {Promise<string>} - Assistant response text
 */
async function callAssistant(prompt, options = {}) {
  const { endpoint, apiKey, model } = MGA_CONFIG;

  // Mock fallback for local dev without credentials
  if (!endpoint || !apiKey) {
    if (options.skipMock) {
      throw new Error('MGA not configured - set SECRET_1 and API_KEY environment variables');
    }
    console.warn('[MGA] No endpoint/API key configured, using mock response');
    return 'Mock response: MGA is not configured. Set SECRET_1 (endpoint) and API_KEY.';
  }

  const selectedModel = options.model || model;
  if (!selectedModel) {
    throw new Error('MGA: No model configured. Set SECRET_2 or MGA_MODEL, or pass model option.');
  }

  // Build messages: use provided history or wrap prompt
  const messages = options.messages || [
    { role: 'user', content: prompt },
  ];

  // Auto-append /chat/completions if not already present
  const fullEndpoint = endpoint.endsWith('/chat/completions')
    ? endpoint
    : `${endpoint}/chat/completions`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (options.project) {
    headers['project'] = options.project;
  }

  try {
    const response = await axios.post(fullEndpoint, {
      model: selectedModel,
      messages,
      stream: options.stream || false,
    }, {
      headers,
      timeout: 120000,
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('[MGA] API call failed:', error.response?.data || error.message);
    throw new Error(`MGA API call failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/**
 * Test the MGA assistant connection.
 * @returns {Promise<object>} - { success, message, responseTime, model }
 */
async function testAssistantConnection() {
  if (!MGA_CONFIG.endpoint || !MGA_CONFIG.apiKey) {
    return {
      success: false,
      message: 'MGA not configured',
      config: {
        endpoint: !!MGA_CONFIG.endpoint,
        apiKey: !!MGA_CONFIG.apiKey,
        model: MGA_CONFIG.model || null,
      },
    };
  }

  const startTime = Date.now();
  try {
    await callAssistant('Respond with exactly one word: "OK"', {
      maxTokens: 10,
      skipMock: true,
    });
    return {
      success: true,
      message: 'MGA connection successful',
      responseTime: Date.now() - startTime,
      model: MGA_CONFIG.model,
    };
  } catch (error) {
    return {
      success: false,
      message: `MGA connection failed: ${error.message}`,
      responseTime: Date.now() - startTime,
      model: MGA_CONFIG.model,
    };
  }
}

module.exports = { callAssistant, testAssistantConnection, MGA_CONFIG };
