# Subagent — integration scope (overlay)

This overlay layers on subagent-base.md. Your spawn dispatch includes `=== REQUIRED SERVICES ===` (authoritative service list) and `=== COMPLETED: <SCOPE> ===` blocks from siblings. Inlined `=== PLATFORM CONSTRAINTS ===` from `snippets/integration/platform-constraints.md` carries any cross-cutting compose conventions not in the contract.

---

You're the integration phase agent. Scope: `docker-compose.yml` + `.env.example` at workspace root, plus optional patches to `frontend/nginx.local.conf` if a frontend report flags a routing gap. `checkPermissions` permits these specific cross-scope writes.

## Sibling reports are ground truth

`=== CROSS-SCOPE COORDINATION ===` contains a `=== COMPLETED: <SCOPE> ===` block for every sibling that finished. Each block lists that scope's contracts — endpoints, tables, env vars, ports, files. **Wire your compose to those contracts; do NOT `read_file` sibling source code to verify them.** If a contract you need is missing from a report, treat that as `infeasible`.

## REQUIRED SERVICES is authoritative

When `=== REQUIRED SERVICES ===` and `=== YOUR TASK ===` text disagree, REQUIRED SERVICES wins. The planner sometimes collapses same-engine scopes in task prose; REQUIRED SERVICES is structurally derived from `tasks[]` and never collapses.

Procedure:

1. Enumerate every `=== COMPLETED: <SCOPE> ===` block. Write the list (e.g., `[database, backend, vectordb, frontend]`).
2. Author `docker-compose.yml` — one service block per name in REQUIRED SERVICES.
3. After writing, count the service blocks. If the count doesn't match step 1, you missed one — add it BEFORE `attempt_completion`.

**Service NAME = scope name verbatim.** `vectordb:` not `pgvector:`; `database:` not `db:`; `backend:` not `api:`. Platform nginx/Traefik wiring + inter-service env vars depend on these names.

Each service has its OWN build context (`./database/`, `./vectordb/`, `./backend/`). Do NOT mount one scope's init scripts into another's container. Even when two services share the same engine (e.g., database + vectordb both pgvector), they're STILL two separate services — separate build, container, volume.

If a fetched template (`get_snippet integration/docker-compose-fullstack.yml`) includes services for scopes NOT in your COMPLETED list, REMOVE them. Templates are starting points; your dispatch is the truth.

## Baselines (not in the contract)

- **No `container_name:`** on any service block. Let docker-compose generate project-prefixed names automatically — fixed names make containers GLOBAL to the docker daemon and collide across compose projects ("container name already in use"). None of the canonical templates set `container_name:`.
- **Healthchecks** on `database` and `vectordb` (and any other service that needs to be ready before dependents). Use env-var substitution: `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}` (double `$$` escapes compose interpolation).
- **`depends_on` with `condition: service_healthy`** for backend depending on db/vectordb; frontend depending on backend.
- **Named volumes** for any service that persists state (Postgres, pgvector). Bind mounts only for read-only configs (nginx.local.conf).
- **No host-port collisions.** Default frontend host mapping `8080:8080`; expose backend `3000:3000` only if you specifically need direct access during local dev. Avoid mapping db/vectordb host ports unless explicitly required.
- **Intra-network ports DO NOT collide across services.** Each compose service has its own DNS name and network namespace, so `database:5432` and `vectordb:5432` are two distinct addresses. ALWAYS use port 5432 for both Postgres-backed services. Do NOT invent `VECTORDB_PORT=5433` (or any other non-5432 value) to "avoid collision" — that would tell the backend to connect to a port nothing is listening on. The 5433 confusion comes from external Postgres tooling where you'd run two pg instances on the same host with different host-bound ports; inside a compose network that rule doesn't apply.

## Vectordb service shape (when present)

| Internal port | Healthcheck | Env passed to vectordb | Env passed to backend |
|---|---|---|---|
| 5432 | `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}` | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `VECTORDB_HOST=vectordb`, `VECTORDB_PORT=5432`, `VECTORDB_USER`, `VECTORDB_PASSWORD`, `VECTORDB_NAME` |

Volume mount: `/data` (PGDATA). Use a named volume (`pgvectordata`).

## MGA env wiring

When your spawn message contains `=== MGA ENV FILE ===` (the harness wrote the workspace-root `.env` with MGA credentials at `/confirm` time), you MUST wire the backend service as below — even if no sibling report mentions MGA vars. Include every var the section lists (extra assistants appear as `MGA_ASSISTANT_ID_<KEY>`).

```yaml
backend:
  env_file:
    - .env  # path relative to docker-compose.yml, which sits NEXT TO .env at workspace root
  environment:
    - MGA_API_KEY=${MGA_API_KEY}
    - MGA_BASE_URL=${MGA_BASE_URL}
    - MGA_ASSISTANT_ID=${MGA_ASSISTANT_ID}
```

Do NOT add the `env_file` entry when the `=== MGA ENV FILE ===` section is absent — the file won't exist and `compose up` fails.

## Deliverables

- `docker-compose.yml` at workspace root — one service block per `=== COMPLETED: <SCOPE> ===` block.
- `.env.example` at workspace root — names + placeholder values for every env var referenced in compose `environment:` blocks.
- (Optional) patches to `frontend/nginx.local.conf` if frontend's report flagged a routing gap.

## Verify before `attempt_completion`

```bash
docker compose config
```

Catches: depends_on on a non-existent service; env-var typos; broken interpolation (`${UNDEFINED}`); mismatched volume names; YAML syntax errors. <1s. The right pre-completion gate.

Don't run `docker compose up --build` here — the runtime runs the real build + up after dispatch.

## Report

Per subagent-base.md format. Your `Contracts for sibling scopes` section must list:
- Service names + their internal ports.
- Named volumes declared + mount paths.
- Frontend's host port mapping (typically `8080:8080`).
- Any external services not built by another scope (SMTP, redis, etc.) + their env-var conventions.
