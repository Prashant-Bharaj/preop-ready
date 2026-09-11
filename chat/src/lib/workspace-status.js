/**
 * workspace-status.js — is the harness server gone, and where does the user
 * go to bring it back? Pure helpers (no DOM) so they are unit-testable.
 *
 * In Codespaces the harness is served through the port proxy
 * `https://<codespace>-5050.app.github.dev`. When the codespace idles out, the
 * socket drops and every request to that host answers with the proxy's own
 * HTML page instead of the API's JSON. That is the signature of "the
 * workspace is asleep"; a plain server restart on localhost looks the same
 * (fetch fails outright).
 */

/** The editor URL that starts the codespace when opened, or null outside Codespaces. */
export function editorUrlFor(hostname) {
  const m = /^([a-z0-9-]+?)-\d+\.(app|preview)\.github\.dev$/i.exec(String(hostname || ''));
  return m ? `https://${m[1]}.github.dev` : null;
}

/**
 * Classify a health probe of the API.
 * @param {{ ok: boolean, contentType?: string } | null} res - null when fetch threw
 * @returns {'online'|'gone'}
 */
export function classifyHealthProbe(res) {
  if (!res) return 'gone';
  if (!res.ok) return 'gone';
  return /application\/json/i.test(String(res.contentType || '')) ? 'online' : 'gone';
}

/** Seconds a disconnect may last before we start probing — reconnects within this are normal. */
export const OFFLINE_GRACE_MS = 15_000;
export const OFFLINE_PROBE_MS = 5_000;
