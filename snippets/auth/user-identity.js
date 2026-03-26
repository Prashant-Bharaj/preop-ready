/**
 * SNIPPET: User Identity Middleware (AWS ALB OIDC)
 * CATEGORY: Authentication
 * LANGUAGE: JavaScript (Express)
 * STATUS: ✅ Ready
 * 
 * DESCRIPTION: 
 *   Extracts user identity from AWS ALB OIDC headers.
 *   Works automatically in production (Azure AD via ALB).
 *   Falls back to test user for local development.
 * 
 * DEPENDENCIES: 
 *   None - uses built-in Node.js modules
 * 
 * HEADERS AVAILABLE:
 *   - x-amzn-oidc-data: JWT with user claims (sub, email, name)
 *   - x-amzn-oidc-identity: User's unique subject ID
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

/**
 * Extract user identity from AWS ALB OIDC headers
 * @param {Request} req - Express request object
 * @returns {Object} User identity object
 */
function extractUserIdentity(req) {
  const oidcData = req.headers['x-amzn-oidc-data'];
  const oidcIdentity = req.headers['x-amzn-oidc-identity'];
  
  // Try to decode the JWT from x-amzn-oidc-data header
  if (oidcData) {
    try {
      // JWT structure: header.payload.signature
      // We only need the payload (middle part)
      const parts = oidcData.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf8')
        );
        return {
          userId: payload.sub || oidcIdentity,
          email: payload.email,
          name: payload.name,
          givenName: payload.given_name,
          familyName: payload.family_name,
          picture: payload.picture,
          isLocalDev: false
        };
      }
    } catch (error) {
      console.error('Failed to decode OIDC data:', error.message);
    }
  }
  
  // Fallback: use identity header if JWT decode failed
  if (oidcIdentity) {
    return { 
      userId: oidcIdentity, 
      email: null, 
      name: null,
      isLocalDev: false
    };
  }
  
  // Fallback for local development (no ALB headers)
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
 * Express middleware to attach user identity to request
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {Function} next - Next middleware function
 */
function userIdentityMiddleware(req, res, next) {
  req.user = extractUserIdentity(req);
  next();
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
  userIdentityMiddleware,
  getUserDisplayName
};
