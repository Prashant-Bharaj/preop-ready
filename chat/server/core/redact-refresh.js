import { getCredentials } from './auth.js';
import { setSensitiveStrings } from '../util/redact.js';
import { listAppSecretValues } from './app-secrets-scaffold.js';
import { WORKSPACE_DIR } from './paths.js';

/**
 * Re-seed the redaction set from the MGA API key + every set app-secret value,
 * so subagent output containing a secret is masked to [REDACTED] before it
 * reaches transcripts / logs / notes. Called after a secret is set/cleared.
 *
 * Lives in this tiny leaf module (rather than session/routes.js) so the
 * app-secrets route can import it without pulling in the whole session-routes
 * graph (avoids a circular import).
 */
export function refreshSensitiveStrings() {
  const creds = getCredentials();
  const apiKey = creds?.apiKey;
  setSensitiveStrings([apiKey, ...listAppSecretValues(WORKSPACE_DIR)].filter(Boolean));
}
