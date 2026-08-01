# Authentication Snippets

> ⚠️ **Security Note**: Authentication code should be reviewed by security team before production use.

## Available Snippets

| File | Description |
|------|-------------|
| `user-identity.js` | Get logged-in user from OIDC headers (Node.js) |
| `user-identity.py` | Get logged-in user from OIDC headers (Python) |
| `user-identity.rs` | Get logged-in user from OIDC headers (Rust/Actix-web) |

## User Identity (Recommended for Hackathons)

**The platform automatically authenticates users via Azure AD through AWS ALB.**

No authentication code needed! User identity is passed via HTTP headers:
- `x-amzn-oidc-data` - JWT with user claims (sub, email, name) — the only identity source
- `x-amzn-oidc-identity` - User's unique ID (informational; never trusted on its own)

Use the `user-identity.js`, `user-identity.py` or `user-identity.rs` snippets to extract
this info. All three verify the JWT's ES256 signature against the ALB's regional public key.

### A missing header is a 401 in production — not a local dev user

The user-facing ALB is not the only route to the backend. A second ingress path
(API Gateway with an API-key authorizer -> VPC Link -> NLB -> the machine-to-machine
ALB, which has **no** `authenticate-oidc` action -> Traefik) reaches the same backend
with **no OIDC headers at all**. So "header absent" must never be read as "local
developer" — that would serve an unauthenticated caller as a logged-in user.

All three snippets return null/None when `x-amzn-oidc-data` is absent, and the caller
answers 401. The local-dev fallback user is behind an explicit opt-in:

```bash
ALLOW_LOCAL_DEV_IDENTITY=true    # docker-compose / local .env ONLY
```

Production task definitions never set it. Do not add it to a GitHub secret.

See `.platform-rules/reference/user-identity.md` for full documentation.

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
