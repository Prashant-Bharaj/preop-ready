/**
 * scopes: [backend]
 * flags: [has-users, has-admin, ai-chat]
 * description: Express middleware (TypeScript) — extract user identity from ALB OIDC headers with local-dev fallback.
 *
 * SNIPPET: User Identity Middleware (AWS ALB OIDC)
 * CATEGORY: Authentication
 * LANGUAGE: TypeScript (Express)
 * STATUS: Ready
 *
 * Extracts user identity from AWS ALB OIDC headers.
 * Works automatically in production (Azure AD via ALB).
 * Falls back to test user for local development.
 *
 * DEPENDENCIES:
 *   None - uses built-in Node.js modules + Express types
 *
 * HEADERS AVAILABLE:
 *   - x-amzn-oidc-data: JWT with user claims (sub, email, name)
 *   - x-amzn-oidc-identity: User's unique subject ID
 *   - x-amzn-oidc-accesstoken: OIDC access token
 *
 * SESSION EXPIRATION:
 *   The ALB OIDC session expires after 1 hour (absolute timeout).
 *   For frontend session handling, see snippets/auth/token-refresh.ts
 *   which provides a fetch wrapper that auto-redirects on expiry.
 *
 * USAGE:
 *   import { userIdentityMiddleware } from './middleware/user-identity.js';
 *   app.use(userIdentityMiddleware);
 *
 *   // Then in any route:
 *   app.get('/profile', (req, res) => {
 *     res.json({ name: req.user.name, email: req.user.email });
 *   });
 */

import type { Request, Response, NextFunction } from 'express';

export interface UserIdentity {
  userId: string;
  email: string | null;
  name: string | null;
  givenName?: string | null;
  familyName?: string | null;
  picture?: string | null;
  isLocalDev: boolean;
}

// Augment Express Request with the typed `user` field added by the middleware.
declare module 'express-serve-static-core' {
  interface Request {
    user?: UserIdentity;
  }
}

/**
 * Extract user identity from AWS ALB OIDC headers.
 */
export function extractUserIdentity(req: Request): UserIdentity {
  const oidcData = req.headers['x-amzn-oidc-data'];
  const oidcIdentity = req.headers['x-amzn-oidc-identity'];

  // Try to decode the JWT from x-amzn-oidc-data header
  if (typeof oidcData === 'string') {
    try {
      // JWT structure: header.payload.signature
      // We only need the payload (middle part)
      const parts = oidcData.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf8')
        ) as {
          sub?: string;
          email?: string;
          name?: string;
          given_name?: string;
          family_name?: string;
          picture?: string;
        };
        return {
          userId: payload.sub || String(oidcIdentity || ''),
          email: payload.email ?? null,
          name: payload.name ?? null,
          givenName: payload.given_name ?? null,
          familyName: payload.family_name ?? null,
          picture: payload.picture ?? null,
          isLocalDev: false,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to decode OIDC data:', message);
    }
  }

  // Fallback: use identity header if JWT decode failed
  if (typeof oidcIdentity === 'string' && oidcIdentity) {
    return {
      userId: oidcIdentity,
      email: null,
      name: null,
      isLocalDev: false,
    };
  }

  // Fallback for local development (no ALB headers)
  return {
    userId: 'local-dev-user',
    email: 'dev@localhost',
    name: 'Local Developer',
    givenName: 'Local',
    familyName: 'Developer',
    isLocalDev: true,
  };
}

/**
 * Express middleware to attach user identity to request.
 */
export function userIdentityMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  req.user = extractUserIdentity(req);
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
