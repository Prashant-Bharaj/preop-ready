---
description: "Required security: nginx headers, non-root containers, input validation, parameterized SQL, JSON errors, logging restrictions"
triggers: []
globs: []
---

# Security Requirements

Security is NOT optional. ALL generated code must follow these rules.

## nginx Security Headers (every nginx.conf AND nginx.local.conf)

```nginx
server_tokens off;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
```

The `always` keyword is REQUIRED — without it, headers are missing on 4xx/5xx responses.

## Non-Root Containers (every Dockerfile)

Every Dockerfile must create and switch to a non-root user. The template Dockerfiles
(`frontend/Dockerfile.react`, `backend/Dockerfile.node`, etc.) already do this — copy them,
don't hand-roll. The pattern:

- Node: `RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup` … `USER appuser`
- Python: `RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup appuser` … `USER appuser`

Use `COPY --chown=appuser:appgroup . .` so the app files are readable after the switch.

## User Identity — Only From Verified ALB Headers

Identity comes ONLY from the `x-amzn-oidc-data` header, and only after verification —
copy `snippets/auth/user-identity.*`, which checks the JWT's ES256 signature against the
ALB's regional public key and its expiry. Never derive identity from custom headers, body
fields, query params, or the bare `x-amzn-oidc-identity` header. A present-but-invalid
token = 401 — never the local-dev fallback. Sockets follow the same rule
(`snippets/realtime/websocket-helper.*`).

## Server-Side Input Validation (every endpoint)

NEVER trust client input. Validate on the backend even if the frontend validates too:

- Express: express-validator or the shared sanitize middleware; validate `:id` params as
  positive integers, whitelist query param values, enforce max lengths, check required fields.
- FastAPI: Pydantic models with types and constraints (`Field(max_length=...)`, enums).

Use `snippets/security/input-validation.*` — apply sanitization middleware BEFORE routes.

## Parameterized SQL ONLY

```javascript
// ❌ NEVER — SQL injection
pool.query(`SELECT * FROM users WHERE id = ${userId}`);
// ✅ ALWAYS — parameterized
pool.query('SELECT * FROM users WHERE id = $1', [userId]);
```

No string concatenation, template literals, or f-strings in queries — in any language
(pg `$1`, mysql2 `?`, SQLAlchemy `:name` or ORM). See `snippets/security/parameterized-queries.*`.

## JSON Error Responses (every API endpoint)

Return descriptive JSON with the right HTTP status — never plain text, never stack traces:

```json
{ "error": "NOT_FOUND", "message": "User with ID 42 was not found", "statusCode": 404 }
```

- 400 invalid input · 401 unauthenticated · 403 forbidden · 404 not found · 409 conflict ·
  422 failed business rules · 429 rate limited · 500 unexpected
- 4xx: specific message helping the client fix the request. 500: generic
  "An unexpected error occurred" — log the full error server-side only.
- Add a global error handler AFTER all routes. Never return `err.message`, `err.stack`,
  internal paths, or library versions to clients.

Use `snippets/security/error-handler.js` / `error-handler.py`.

## Never Log Secrets, Tokens, PII, or Payloads

⛔ Forbidden: `console.log(req.body)`, `console.log(req.headers)`, `console.log(req.file)`,
logging API keys, auth headers, emails, names, or any request/response payload.
Logs land in CloudWatch and are visible to platform admins.

Safe: log method + path, userId, filename + size — and redact anything sensitive
(`password: '[REDACTED]'`). Remove any temporary debug logging before committing;
the pre-commit hook warns on dangerous patterns.

Implementations to copy: `snippets/security/` (sanitize-middleware, input-validation, parameterized-queries, error-handler).
