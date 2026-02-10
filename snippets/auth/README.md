# Authentication Snippets

> ⚠️ **Security Note**: Authentication code should be reviewed by security team before production use.

## Available Snippets

| File | Description |
|------|-------------|
| `user-identity.js` | Get logged-in user from OIDC headers (Node.js) |
| `user-identity.py` | Get logged-in user from OIDC headers (Python) |

## User Identity (Recommended for Hackathons)

**The platform automatically authenticates users via Azure AD through AWS ALB.**

No authentication code needed! User identity is passed via HTTP headers:
- `x-amzn-oidc-data` - JWT with user claims (sub, email, name)
- `x-amzn-oidc-identity` - User's unique ID

Use the `user-identity.js` or `user-identity.py` snippets to extract this info.

See `.clinerules/17-user-identity.md` for full documentation.

## For Custom Authentication

For hackathon projects that need custom auth:
- Basic username/password stored in database
- Session-based login

For production apps, use Bayer SSO or OAuth.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret key for JWT signing (use APP_JWT_SECRET) |
| `SESSION_SECRET` | Secret for session encryption |
| `SSO_CLIENT_ID` | Bayer SSO client ID |
| `SSO_CLIENT_SECRET` | Bayer SSO client secret |
