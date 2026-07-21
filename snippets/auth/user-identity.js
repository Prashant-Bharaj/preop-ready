/**
 * SNIPPET: User Identity Middleware (AWS ALB OIDC)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (Express)
 * STATUS: ✅ Ready
 *
 * DESCRIPTION:
 *   Extracts AND VERIFIES user identity from AWS ALB OIDC headers.
 *   Works automatically in production (Azure AD via ALB).
 *   Falls back to test user for local development (no headers present).
 *
 * SECURITY MODEL:
 *   The ALB overwrites x-amzn-oidc-* headers on every request, so a client
 *   cannot inject identity through the front door. This middleware ALSO
 *   cryptographically verifies the token (defense in depth): the JWT's
 *   ES256 signature is checked against the ALB's regional public key
 *   (fetched by key id, cached) and the expiry claim is enforced.
 *   A present-but-invalid token is REJECTED with 401 — it never falls
 *   back to the local dev user.
 *
 * DEPENDENCIES:
 *   None - uses built-in Node.js modules (crypto, global fetch; Node >= 18)
 *
 * HEADERS AVAILABLE:
 *   - x-amzn-oidc-data: JWT with user claims (sub, email, name) — VERIFIED
 *   - x-amzn-oidc-identity: User's unique subject ID (informational only;
 *     never trusted on its own)
 *   - x-amzn-oidc-accesstoken: OIDC access token
 *
 * SESSION EXPIRATION:
 *   The ALB OIDC session expires after 1 hour (absolute timeout).
 *   For frontend session handling, see snippets/auth/token-refresh.js
 *   which provides a fetch wrapper that auto-redirects on expiry.
 *
 * USAGE:
 *   const { userIdentityMiddleware } = require('./middleware/user-identity');
 *   app.use(userIdentityMiddleware);
 *
 *   // Then in any route:
 *   app.get('/profile', (req, res) => {
 *     res.json({ name: req.user.name, email: req.user.email });
 *   });
 *
 * EXAMPLE:
 *   // User object structure:
 *   req.user = {
 *     userId: "MaTuw4CRnE7ZrlnsIntYUe83NiulIOEMYunPdOOHEAM",
 *     email: "john.doe@bayer.com",
 *     name: "John Doe",
 *     givenName: "John",
 *     familyName: "Doe"
 *   }
 */

const crypto = require('crypto');

// ALB public keys, cached per key id. Keys rotate rarely; the cache lives for
// the process lifetime and unknown kids trigger a fresh fetch.
const albKeyCache = new Map();

function base64UrlDecode(segment) {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Fetch (and cache) the ALB's public key for a given key id.
 * Endpoint per AWS docs: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
 */
async function getAlbPublicKey(kid, region) {
  if (albKeyCache.has(kid)) return albKeyCache.get(kid);
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ALB key fetch failed: ${res.status}`);
  const pem = await res.text();
  albKeyCache.set(kid, pem);
  return pem;
}

/**
 * Verify the ALB OIDC JWT: ES256 signature against the regional ALB public
 * key, plus expiry. Returns the verified payload, or null if invalid.
 * @param {string} oidcData - raw x-amzn-oidc-data header value
 * @returns {Promise<Object|null>} verified claims payload, or null
 */
async function verifyOidcToken(oidcData) {
  try {
    const parts = oidcData.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (!header.kid || !region) {
      // No key id or no region to fetch it from -> cannot verify -> reject.
      // (Deployed ECS tasks always have AWS_REGION set.)
      console.error('OIDC verify: missing kid or AWS_REGION');
      return null;
    }

    const pem = await getAlbPublicKey(header.kid, region);
    // ALB signs with ES256; the JOSE signature is raw r||s ('ieee-p1363')
    const valid = crypto.verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: pem, dsaEncoding: 'ieee-p1363' },
      base64UrlDecode(parts[2])
    );
    if (!valid) return null;

    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch (error) {
    console.error('OIDC verify failed:', error.message);
    return null;
  }
}

/**
 * Extract user identity from AWS ALB OIDC headers (with verification).
 * @param {Request} req - Express request object
 * @returns {Promise<Object|null>} User identity object, or null when an
 *   OIDC token was present but INVALID (caller must reject the request)
 */
async function extractUserIdentity(req) {
  const oidcData = req.headers['x-amzn-oidc-data'];

  if (oidcData) {
    const payload = await verifyOidcToken(oidcData);
    if (!payload) return null; // present but invalid -> reject, never fall back
    return {
      userId: payload.sub,
      email: payload.email,
      name: payload.name,
      givenName: payload.given_name,
      familyName: payload.family_name,
      picture: payload.picture,
      isLocalDev: false
    };
  }

  // Local development only (no ALB in front, no OIDC headers at all)
  return {
    userId: 'local-dev-user',
    email: 'dev@localhost',
    name: 'Local Developer',
    givenName: 'Local',
    familyName: 'Developer',
    isLocalDev: true
  };
}

/**
 * Express middleware to attach VERIFIED user identity to the request.
 * Responds 401 when an OIDC token is present but fails verification.
 */
async function userIdentityMiddleware(req, res, next) {
  try {
    const user = await extractUserIdentity(req);
    if (!user) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Identity token could not be verified',
        statusCode: 401
      });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Get user display name (falls back gracefully)
 * @param {Object} user - User object from req.user
 * @returns {string} Display name
 */
function getUserDisplayName(user) {
  if (user.name) return user.name;
  if (user.givenName && user.familyName) {
    return `${user.givenName} ${user.familyName}`;
  }
  if (user.email) return user.email.split('@')[0];
  return 'User';
}

module.exports = {
  extractUserIdentity,
  verifyOidcToken,
  userIdentityMiddleware,
  getUserDisplayName
};
