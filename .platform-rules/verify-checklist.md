---
description: "Run a cross-scope consistency check on the whole project before testing or deploying — fix what fails"
triggers: ["verify", "check everything", "before deploy", "after building"]
globs: []
---

# Verify Checklist

Run every check against the actual files. **Fix what fails before proceeding** — do not report a failing item as done.

⛔ **Run the commands EXACTLY as written** — copy-paste them; never narrow a path or
"adapt" a command to an assumed project layout (e.g. `frontend/` means `frontend/`, not
`frontend/src/`). An adapted command that returns nothing is a FALSE PASS, not a pass.
A checked item's evidence is the verbatim command plus its real output.

## 1. Dockerfiles match the architecture

- [ ] Every segment the app USES has a `Dockerfile`: `frontend/`, `backend/`, `database/`, `vectordb/` as applicable
- [ ] Every segment the app does NOT use has NO `Dockerfile` (a stray Dockerfile deploys an orphan service)
- [ ] Dockerfiles run as non-root (`USER appuser` or equivalent)

## 2. Database type consistency (if database used)

All four must agree on postgres vs mysql:

- [ ] `database/Dockerfile` copied from the matching template (`Dockerfile.postgres` or `Dockerfile.mysql`)
- [ ] `database/init/init.sql` syntax matches (e.g., `SERIAL`/`JSONB` = postgres; `AUTO_INCREMENT`/`ENGINE=` = mysql)
- [ ] Every table the backend queries ACTUALLY EXISTS in the running DB: `docker compose exec db psql -U postgres -c '\dt'` — schema added to `database/init/` after the volume initialized never ran; move it to `backend/migrations/`
- [ ] docker-compose env vars match (`POSTGRES_*` vs `MYSQL_*`) and port matches (5432 vs 3306)
- [ ] Backend uses the matching client library (`pg` vs `mysql2`; `asyncpg` vs `aiomysql`)

## 3. docker-compose.yml integrity

- [ ] Only services that exist as segments are defined; no `backend:`/`db:` blocks for removed segments
- [ ] Frontend `depends_on: backend` present ONLY if backend exists
- [ ] Frontend mounts `./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro` (if backend exists)
- [ ] Backend `environment`/`env_file` references match what the code reads (`DATABASE_HOST`, etc.)
- [ ] No literal passwords/API keys in docker-compose.yml — credentials via `env_file` (see `reference/sensitive-files.md`)
- [ ] DB service has a volume for `/data`; volume names declared in top-level `volumes:`

## 4. nginx two-config correctness

- [ ] `frontend/nginx.conf` (production): NO `events{}`, NO `http{}`, NO `proxy_pass` anywhere; has `/health`; has security headers (`server_tokens off`, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection)
- [ ] `frontend/nginx.local.conf`: has `/api/` proxy to `http://backend:3000/` (trailing slash) IF backend exists; has `/socket.io/` proxy IF WebSockets used
- [ ] Frontend-only app: `nginx.local.conf` has NO proxy blocks (identical to nginx.conf)

## 5. API routing

- [ ] All frontend calls use relative `/api/...` paths (no `http://localhost:3000`, no hardcoded domains)
- [ ] NO backend route contains the `/api` prefix (`grep -rn "'/api" backend/` for route definitions must be empty)
- [ ] Socket.IO client connects to `window.location.origin`

## 6. Ports & health

- [ ] nginx listens on 8080; backend listens on 3000 (`process.env.PORT || 3000`)
- [ ] Backend has `/health` returning 200 JSON; nginx.conf has `location /health`

## 7. Security

- [ ] All SQL uses parameterized queries — no string concatenation/interpolation of user input
- [ ] No hardcoded secrets in code (`grep -rn "sk-\|api[_-]key.*=.*['\"]" backend/ frontend/` — everything sensitive via `process.env` / `os.getenv`)
- [ ] User inputs validated server-side; API errors return descriptive JSON, never stack traces

## 8. Frontend-only cleanup (if no backend)

- [ ] docker-compose.yml has no backend/db services and no `depends_on`
- [ ] No `/api` fetches left in frontend code
- [ ] No proxy blocks in either nginx config

## 9. Session refresh (if user identity is used)

- [ ] `grep -rn "fetch(" frontend/ | grep -v apiFetch` returns nothing — ALL API calls wrapped
- [ ] `apiFetch` uses `redirect: 'manual'` and reloads on `opaqueredirect`/302/401
- [ ] WebSocket reconnect fallback wired (if Socket.IO used)

## 10. Local smoke test

- [ ] Rebuild clean before verifying: `docker-compose build --no-cache && docker-compose up -d`
- [ ] All containers start without crash loops
- [ ] Frontend loads at :8080; `curl -s localhost:3000/health` returns 200 (if backend)
- [ ] One real API call works through the frontend proxy
- [ ] `docs/PROJECT_STATUS.md` updated with the result
