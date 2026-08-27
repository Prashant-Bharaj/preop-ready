---
applyTo: "database/**"
---

<!-- GENERATED FILE - DO NOT EDIT. Source: .platform-rules/scope-database.md -->
<!-- Regenerate: node scripts/build-rule-adapters.js -->

# Database Rules

⛔ **READ FIRST — where SQL files go. Getting this wrong breaks the app silently:**

| SQL file | ONLY correct location | Runs |
|----------|----------------------|------|
| Initial schema | `database/init/*.sql` | ONCE, first boot of an empty volume — FROZEN after that |
| Every schema change after first boot | `backend/migrations/NNN_*.sql` | Backend startup, via the runner |
| Seed/test data (fake only) | `database/seed/` (gitignored) | Manually |

**NEVER create `database/migrations/` or a repo-root `migrations/`** — migrations execute
inside the backend container, whose image contains ONLY `backend/`; files anywhere else
can never run, locally or deployed. Preflight fails the build on misplaced files.

Core rules (`/data` persistence rule, protected files, auto-injected secrets) are in `.platform-rules/01-common.md` — this file adds database depth only.

## Setup

```bash
cp database/Dockerfile.postgres database/Dockerfile   # PostgreSQL
```

Vector search / embeddings do NOT go here — use `vectordb/` (see `.platform-rules/scope-vectordb.md`).

Migrating from a document/KV store (MongoDB, DynamoDB, etc.)? There is no drop-in port — it needs
a data-model redesign (documents → relational tables).

## Init Scripts — first deploy ONLY

- `database/init/*.sql` runs ONCE, when the data directory is empty (first deployment). Editing existing files OR adding new ones afterwards has NO effect — the directory is only read on that first boot. This includes the LOCAL docker volume: if `docker-compose up` has ever initialized the database, new init files silently never run.
- ⛔ **Once the app has a running database, treat `database/init/` as FROZEN.** EVERY new table or column goes into `backend/migrations/NNN_*.sql` (runner: `snippets/config/db-migrations.js`) — even mid-build, even for a brand-new feature. After adding schema, PROVE it exists before writing code that uses it: `docker compose exec db psql -U postgres -c '\d <table>'`.
- ⛔ **Migrations live in `backend/migrations/` and NOWHERE else** — not `database/migrations/`, not the repo root. The runner executes INSIDE the backend container, whose image contains only `backend/`; a migration file anywhere else is invisible to it and will NEVER run, locally or deployed. Preflight fails on misplaced migration files. The only `.sql` allowed under `database/` is `init/` (schema, first boot only) and `seed/` (gitignored fake data).
- Use `CREATE TABLE IF NOT EXISTS ...` so local re-runs are safe.
- ⛔ **Schema only** in `database/init/` — CREATE TABLE / INDEX statements, **no INSERT data rows**.
- Seed data goes in `database/seed/` (gitignored) and must be obviously fake data.

## Persistence (EFS mounted at /data)

Data must live under `/data/<subdir>` or it is **wiped on every deployment** (container-local dirs reset; the DB reinitializes as "empty").

PostgreSQL Dockerfile essentials:
```dockerfile
ENV PGDATA=/data/postgres
RUN mkdir -p /data/postgres && chown -R postgres:postgres /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD pg_isready -U postgres || exit 1
```

## Deployment Model

| What | Behavior |
|------|----------|
| `database/init/*.sql` | Runs once, first deploy only |
| Backend migrations | Run on every backend startup |
| Data on EFS `/data` | Persists across all deployments |
| DB container image | Rebuilt each deploy, but data dir survives on EFS |

Never rebuild the DB container to change schema, and never commit SQL dumps to git.

## Schema Changes After First Deploy = Backend Migrations

Add migration logic to the backend that runs on startup — use `snippets/config/db-migrations.js` (a `_migrations` table tracks applied migration names; each pending one runs once).

Migration rules:
- Always ADD new migrations — never edit or delete old ones; name sequentially (`001_`, `002_`, ...)
- Make them idempotent where possible (`IF NOT EXISTS`); test locally before deploying
- Never drop data columns without backup; never rename tables/columns (add new → migrate data → drop old)
- Rollback = a NEW migration that reverses the change
- Migrations must be backward-compatible — the new backend serves traffic immediately, and a failed migration blocks startup

Zero-downtime pattern for complex changes (one `git push` per phase):

| Phase | Action |
|-------|--------|
| 1 | Add new column (nullable or with default) |
| 2 | Update code to write to both old + new column |
| 3 | Backfill data old → new |
| 4 | Remove old-column usage from code |
| 5 | (Optional) drop old column via migration |

Local testing:
```bash
docker-compose down -v && docker-compose up --build   # fresh DB (simulates first deploy)
docker-compose restart backend                        # migration on existing data (simulates redeploy)
```

## Auto-Injected Env Vars (production, when database/Dockerfile exists)

`DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_URL` — no GitHub secret needed. Locally, set the same names in docker-compose (see `.platform-rules/scope-integration.md`).
