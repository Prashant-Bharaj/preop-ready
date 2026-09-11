# Platform constraints for compose authoring

These constraints apply to every `docker-compose.yml` you author for this platform. They reflect the platform runtime (EFS mounts, structural assertions) and the local-dev harness (no `.env` seeding) — generic compose practice diverges from them in ways that silently break either prod or smoke.

### Service names match scope folder names

`database`, `backend`, `frontend`, `vectordb`. Inside the compose network, services reach each other by these hostnames; backend connects to `database` (NOT `localhost`, NOT `127.0.0.1`). Mismatched service names are a top source of "looks fine but doesn't connect" bugs.

### Port mapping

Only the frontend exposes a host port (`8080:8080`). Backend (`3000`) and database (`5432` Postgres) are network-internal in production shape. Local-dev compose MAY temporarily expose them for debugging.

### Volume mount for database persistence

Postgres PGDATA is `/data` (per `database/Dockerfile`'s `ENV PGDATA=/data`). Mount a named volume at `/data`. The platform's EFS access point handles ownership in production. NEVER bind-mount the project directory into the database container at `/data` — that overrides the access point and loses persistence on redeploy.

**The database service uses `build: { context: ./database, dockerfile: Dockerfile }` — NEVER `image: postgres:16` directly.** This platform requires the custom Dockerfile because it sets `ENV PGDATA=/data` (matching the platform's EFS access point in production); the stock `postgres:16` image puts data at `/var/lib/postgresql/data`, which fails the platform's structural assertions and breaks production persistence.

**Init scripts are handled by the database Dockerfile — DO NOT add a separate `init.sql` volume mount.** `database/Dockerfile` does `COPY init/ /docker-entrypoint-initdb.d/` at image build time — init files are baked in. Adding `./database/init.sql:/docker-entrypoint-initdb.d/init.sql:ro` (or similar) is redundant AND wrong-path: the actual file lives at `database/init/init.sql`, not `database/init.sql`. Just declare the named data volume mount at the engine's data path; the image handles the rest.

### `depends_on` with healthchecks

Backend `depends_on: { database: { condition: service_healthy } }`. Healthchecks belong to the depended-upon services:

- Postgres: `pg_isready -U <user> -d <db>` every 5s.
- Backend: `curl -f http://localhost:3000/health || exit 1` — requires backend's report to list `GET /health`. If it doesn't, name it as a contract gap in your report.

### Env vars from compose's `environment:` blocks

For LOCAL DEV (the harness's compose target), inline non-sensitive credentials directly in `environment:` (e.g. `DATABASE_PASSWORD: localdev123`) — **do NOT use `${VAR}` substitution**, since the smoke harness runs `docker compose up` without seeding a `.env` file and unsubstituted vars become empty strings (Postgres starts with no password → connection failures). For real secrets (production API keys, etc.), use `${VAR}` with a documented entry in `.env.example`. `.env.example` documents names; real `.env` is gitignored.
