/**
 * SNIPPET: Session Expiration Handler (AWS ALB OIDC)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (Frontend)
 * STATUS: ✅ Ready
 *
 * DESCRIPTION:
 *   Detects when the AWS ALB OIDC session expires (1-hour timeout) and
 *   redirects the user to re-authenticate. Without this, fetch() calls
 *   fail silently when the session expires — the ALB returns a 302 redirect
 *   to EntraID, but fetch() can't follow cross-origin redirects, so the
 *   user sees a broken app with no re-auth prompt.
 *
 * HOW IT WORKS:
 *   1. Uses fetch() with redirect: 'manual' to detect opaque redirects
 *   2. When ALB session expires, response.type === 'opaqueredirect'
 *   3. Reloads the page, which triggers a fresh ALB OIDC authentication flow
 *
 * USAGE:
 *   // Replace fetch() with apiFetch() in your frontend code:
 *   import { apiFetch } from './auth/token-refresh';
 *
 *   const response = await apiFetch('/api/users');
 *   const data = await response.json();
 *
 * WEBSOCKET NOTE:
 *   For WebSocket/Socket.IO connections, the connection will drop when the
 *   session expires. Implement reconnect logic with a page reload fallback:
 *
 *   socket.on('disconnect', () => {
 *     setTimeout(() => {
 *       if (!socket.connected) window.location.reload();
 *     }, 5000);
 *   });
 */

/**
 * Fetch wrapper that detects expired ALB OIDC sessions.
 * Drop-in replacement for fetch() — same API, same return type.
 *
 * @param {string} url - The URL to fetch
 * @param {RequestInit} options - Fetch options (same as native fetch)
 * @returns {Promise<Response>} The fetch response
 */
async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual', // Detect redirects instead of following them
  });

  // ALB session expired — redirecting to re-authenticate
  if (
    response.type === 'opaqueredirect' ||
    response.status === 302 ||
    response.status === 401
  ) {
    console.warn('Session expired — redirecting to re-authenticate');
    window.location.reload();
    // Return a never-resolving promise to prevent callers from processing stale data
    return new Promise(() => {});
  }

  return response;
}

// ES Module export (for Vite/React projects)
// export { apiFetch };

// CommonJS export (for vanilla JS or Node-based bundlers)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { apiFetch };
}
