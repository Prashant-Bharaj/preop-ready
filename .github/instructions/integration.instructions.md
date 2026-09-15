---
applyTo: "docker-compose.yml,frontend/nginx*.conf"
---

<!-- GENERATED FILE - DO NOT EDIT. Source: .platform-rules/scope-integration.md -->
<!-- Regenerate: node scripts/build-rule-adapters.js -->

# Integration Rules

⛔ **docker-compose.yml is LOCAL DEV ONLY.** Production ignores it entirely — the platform
builds the Dockerfiles into ECS tasks and wires them itself. Never tell the user a compose
change affects the deployed app, and never "deploy" with `docker-compose up`. What replaces
what:

| Locally (docker-compose) | In production (platform) |
|--------------------------|--------------------------|
| `nginx.local.conf` proxies `/api` → backend | Traefik routes and strips `/api` |
| `env_file: [.env]` / `environment:` | GitHub Secrets (`APP_*`) + auto-injected `DATABASE_*`/`VECTORDB_*` |
| named volumes (`db-data:/data`) | EFS mounted at `/data` |
| `depends_on` ordering | ECS service orchestration + health checks |
| `docker-compose up --build` | `git push` (deploy workflow) |

Core rules (routing, ports, `/health`, nginx server-block-only format) are in `.platform-rules/01-common.md` — this file covers how the services fit together.

## docker-compose.yml per Architecture

**Full-stack** (frontend + backend + database):

⛔ NEVER put credentials directly in docker-compose.yml — it is tracked in git, and the
pre-commit security check blocks a compose file with a literal `*_PASSWORD` value. All
credential values live in a gitignored `.env` next to docker-compose.yml: compose reads it
for `${VAR}` substitution and the backend loads it via `env_file:`. The harness writes it
before a build; when building by hand, create it once:

```bash
cat > .env << 'EOF'
DATABASE_NAME=myapp
DATABASE_USER=myapp_user
DATABASE_PASSWORD=localdev123
# pgvector only:
VECTORDB_NAME=vectors
VECTORDB_USER=vectordb_user
VECTORDB_PASSWORD=localdev123
EOF
```

App secrets (API keys, `JWT_SECRET`, …) live in `backend/.env` (see
`reference/secrets-and-keys.md`); the backend loads both files.

```yaml
services:
  frontend:
    build: ./frontend
    ports: ["8080:8080"]
    volumes:
      - ./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro   # REQUIRED
    depends_on: [backend]
  backend:
    build: ./backend
    ports: ["3000:3000"]
    env_file:
      - .env                          # DATABASE_* / VECTORDB_* / MGA_* — never inline these
      - path: backend/.env            # app secrets — optional
        required: false
    environment:
      - PORT=3000
      - DATABASE_HOST=database          # MUST equal the db service name below
      - DATABASE_PORT=5432
    depends_on: [database]
  database:
    build: ./database
    environment:
      POSTGRES_DB: ${DATABASE_NAME}
      POSTGRES_USER: ${DATABASE_USER}
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
    volumes: [db-data:/data]
  # Optional vector DB (independent service; backend adds VECTORDB_HOST=vectordb
  # and VECTORDB_PORT=5432 to its environment):
  # vectordb:
  #   build: ./vectordb
  #   environment:                      # pgvector
  #     POSTGRES_DB: ${VECTORDB_NAME}
  #     POSTGRES_USER: ${VECTORDB_USER}
  #     POSTGRES_PASSWORD: ${VECTORDB_PASSWORD}
  #   volumes: [vectordb-data:/data]
volumes:
  db-data:
  # vectordb-data:
```

(Compose reads `${...}` values from `.env` automatically; the backend gets the same
variables via `env_file:`, so the two sides cannot drift. The values are dev-only fakes,
but the PATTERN must be `.env` + references — a tracked compose file with literal
credentials is blocked at commit time. Never create `.env.example`.)

**Frontend + backend** (no database): delete the `database` service, the backend's `depends_on: [database]` and `DATABASE_*` env vars, and the `volumes:` block.

**Frontend-only**:

```yaml
services:
  frontend:
    build: ./frontend
    ports: ["8080:8080"]
    volumes:
      - ./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro
```

For frontend-only, `nginx.local.conf` must have NO proxy blocks — `cp frontend/nginx.conf frontend/nginx.local.conf` (a `proxy_pass` to a non-existent `backend` service crashes nginx on startup).

## Cross-Service Consistency Rules

- `DATABASE_HOST` (and `VECTORDB_HOST`) must equal the compose **service name** exactly.
- DB port is 5432 (postgres/pgvector).
- Env var names in backend code = names in `.env` / the compose `environment:` block.
- The `nginx.local.conf` volume mount is **REQUIRED** whenever a backend exists — without it, local `/api` calls hit the proxy-less production `nginx.conf` and 404.
- `depends_on` chain: frontend → backend → database.
- Keep the platform service names: `frontend`, `backend`, `db`/`database`, `vectordb`.

## Verify BEFORE Every `docker-compose up`

| Check | Frontend-only | Has backend | Full-stack |
|-------|---------------|-------------|------------|
| compose has `backend` service? | ⛔ removed | required | required |
| compose has `db` service? | ⛔ removed | remove if unused | required |
| frontend has `depends_on: backend`? | ⛔ removed | required | required |
| `nginx.local.conf` has `/api/` proxy block? | ⛔ removed | required | required |
| `nginx.local.conf` has `/socket.io/` proxy block? | ⛔ removed | if using WS | if using WS |
| `nginx.conf` has NO `proxy_pass`? | must not | must not | must not |

Fix any mismatch first:
- `proxy_pass` in `nginx.local.conf` pointing at a missing backend service crashes nginx locally.
- `proxy_pass` in `nginx.conf` crashes nginx in production — Traefik handles API routing, never nginx.

## Removing a Segment

Segments are optional and independent; the segment's `Dockerfile` is what triggers its deployment. To remove one: delete its `Dockerfile`, remove its compose service, remove its env vars from the backend service, then run `./scripts/preflight-check.sh`. EFS data, passwords, and images are preserved — re-adding the Dockerfile restores the service with its data.

Deployment and testing depth: `.platform-rules/reference/*.md`.
