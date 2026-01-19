# Authentication Snippets

> ⚠️ **Security Note**: Authentication code should be reviewed by security team before production use.

## Available Snippets

| File | Description | Status |
|------|-------------|--------|
| `bayer-sso.js` | Bayer SSO integration | 🔜 TODO |
| `jwt-handler.js` | JWT token management | 🔜 TODO |
| `basic-auth.js` | Simple username/password | 🔜 TODO |

## For Hackathons

For hackathon projects, consider using simple authentication:
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
