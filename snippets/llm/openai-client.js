/**
 * SNIPPET: OpenAI Client Wrapper
 * CATEGORY: LLM / AI Integration
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: 🔜 TODO - Placeholder
 * 
 * DESCRIPTION: 
 *   Simple wrapper for OpenAI API with error handling and retries.
 *   Use APP_OPENAI_KEY in GitHub secrets for the API key.
 * 
 * DEPENDENCIES: 
 *   npm install openai
 * 
 * ENVIRONMENT VARIABLES:
 *   - OPENAI_KEY (set via APP_OPENAI_KEY in GitHub secrets)
 * 
 * USAGE:
 *   const ai = require('./openai-client');
 *   const response = await ai.complete('Explain quantum computing');
 * 
 * EXAMPLE:
 *   const ai = require('./openai-client');
 *   
 *   // NOTE: Route is '/ask', NOT '/api/ask'
 *   // Frontend calls fetch('/api/ask') → Traefik strips /api → Backend receives '/ask'
 *   app.post('/ask', async (req, res) => {
 *     const { question } = req.body;
 *     const answer = await ai.complete(question);
 *     res.json({ answer });
 *   });
 */

// TODO: Implement OpenAI client wrapper

const OPENAI_KEY = process.env.OPENAI_KEY;

/**
 * Send a completion request to OpenAI
 * @param {string} prompt - The prompt to send
 * @param {object} options - Optional parameters (model, temperature, etc.)
 * @returns {Promise<string>} - The AI response
 */
async function complete(prompt, options = {}) {
  // TODO: Implement with error handling and retries
  throw new Error('OpenAI client not yet implemented. Add your implementation here.');
}

/**
 * Send a chat completion request (multi-turn)
 * @param {Array} messages - Array of {role, content} messages
 * @param {object} options - Optional parameters
 * @returns {Promise<string>} - The AI response
 */
async function chat(messages, options = {}) {
  // TODO: Implement with error handling and retries
  throw new Error('OpenAI client not yet implemented. Add your implementation here.');
}

module.exports = { complete, chat };
