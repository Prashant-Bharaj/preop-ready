/**
 * Smart Middleware Layer — entry point.
 *
 * Initializes environment context and exports all middleware functions.
 * The embedding-based context selector has been replaced by the LLM
 * assistant router (router.js) which uses the corp LLM platform's
 * /chat/agent endpoint for intelligent message routing.
 */

export { gatherEnvContext, refreshEnvContext, getCachedEnvContext } from './env-context.js';
export { buildBootstrapPrompt, buildPromptFromSpec } from './prompt-builder.js';
export { verifyAppHealth, buildErrorPrompt, shouldVerify, canRetry } from './response-verifier.js';
export { routeMessage } from './router.js';

import { gatherEnvContext } from './env-context.js';

/**
 * Initialize middleware components. Call once at server startup.
 * Gathers initial environment context (project state, structure, etc.).
 */
export async function initMiddleware() {
  console.log('[middleware] Initializing...');
  const startTime = Date.now();

  try {
    await gatherEnvContext();
    console.log('[middleware] Ready (%dms)', Date.now() - startTime);
  } catch (err) {
    console.error('[middleware] Initialization error (non-fatal):', err.message);
  }
}
