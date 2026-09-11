/**
 * Single source of truth for "this workspace path holds a credential/secret and
 * must never be served over HTTP or handed to an agent read tool."
 *
 * The harness keeps its live Bayer MGA / OpenAI-compat key in
 * `<WORKSPACE_DIR>/.chat/secrets.json` (see core/paths.js), and app builds may
 * write `MGA_API_KEY=` into a workspace `.env`. Both live INSIDE the workspace,
 * so plain workspace-containment checks pass them through. Every read surface
 * (routes/uploads.js `/api/workspace-file`, agent `read_file`) funnels through
 * `isSensitiveWorkspacePath` so the deny rules can never drift apart.
 */

// Directory names, anywhere in a workspace-relative path, that hold local
// credentials / VCS internals / cloud creds and must never be read out.
const SENSITIVE_DIR_SEGMENTS = new Set([
  '.chat', '.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker',
]);

// Sensitive basenames (credentials, keys, secret stores, env files). Matched
// case-insensitively against the final path segment. Mirrors — and extends —
// the upload blocklist in routes/uploads.js (adds secrets.json + .env*).
// The `(\.[a-z0-9]+)*` tails deliberately also catch backup copies like
// `secrets.json.bak`. NOTE (intentional over-block): an app the user is
// building that legitimately ships a file literally named `secrets.json` or an
// `.env*` can't be previewed via /api/workspace-file or read by the agent's
// read_file — it is still writable and deploys normally; only preview/agent-read
// are denied. That trade-off favours never leaking a real credential.
const SENSITIVE_NAME_PATTERNS = [
  /^\.env(\..+)?$/,                   // .env, .env.local, .env.production
  /^secrets?(\.[a-z0-9]+)*$/,         // secret, secrets, secrets.json, secrets.json.bak
  /^\.npmrc$/,                        // may hold an _authToken
  /^\.netrc$/,                        // machine/login/password
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
  /\.(cert|crt|cer)$/,
  /\.secret$/,
  /^credentials(\.[a-z0-9]+)?$/,
  /^service-account.*\.json$/,
  /^id_rsa($|\.pub$)/,
  /^id_ed25519($|\.pub$)/,
];

/**
 * @param {string} relPath - a workspace-relative path (POSIX or Windows style).
 * @returns {boolean} true when the path is a protected secret/credential.
 */
export function isSensitiveWorkspacePath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  const segments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const seg of segments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  const base = (segments[segments.length - 1] || '').toLowerCase();
  return SENSITIVE_NAME_PATTERNS.some((re) => re.test(base));
}
