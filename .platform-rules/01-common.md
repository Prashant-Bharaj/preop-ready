---
description: "Universal build rules: API routing, health endpoints, project structure, env vars, persistence, URLs, snippets, WebSockets"
triggers: []
globs: []
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
| Actix | `web::resource("/users")` | `web::resource("/api/users")` |

## /health Required in EVERY Container (deployment fails without it)

- nginx.conf: `location /health { return 200 'OK'; add_header Content-Type text/plain; }`
- Express: `app.get('/health', (req, res) => res.json({ status: 'ok' }));`
- FastAPI: `@app.get("/health")` → `return {"status": "ok"}`

## Project Structure

```
frontend/    nginx static (port 8080) — Dockerfile, nginx.conf (prod, no proxy),
             nginx.local.conf (local dev, proxies /api → backend:3000)
backend/     Express (TS) / FastAPI / Actix (port 3000) — Dockerfile
             migrations/ ← ALL schema changes after first boot live HERE
database/    Postgres (optional) — Dockerfile, init/ (schema, first boot
             ONLY), seed/ (gitignored) — ⛔ NO other .sql anywhere under database/
vectordb/    pgvector (optional, independent) — Dockerfile, init/
docker-compose.yml   local dev — MUST mount nginx.local.conf over the frontend's default.conf
```

Service names in docker-compose must stay `frontend`, `backend`, `db`/`database`, `vectordb`.

## ⛔ Existing Project → Continue in ITS Stack

The TypeScript defaults above are for **fresh** projects. If real code already exists, the
stack is decided — detect it and stay in it, using the matching-language snippet
(`snippets/**/*.py` for Python, `*.js` for JavaScript, `*.ts` for TypeScript):

| Found | Stack — continue with |
|-------|-----------------------|
| `backend/main.py` / `requirements.txt` | Python + FastAPI (first-class: `Dockerfile.python`, 25 `.py` snippets) |
| `backend/src/index.ts` / `tsconfig.json` | Node + Express, TypeScript |
| `backend/server.js` / `src/index.js` (no tsconfig) | Node + Express, **JavaScript — do not convert to TS**; keep its existing `backend/Dockerfile` (`Dockerfile.node` is TS-only) |
| `backend/Cargo.toml` | Rust + Actix-web |
| `frontend/package.json` with `react` | React + Vite (keep its language: `.jsx` stays `.jsx`) |

`bash scripts/detect-stack.sh` prints the answer (`backend=`, `frontend=`, …). Rewriting a
working project into another language or framework is never a side effect of a feature
request — only ever an explicit, separate ask. Two planned, opt-in paths exist:
a *retired* layer (`retired=…`) → `.platform-rules/scope-migration.md`; a JavaScript layer
that wants the TypeScript layout → `.platform-rules/scope-typescript.md`. Both need the
user's yes and start with a backup branch.

⛔ **Database migrations are BACKEND code**: `backend/migrations/NNN_*.sql`, executed by
the runner inside the backend container — which contains ONLY `backend/`. A migration
file under `database/` or the repo root is invisible to it and will NEVER run.

⛔ **docker-compose.yml is LOCAL DEV ONLY — it plays ZERO role in production.**
Production runs on ECS, built from the Dockerfiles, wired by the platform (Traefik
routing, EFS volumes, injected env). NOTHING in docker-compose — services, environment,
ports, volumes, depends_on — affects the deployed app. Deploying is `git push`, never
`docker-compose up`. Production env comes from GitHub Secrets (`APP_*`) and auto-injected
`DATABASE_*`/`VECTORDB_*` — a variable that only exists in docker-compose is undefined
in production.

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
- Every backend: `SMTP_HOST` (`ebr.bayer.com`), `SMTP_PORT` (`2525`) — Bayer EBR mail relay.
  ⛔ Email needs NO credentials: EBR allows the platform's IPs, there is no SMTP username or
  password. Never add `SMTP_USER`/`SMTP_PASSWORD` or ask the user for their Bayer password.
  The only requirement is a `@bayer.com` sender. Copy `snippets/email/smtp-client.{ts,py}`.

⛔ **Keep the platform's DB/user names — do NOT rename the database or user to your project**
(e.g. inventing `myproject_db` / `myproject_user`). The injected `DATABASE_*` (prod) and the
fixed local values are what the backend connects with; renaming them is the #1 cause of the
backend failing to reach its own database.

Local dev: app secrets go in `backend/.env`, database credentials in the root `.env` that
docker-compose reads (both gitignored, created directly — see `scope-integration.md`).
Never `.env.example`.

## /data Persistence (EFS)

All persistent data lives under `/data` — anything else is lost on redeploy. Template
Dockerfiles are pre-configured (`PGDATA=/data/postgres`). App file uploads → `/data/uploads`.
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
- **Emit on every state change.** A socket that only handles `connection` pushes
  nothing. After a REST handler writes, call `io.emit(event, row)` (or the
  `broadcastChange` helper in `snippets/realtime/websocket-helper.*`, room-scoped
  if gated) so clients update live without polling. Connection-only Socket.IO is
  the most common real-time bug.
- **Reference entities your routes act on must exist.** If status/history routes
  target a fixed set the API never creates (e.g. production "lines"), the harness
  pre-seeds 3 placeholder rows in `database/init/02_reference_data.sql` (guarded:
  inserts only when the table is empty). If you add such a table yourself, seed it
  the same way (placeholders, never real data) or expose a create route — a handler
  that 404s because the row was never created looks "working" but is broken for
  the user. `database/seed/` is manual local test data; nothing runs it.
