/**
 * scopes: [backend]
 * flags: [has-users, has-admin, ai-chat]
 * description: Express middleware (TypeScript) — extract AND VERIFY user identity from ALB OIDC headers, with an opt-in local-dev fallback.
 *
 * SNIPPET: User Identity Middleware (AWS ALB OIDC)
 * CATEGORY: Authentication
 * LANGUAGE: TypeScript (Express)
 * STATUS: Ready
 *
 * Extracts AND cryptographically verifies user identity from AWS ALB OIDC
 * headers. Works automatically in production (Azure AD via ALB). Falls back to
 * a test user for local development ONLY when ALLOW_LOCAL_DEV_IDENTITY=true.
 *
 * SECURITY MODEL:
 *   The ALB overwrites x-amzn-oidc-* headers on every request, so a client
 *   cannot inject identity through the front door. This middleware ALSO
 *   cryptographically verifies the token (defense in depth): the JWT's ES256
 *   signature is checked against the ALB's regional public key (fetched by key
 *   id, cached) and the `exp` claim is enforced. A present-but-invalid token is
 *   REJECTED with 401 — it never falls back to the local-dev user, and the raw
 *   x-amzn-oidc-identity header is NEVER trusted on its own (it is spoofable).
 *
 *   A MISSING header is also a 401. The backend can be reachable through a
 *   second ingress that carries no OIDC (machine-to-machine ALB with no
 *   authenticate-oidc action). Treating "no header" as "local developer" would
 *   hand that path a logged-in user, so the local-dev fallback requires an
 *   explicit opt-in:
 *
 *       ALLOW_LOCAL_DEV_IDENTITY=true   # docker-compose / .env, local only
 *
 *   Production task definitions never set it, so a header-less request in
 *   production yields 401.
 *
 * DEPENDENCIES:
 *   None — uses built-in Node.js modules (node:crypto, global fetch on Node 18+).
 *
 * HEADERS AVAILABLE:
 *   - x-amzn-oidc-data: JWT with user claims (sub, email, name) — VERIFIED
 *   - x-amzn-oidc-identity: User's unique subject ID (informational only;
 *     never trusted on its own)
 *   - x-amzn-oidc-accesstoken: OIDC access token
 *
 * SESSION EXPIRATION:
 *   The ALB OIDC session expires after 1 hour (absolute timeout).
 *   For frontend session handling, see snippets/auth/token-refresh.ts
 *   which provides a fetch wrapper that auto-redirects on expiry.
 *
 * USAGE:
 *   import { userIdentityMiddleware } from './middleware/user-identity.js';
 *   app.use(userIdentityMiddleware);   // 401s unverified requests
 *
 *   // Then in any route:
 *   app.get('/profile', (req, res) => {
 *     res.json({ name: req.user!.name, email: req.user!.email });
 *   });
 */

import type { Request, Response, NextFunction } from 'express';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export interface UserIdentity {
  userId: string;
  email: string | null;
  name: string | null;
  givenName?: string | null;
  familyName?: string | null;
  picture?: string | null;
  isLocalDev: boolean;
}

interface OidcPayload {
  sub?: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  exp?: number;
}

// Augment Express Request with the typed `user` field added by the middleware.
declare module 'express-serve-static-core' {
  interface Request {
    user?: UserIdentity;
  }
}

// ALB public keys, cached per key id (keys rotate rarely).
const albKeyCache = new Map<string, string>();

async function getAlbPublicKeyPem(kid: string, region: string): Promise<string> {
  const cached = albKeyCache.get(kid);
  if (cached) return cached;
  // Endpoint per AWS docs: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`ALB key fetch failed: ${res.status}`);
  const pem = await res.text();
  albKeyCache.set(kid, pem);
  return pem;
}

/**
 * Verify the ALB OIDC JWT: ES256 signature against the regional ALB public
 * key, plus expiry. Returns the verified payload, or null if invalid.
 */
export async function verifyOidcToken(oidcData: string): Promise<OidcPayload | null> {
  try {
    const parts = oidcData.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
      kid?: string;
      alg?: string;
    };
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!header.kid || !region) {
      // No key id or no region to fetch it from -> cannot verify -> reject.
      // (Deployed ECS tasks always have AWS_REGION set.)
      console.error('OIDC verify: missing kid or AWS_REGION');
      return null;
    }
    if (header.alg && header.alg !== 'ES256') return null; // ALB signs with ES256

    const pem = await getAlbPublicKeyPem(header.kid, region);
    const key = createPublicKey(pem);

    // The JOSE signature is raw r||s (IEEE P1363) — tell node:crypto so it does
    // not expect DER-encoded ECDSA.
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const ok = cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!ok) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as OidcPayload;
    if (payload.exp && payload.exp * 1000 < Date.now()) return null; // exp is seconds
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('OIDC verify failed:', message);
    return null;
  }
}

/**
 * Extract user identity from AWS ALB OIDC headers (with verification).
 * Returns the user, or null when the token is missing or INVALID — the
 * middleware rejects with 401 in that case.
 */
export async function extractUserIdentity(req: Request): Promise<UserIdentity | null> {
  const oidcData = req.headers['x-amzn-oidc-data'];

  if (typeof oidcData === 'string' && oidcData) {
    const payload = await verifyOidcToken(oidcData);
    if (!payload) return null; // present but invalid -> reject, never fall back
    return {
      userId: payload.sub || '',
      email: payload.email ?? null,
      name: payload.name ?? null,
      givenName: payload.given_name ?? null,
      familyName: payload.family_name ?? null,
      picture: payload.picture ?? null,
      isLocalDev: false,
    };
  }

  // No OIDC header at all. Only a machine that explicitly opted in gets the
  // local-dev user; everywhere else this is an unauthenticated request.
  if (process.env.ALLOW_LOCAL_DEV_IDENTITY === 'true') {
    return {
      userId: 'local-dev-user',
      email: 'dev@localhost',
      name: 'Local Developer',
      givenName: 'Local',
      familyName: 'Developer',
      isLocalDev: true,
    };
  }

  console.error(
    'No x-amzn-oidc-data header — rejecting as unauthenticated. For local ' +
    'development set ALLOW_LOCAL_DEV_IDENTITY=true (never in production).'
  );
  return null;
}

/**
 * Express middleware to attach the VERIFIED user identity to the request.
 * Responds 401 when the OIDC token is missing or fails verification.
 */
export async function userIdentityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = await extractUserIdentity(req);
  if (!user) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Identity token missing or could not be verified',
      statusCode: 401,
    });
    return;
  }
  req.user = user;
  next();
}

/**
 * Get user display name (falls back gracefully).
 */
export function getUserDisplayName(user: UserIdentity): string {
  if (user.name) return user.name;
  if (user.givenName && user.familyName) {
    return `${user.givenName} ${user.familyName}`;
  }
  if (user.email) return user.email.split('@')[0];
  return 'User';
}
