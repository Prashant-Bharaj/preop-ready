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

⛔ NEVER put credentials directly in docker-compose.yml (it is tracked in git). All
credential values live in a gitignored `.env` next to docker-compose.yml — compose
loads it via `env_file:` and `${VAR}` substitution. Create it once:

```bash
cat > .env << 'EOF'
DATABASE_NAME=myapp
DATABASE_USER=myapp_user
DATABASE_PASSWORD=localdev123
EOF
```

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
    env_file: [.env]
    environment:
      - PORT=3000
      - DATABASE_HOST=database          # MUST equal the db service name below
    depends_on: [database]
  database:
    build: ./database
    environment:
      POSTGRES_DB: ${DATABASE_NAME}     # MySQL instead: MYSQL_DATABASE/_USER/_PASSWORD/_ROOT_PASSWORD
      POSTGRES_USER: ${DATABASE_USER}
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
    volumes: [db-data:/data]
  # Optional vector DB (independent service):
  # vectordb:
  #   build: ./vectordb
  #   environment:                      # pgvector only; Chroma/Qdrant need no env vars
  #     POSTGRES_DB: vectors
  #     POSTGRES_USER: vectordb_user
  #     POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
  #   volumes: [vectordb-data:/data]
volumes:
  db-data:
  # vectordb-data:
```

(Compose reads `${...}` values from the `.env` file automatically; the backend gets them
via `env_file:`. The values are dev-only fakes, but the PATTERN must be env_file — a
tracked compose file with literal credentials teaches the wrong habit and fails preflight.)

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
- Port matches DB type: 5432 postgres/pgvector · 3306 mysql · 8000 chroma · 6333 qdrant.
- Env var names in backend code = names in the compose `environment:` block.
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
