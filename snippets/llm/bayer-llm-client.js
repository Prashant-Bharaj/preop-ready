/**
 * SNIPPET: Bayer Internal LLM Client
 * CATEGORY: AI / LLM
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Connects to Bayer's internal LLM platform using the OpenAI-compatible API.
 *   Handles authentication, endpoint resolution, and error handling.
 *   Falls back to mock responses when credentials are not configured (local dev).
 *
 * DEPENDENCIES:
 *   npm install axios
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   APP_SECRET_1  ->  SECRET_1   ->  LLM endpoint URL (e.g. https://your-llm.com/v1)
 *   APP_API_KEY   ->  API_KEY    ->  LLM API key (Bearer token)
 *   APP_SECRET_2  ->  SECRET_2   ->  Model name (e.g. gpt-4)
 *
 *   For local development, set these directly or use descriptive names:
 *     LLM_ENDPOINT, LLM_API_KEY, LLM_MODEL
 *
 * USAGE:
 *   const { callLLM } = require('./llm-client');
 *
 *   // Simple call
 *   const answer = await callLLM('What is the capital of France?');
 *
 *   // With options
 *   const answer = await callLLM('Summarize this text...', {
 *     systemPrompt: 'You are a helpful assistant.',
 *     model: 'gpt-4',
 *     temperature: 0.7,
 *     maxTokens: 500,
 *   });
 *
 * EXAMPLE EXPRESS ROUTE:
 *   app.post('/ask', async (req, res) => {
 *     try {
 *       const { question } = req.body;
 *       const answer = await callLLM(question, {
 *         systemPrompt: 'You are a helpful assistant for our project.',
 *       });
 *       res.json({ success: true, answer });
 *     } catch (error) {
 *       res.status(500).json({ success: false, error: error.message });
 *     }
 *   });
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// Configuration (reads from environment variables)
// ---------------------------------------------------------------------------
const LLM_CONFIG = {
  // Production: APP_SECRET_1 -> SECRET_1, Local: LLM_ENDPOINT
  endpoint: process.env.SECRET_1 || process.env.LLM_ENDPOINT,
  // Production: APP_API_KEY -> API_KEY, Local: LLM_API_KEY
  apiKey: process.env.API_KEY || process.env.LLM_API_KEY,
  // Production: APP_SECRET_2 -> SECRET_2, Local: LLM_MODEL
  model: process.env.SECRET_2 || process.env.LLM_MODEL || 'gpt-4',
  // Tuning
  temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0.1,
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS) || undefined,
};

// ---------------------------------------------------------------------------
// Core LLM function
// ---------------------------------------------------------------------------

/**
 * Call the Bayer internal LLM API (OpenAI-compatible format)
 *
 * @param {string} prompt - The user message to send
 * @param {object} [options] - Additional options
 * @param {string} [options.systemPrompt] - System prompt (default: helpful assistant)
 * @param {string} [options.model] - Model override
 * @param {number} [options.temperature] - Temperature override
 * @param {number} [options.maxTokens] - Max tokens override
 * @param {boolean} [options.skipMock] - If true, throw instead of using mock
 * @returns {Promise<string>} - LLM response text
 */
async function callLLM(prompt, options = {}) {
  const { endpoint, apiKey, model, temperature, maxTokens } = LLM_CONFIG;

  // If not configured, fall back to mock (useful for local dev without credentials)
  if (!endpoint || !apiKey) {
    if (options.skipMock) {
      throw new Error('LLM not configured - set SECRET_1 and API_KEY environment variables');
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

  const body = {
    model: selectedModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: options.temperature || temperature,
  };

  // Only set max_tokens if explicitly configured
  const tokenLimit = options.maxTokens || maxTokens;
  if (tokenLimit) {
    body.max_tokens = tokenLimit;
  }

  try {
    const response = await axios.post(fullEndpoint, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000, // 2 minute timeout
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('[LLM] API call failed:', error.response?.data || error.message);
    throw new Error(`LLM API call failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Connection test (use from an Express route to verify setup)
// ---------------------------------------------------------------------------

/**
 * Test the LLM connection. Returns config status and response time.
 * @returns {Promise<object>} - { success, message, responseTime, model, endpoint }
 */
async function testLLMConnection() {
  if (!LLM_CONFIG.endpoint || !LLM_CONFIG.apiKey) {
    return {
      success: false,
      message: 'LLM not configured',
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
    return {
      success: false,
      message: `LLM connection failed: ${error.message}`,
      responseTime: Date.now() - startTime,
      model: LLM_CONFIG.model,
    };
  }
}

module.exports = { callLLM, testLLMConnection, LLM_CONFIG };
