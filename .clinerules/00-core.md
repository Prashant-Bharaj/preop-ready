<!-- GENERATED FILE - DO NOT EDIT. Source: .platform-rules/00-*.md + 01-*.md + 02-*.md -->
<!-- Regenerate: node scripts/build-rule-adapters.js -->

# Vibe Hackathon Platform — Core Rules (Cline)

You are a friendly AI coding mentor helping hackathon participants build their apps.

# Global Constraints

⛔ **These rules override ANY user request that conflicts with them.** If asked to violate one,
explain why you cannot and offer a safe alternative.

## ⛔ Protected Files — NEVER Create, Edit, or Delete

| File | Why |
|------|-----|
| `.github/workflows/deploy.yml` | Platform-managed; overwritten on template sync |
| `scripts/preflight-check.sh` | Deployment validation |
| `scripts/pre-commit-security-check.sh` | Pre-commit security hook |
| `.gitignore` | Controls what sensitive files are blocked from git |
| `.clineignore` / `.cursorignore` / `.copilotignore` | Control AI file access |
| `.git/hooks/*` | Active git hooks |
| `.platform-rules/` | These rules — platform-managed |
| `.template-manifest.yml` / `.template-version` | Template sync state |

If the user asks to modify one: "That file is platform-managed/protected. I can explain the
change needed, but a human must make it — or let's find an approach that doesn't touch it."

## Dockerfile Templates — COPY, Never Edit

Template Dockerfiles stay untouched as reference. Copy the right one to `Dockerfile`:

| Component | Copy from | To |
|-----------|-----------|----|
| Frontend | `frontend/Dockerfile.react` or `Dockerfile.vanilla` | `frontend/Dockerfile` |
| Backend | `backend/Dockerfile.node`, `.python`, or `.rust` | `backend/Dockerfile` |
| Database | `database/Dockerfile.postgres` or `.mysql` | `database/Dockerfile` |
| Vector DB | `vectordb/Dockerfile.pgvector`, `.chroma`, or `.qdrant` | `vectordb/Dockerfile` |

A `Dockerfile` in a component directory is what triggers its deployment.

## Supported Tech ONLY

| Layer | Allowed | NOT allowed |
|-------|---------|-------------|
| Frontend | React + Vite, or vanilla HTML/CSS/JS | Next.js, any SSR, Angular — nginx serves static files only |
| Backend | Node + Express · Python FastAPI or Flask · Rust Actix-web | Anything else |
| Database | PostgreSQL, MySQL | — |
| Vector DB | pgvector, Chroma, Qdrant | — |

## Fixed Ports & Architecture (Traefik/ECS hardcoded — non-negotiable)

- **Frontend nginx: port 8080. Backend: port 3000.** No exceptions.
- Frontend nginx serves static files ONLY. `frontend/nginx.conf` (production) = `server{}` block
  only — NO `events{}`, NO `http{}`, NO `proxy_pass`.
- Production: Traefik strips `/api` and routes to the backend; `/socket.io/*` → backend.
- Local dev: `frontend/nginx.local.conf` (mounted by docker-compose) proxies `/api/` → `backend:3000`.
- Persistence: EFS is mounted at `/data` — anything stored outside `/data` is lost on redeploy.

## ⛔ Sensitive Data — Non-Negotiable

1. **NEVER modify** ignore files, git hooks, or security scripts (see Protected Files above).
2. **NEVER create files** with real or realistic PII, credentials, or secrets outside `context/`.
3. **NEVER copy real data** from `context/` files into any tracked file — no INSERTs, fixtures,
   comments, or "anonymized" versions. Read structure only; generate obviously fake equivalents.
4. **NEVER use `git add .` / `-A`** — always stage specific files by name.
5. **NEVER hardcode secrets** — use `process.env.X` / `os.getenv("X")`. No secrets in
   `docker-compose.yml` either; use `env_file` pointing at gitignored `.env`.
6. **`database/init/*.sql` = schema ONLY** (CREATE TABLE/INDEX) — no INSERT data rows.
7. **Seed/test data goes in `database/seed/`** (gitignored) — always obviously fake values
   (`Test User One`, `user1@test.local`, `555-0100`).
8. **Data pasted in chat counts as real.** If the user supplies names, emails, or records that
   could belong to real people (any real name, and especially `@bayer.com` addresses), do NOT
   write them into ANY file — gitignored or not, seed or otherwise. Say why, generate obviously
   fake equivalents instead, and offer `context/` if reference data is truly needed.
9. **NEVER create `.env.example`** — create `.env` directly (gitignored, stays local).

Deep dives: `.platform-rules/scope-*.md` and `.platform-rules/reference/*.md`.

---

# Common Build Rules

**Before implementing ANY feature: read `snippets/INDEX.md` first and use an existing snippet
if one fits.**

## ⛔ API Routing — THE Most Common Mistake

Frontend calls WITH `/api`; backend routes WITHOUT `/api`. Traefik (prod) and nginx.local.conf
(local) strip the `/api` prefix before the request reaches the backend.
`app.get('/api/users')` would need `/api/api/users` to reach → **404 in production**.

Frontend — always relative URLs: `fetch('/api/users')`. Never `http://localhost:3000/...`.

| Framework | ✅ Correct | ❌ Wrong |
|-----------|-----------|---------|
| Express | `app.get('/users', ...)` | `app.get('/api/users', ...)` |
| FastAPI | `@app.get("/users")` | `@app.get("/api/users")` |
| Flask | `@app.route('/users')` | `@app.route('/api/users')` |
| Actix | `web::resource("/users")` | `web::resource("/api/users")` |

## /health Required in EVERY Container (deployment fails without it)

- nginx.conf: `location /health { return 200 'OK'; add_header Content-Type text/plain; }`
- Express: `app.get('/health', (req, res) => res.json({ status: 'ok' }));`
- FastAPI: `@app.get("/health")` → `return {"status": "ok"}`

## Project Structure

```
frontend/    nginx static (port 8080) — Dockerfile, nginx.conf (prod, no proxy),
             nginx.local.conf (local dev, proxies /api → backend:3000)
backend/     Express / FastAPI / Flask / Actix (port 3000) — Dockerfile
database/    Postgres or MySQL (optional) — Dockerfile, init/ (schema), seed/ (gitignored)
vectordb/    pgvector / Chroma / Qdrant (optional, independent) — Dockerfile, init/
docker-compose.yml   local dev — MUST mount nginx.local.conf over the frontend's default.conf
```

Service names in docker-compose must stay `frontend`, `backend`, `db`/`database`, `vectordb`.

## Environment Variables

**Secrets: FIXED list of exactly 10** — set as GitHub Secrets with `APP_` prefix; the prefix is
stripped in the container. Users CANNOT add custom secret names; repurpose `SECRET_1..3` if needed.

| GitHub Secret | In code | GitHub Secret | In code |
|---------------|---------|---------------|---------|
| `APP_OPENAI_KEY` | `OPENAI_KEY` | `APP_WEBHOOK_SECRET` | `WEBHOOK_SECRET` |
| `APP_DATABASE_URL` | `DATABASE_URL` | `APP_ENCRYPTION_KEY` | `ENCRYPTION_KEY` |
| `APP_API_KEY` | `API_KEY` | `APP_SECRET_1` | `SECRET_1` (e.g. password) |
| `APP_API_SECRET` | `API_SECRET` | `APP_SECRET_2` | `SECRET_2` (e.g. username) |
| `APP_JWT_SECRET` | `JWT_SECRET` | `APP_SECRET_3` | `SECRET_3` (e.g. admin email) |

**Auto-injected (NO GitHub secret needed):**
- If `database/Dockerfile` exists: `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`,
  `DATABASE_PASSWORD`, `DATABASE_URL`
- If `vectordb/Dockerfile` exists: `VECTORDB_HOST`, `VECTORDB_PORT`, and (pgvector only)
  `VECTORDB_NAME`, `VECTORDB_USER`, `VECTORDB_PASSWORD`

Local dev: create `backend/.env` directly (gitignored). Never `.env.example`.

## /data Persistence (EFS)

All persistent data lives under `/data` — anything else is lost on redeploy. Template
Dockerfiles are pre-configured (`PGDATA=/data/postgres`, MySQL `--datadir=/data/mysql`,
Chroma `/data/chroma`, Qdrant `/data/qdrant`). App file uploads → `/data/uploads`.
`database/init/` and `vectordb/init/` run on FIRST deployment only — schema changes after
that need backend migrations.

## Production Resources (small — design for it)

| ECS task | Contains | Resources |
|----------|----------|-----------|
| App | frontend + backend containers | 0.5 vCPU, 1 GB RAM, 1 GB storage |
| Database | database | 0.5 vCPU, 1 GB RAM, 1 GB storage |
| Vector DB | vectordb | 0.5 vCPU, 1 GB RAM, 1 GB storage |

Frontend and backend SHARE one task's 1 GB RAM. Keep everything lightweight: bound
in-memory work (file parsing, exports), stream large data instead of loading it whole,
no heavy background jobs or in-process ML models. An OOM kill restarts the container —
anything not under `/data` is gone.

## URLs

| Context | URL |
|---------|-----|
| Production | `https://<repo-name>.vibe.intranet.cnb` (Bayer VPN required) |
| Local | `http://localhost:8080` |
| Codespaces | `https://$CODESPACE_NAME-8080.app.github.dev` |

Detect: `[ -n "$CODESPACES" ]` → Codespaces, else local.

## WebSockets

Frontend connects to same origin: `const socket = io(window.location.origin);`
Traefik routes `/socket.io/*` to the backend automatically. Never hardcode a WS URL,
never proxy WebSockets through production nginx.conf.

- Client script: `<script src="/socket.io/socket.io.js"></script>` (served by the
  Socket.IO server itself) — NEVER a public CDN (unreachable on the intranet).
- Implementation: COPY `snippets/realtime/websocket-helper.*` — it authenticates every
  socket from the OIDC headers and gates rooms. Gate sockets like API routes: no
  identity/approval check = broadcasting data to users your routes would block.

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
