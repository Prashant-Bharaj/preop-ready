---
description: "Show the logged-in user, store per-user data, add roles/admin access, or fix silent failures after the 1-hour session expires"
triggers: ["login", "logged-in user", "who is the user", "my name", "per-user data", "roles", "admin", "session expired"]
globs: []
---

# User Identity (ALB OIDC)

**AWS ALB authenticates users via Azure AD automatically. No login page, no auth code — identity arrives as HTTP headers.**

Use for: "show my name", "save my preferences", "each user has their own data", "personalized dashboard", "track who did what".

## How It Works

```
User visits app → ALB checks Azure AD login → ALB injects OIDC headers → backend reads headers
```

| Header | Content |
|--------|---------|
| `x-amzn-oidc-data` | JWT containing user claims (sub, email, name, ...) — the ONLY identity source, after verification |
| `x-amzn-oidc-identity` | User's unique subject ID (informational; never trust on its own) |
| `x-amzn-oidc-accesstoken` | The OIDC access token |

**Trust model:** the ALB overwrites `x-amzn-oidc-*` headers at the edge (clients cannot
inject them through the front door), and per-project security groups keep backends
unreachable except via the platform router. The snippet ADDS defense in depth: it verifies
the JWT's ES256 signature against the ALB's regional public key
(`https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`, cached) and the `exp` claim.
A present-but-invalid token is rejected with 401 — never the local-dev fallback.

**A MISSING header must also be a 401 in production.** The user-facing ALB is not the only
way in: a second ingress path (API Gateway with an API-key authorizer -> VPC Link -> NLB ->
the machine-to-machine ALB, which has NO `authenticate-oidc` action -> Traefik) reaches the
same backend carrying no OIDC headers at all. If "no header" meant "local developer", that
path would be served as a logged-in user. The snippets therefore return null/None/`None`
when the header is absent, and the local-dev fallback is behind an explicit opt-in:

```
ALLOW_LOCAL_DEV_IDENTITY=true    # docker-compose / local .env ONLY
```

Never set it in a GitHub secret or anywhere that reaches a deployed task definition.

## Implementation: COPY the snippet — do not write from scratch

Copy the middleware for the backend's language into the project and wire it in:

| Stack | Snippet |
|-------|---------|
| Node.js/Express | `snippets/auth/user-identity.ts` |
| Python (FastAPI) | `snippets/auth/user-identity.py` |
| Rust (Actix-web) | `snippets/auth/user-identity.rs` |

After the middleware, handlers read `req.user` (JS) / injected `user` dict (Python) with `userId`, `email`, `name`, `givenName`, `familyName`.

For user-specific tables, use the ready schema: `snippets/auth/user-identity-schema.sql` (`user_id VARCHAR(255) UNIQUE` + index; store the `sub` claim in it).

## JWT Payload Fields (`x-amzn-oidc-data`, decoded)

| Field | Description |
|-------|-------------|
| `sub` | Unique user ID — **stable across sessions, safe as primary key** |
| `name` | Full display name |
| `given_name` / `family_name` | First / last name |
| `email` | User's email address |
| `picture` | Profile picture URL |
| `exp` | Token expiration time |

## Key Facts

- **Headers exist ONLY in production.** Local dev has no ALB. Set `ALLOW_LOCAL_DEV_IDENTITY=true` in `docker-compose.yml` (or the local `.env`) so the middleware returns the `local-dev-user`. Without that opt-in a header-less request is a 401 — which is exactly what production needs.
- **`sub` is the stable identifier** — use it as the `user_id` column value / primary key.
- **Never trust client-sent identity.** Identity comes from ALB headers server-side only; ignore any user id/email a frontend request body claims.
- The JWT is visible in browser dev tools — keep sensitive operations server-side.
- Verifying in production? A temporary `/debug/headers` endpoint that echoes decoded OIDC data works — **remove it after testing** (it exposes user data).

## ⏰ 1-Hour Session Expiry

ALB OIDC sessions expire after **1 hour** (absolute, not idle). Symptoms: app works, then buttons/data silently stop after ~1 hour; `fetch()` calls fail with no prompt (browsers can't follow the ALB's cross-origin 302 to EntraID). Full page loads re-authenticate fine.

**Rule: wrap ALL API fetches with `apiFetch()`** — copy `snippets/auth/token-refresh.ts`. It sends `redirect: 'manual'` and reloads the page on `opaqueredirect`/302/401 so the ALB re-authenticates. Replace every `fetch('/api/...')` with `apiFetch('/api/...')`.

**WebSocket/Socket.IO:** connections drop on expiry. Reconnect with reload fallback:

```javascript
socket.on('disconnect', () => {
  setTimeout(() => { if (!socket.connected) window.location.reload(); }, 5000);
});
```

Backend needs NO session-expiry handling — it's purely a frontend concern. Local dev is unaffected.

**Verify the refresh handling before calling identity done** (not optional):

1. `grep -rn "fetch(" frontend/ | grep -v apiFetch` — every API call must go through `apiFetch()`;
   a single bare `fetch('/api/...')` reintroduces the silent 1-hour failure.
2. Confirm `apiFetch` sends `redirect: 'manual'` and reloads on `opaqueredirect`/302/401
   (that IS the "automatic token refresh" here — the reload lets the ALB re-authenticate;
   there is no silent background refresh with ALB OIDC).
3. Simulate expiry locally: temporarily make the backend return 401 for one request and
   check the page reloads instead of failing silently.
4. If WebSockets are used, confirm the reconnect-with-reload fallback is wired.

## Roles, Admin & Whitelisting

Don't build RBAC from scratch — copy:

| Need | Snippet |
|------|---------|
| Role-based access (user/expert/admin) + approval workflow, JS | `snippets/auth/user-roles.ts` + `snippets/auth/user-roles-schema.sql` |
| Same for FastAPI | `snippets/auth/user-roles.py` (same SQL schema) |
| Admin page to approve/deny users, manage roles | `snippets/auth/UserManagement.tsx` |

## How to Communicate

"The platform already knows who's logged in — I'll add user identity to your backend. It shows your name, keeps each user's data separate, works automatically in production, and uses a test user locally. No login page needed!"
