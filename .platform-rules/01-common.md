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
