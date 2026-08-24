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
The nginx frontend container additionally needs `curl` (ECS health check) and writable runtime
dirs as non-root — the template Dockerfile handles it (`apk add curl`;
`chown -R appuser:appgroup /var/cache/nginx /var/log/nginx /etc/nginx/conf.d && touch /var/run/nginx.pid`).

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

Cap request body size explicitly — an uncapped parser is a DoS vector:
`app.use(express.json({ limit: '1mb' }));` (Express); FastAPI: reject oversized `Content-Length`.

## Rate Limiting

Add rate-limiting middleware on auth, search, and write endpoints (e.g. `express-rate-limit`,
`slowapi` for FastAPI) to blunt brute-force and DoS.

## Parameterized SQL ONLY

```javascript
// ❌ NEVER — SQL injection
pool.query(`SELECT * FROM users WHERE id = ${userId}`);
// ✅ ALWAYS — parameterized
pool.query('SELECT * FROM users WHERE id = $1', [userId]);
```

No string concatenation, template literals, or f-strings in queries — in any language
(pg `$1`, mysql2 `?`, SQLAlchemy `:name` or ORM). See `snippets/security/parameterized-queries.*`.

- **Paginate all list queries** (`LIMIT`/`OFFSET` or keyset) — never return an unbounded result set.
- Use a **least-privilege DB user** for the app: no DDL or superuser rights in the app's credentials.

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

## A Platform WAF Inspects Every Request Body

All traffic reaches your app through a platform WAF. It inspects request BODIES
(query strings, headers and URLs too) and blocks known attack patterns before your
code ever runs. This affects how you design a few things.

**File uploads must be on a path containing `/upload`.**

```javascript
app.post('/upload', ...)          // exempt from the XSS body rule
app.post('/documents/upload', ...) // also fine — the path contains /upload
app.post('/import', ...)           // NOT exempt — XML/HTML uploads here will 403
```

This is not cosmetic. Upload bodies frequently contain markup (XML, HTML
fragments) that looks like a cross-site-scripting payload, so the platform
exempts the body rule for POSTs to `/upload` paths. Any other path gets no
exemption. Name your upload endpoint accordingly.

**Avoid SQL keywords in JSON request bodies.** A body like `{"limit": 20,
"order": "select"}` can trip the SQL-injection body rule. Prefer names that are
not SQL keywords (`pageSize` over `limit`, `sortBy` over `order`).

**A 403 with nothing in your app logs is the WAF, not your code.** If a request
fails with 403 and your handler never ran — no log line, no error — the WAF
blocked it. Do not spend hours debugging your route.

To confirm and get it resolved, tell the platform team:

- the full URL and HTTP method
- roughly when it happened (UTC)
- what the body contained (its shape, NOT real data or credentials)

They can look up the exact rule that matched and, if it is a genuine false
positive, scope an exemption. Do not try to work around it by obfuscating the
payload — the rules also block real attacks, and Log4Shell and
Java-deserialization patterns in a body are blocked everywhere with no exemption.
