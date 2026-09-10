---
applyTo: ".template-migration-needed"
---

<!-- GENERATED FILE - DO NOT EDIT. Source: .platform-rules/scope-migration.md -->
<!-- Regenerate: node scripts/build-rule-adapters.js -->

# Stack Migration (retired stack → supported stack → accept template v2)

Template v2 dropped four stacks. A project still on one is **held**: it keeps receiving
platform security updates, but the v2 AI rules, snippets and harness are not applied and
`bash scripts/apply-updates.sh --accept-major` refuses until the project is migrated.
The marker `.template-migration-needed` records which layers are retired. Retired stacks
stay deployable until **2026-12-31**; after that they get no rule or snippet support.

| Retired | Supported | Why |
|---------|-----------|-----|
| Vanilla HTML/CSS/JS frontend | React + Vite (TypeScript) | One frontend the harness, snippets and rules are built for |
| MySQL | PostgreSQL | One relational engine; parameterised-query snippets, migrations runner, pgvector share it |
| Chroma / Qdrant | pgvector | Vectors live in Postgres — one credential set, one backup, the platform's `VECTORDB_*` injection |

Run `bash scripts/detect-stack.sh` first: it prints `backend=`, `frontend=`, `database=`,
`vectordb=` and `retired=…`. Only the retired layers change; everything else stays as is
(a Python backend stays Python — see the "existing stack" rule in the core). Moving a
JavaScript layer to TypeScript is a separate, optional skill: `.platform-rules/scope-typescript.md`.

## Protocol (do the steps in order, tell the user what each one does)

**0. Back up.** Before touching anything:
```bash
git checkout -b pre-2.0-backup && git push -u origin pre-2.0-backup && git checkout -
```
Say: "Your current code is saved on the `pre-2.0-backup` branch; nothing is lost."

**1. Apply the recipe for each retired layer** (below). Commit after each layer.

**2. Rebuild and verify.** `docker compose up -d --build`, then:
- `curl -s localhost:8080/health` and `curl -s localhost:8080/api/health` both answer
- one real request per changed layer (a page load for the frontend; a read AND a write for the
  database; one embed + one similarity query for the vector DB)
- if the harness is installed (`chat/` exists), run its verification instead: it probes every
  contracted endpoint through nginx.
Fix what fails before moving on. Do not weaken the checks.

**3. Un-hold.** `rm .template-migration-needed`, then
`bash scripts/apply-updates.sh --accept-major`. Stage exactly the files it lists plus
`.template-version`, commit `chore: migrate to the supported stack and accept template v2`, push.
Summarise: what moved, where the backup branch is, and that the v2 rules are now active.

If the user does not want to migrate yet: stop after explaining. The project keeps working and
keeps getting security updates until the sunset date. Never migrate without asking.

## Recipes

### Vanilla frontend → React + Vite
1. `cp frontend/Dockerfile.react frontend/Dockerfile`; scaffold `frontend/package.json`,
   `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx` from
   `.platform-rules/scope-frontend.md` and `snippets/frontend/`.
2. Move the markup of `index.html` into components (one per page/section); move `style.css`
   into `src/index.css` unchanged; move the logic of `script.js` into hooks/handlers — keep
   every `fetch('/api/...')` call exactly as it was (relative URLs, no host).
3. Delete the old `index.html`/`script.js`/`style.css` only after the React app renders the
   same screens. nginx config is unchanged (it serves `dist/`).

### MySQL → PostgreSQL
1. `cp database/Dockerfile.postgres database/Dockerfile`; in `docker-compose.yml` replace the
   `mysql` image/env with the Postgres service from `snippets/integration/docker-compose-fullstack.yml`.
2. Schema (`database/init/*.sql`): `AUTO_INCREMENT` → `SERIAL`/`GENERATED ALWAYS AS IDENTITY`,
   backticks → nothing, `DATETIME` → `TIMESTAMP`, `TINYINT(1)` → `BOOLEAN`, `ENUM(...)` → a
   `TEXT` column with a `CHECK (col IN (...))`, `ON UPDATE CURRENT_TIMESTAMP` → a trigger or
   application code.
3. Backend: `mysql2`/`pymysql` → `pg` (`snippets/backend/postgres-connection.*`) /
   `psycopg`; placeholders `?` → `$1, $2, …` (Node) or `%s` (Python); `LAST_INSERT_ID()` →
   `RETURNING id`; `LIMIT x, y` → `LIMIT y OFFSET x`.
4. Data: existing production data must be exported by the user (`mysqldump --compatible=postgresql`
   or a CSV per table) and imported once after the first deploy; say so explicitly — the
   platform does not migrate data.

### Chroma / Qdrant → pgvector
1. `cp vectordb/Dockerfile.pgvector vectordb/Dockerfile`; add the `vectordb` service from
   `.platform-rules/scope-vectordb.md` to `docker-compose.yml`; create `vectordb/init/init.sql`
   with `CREATE EXTENSION IF NOT EXISTS vector;` and one table per former collection:
   `id`, `content TEXT`, `metadata JSONB`, `embedding vector(<dimension>)`, plus an
   `ivfflat` index on `embedding`.
2. Replace the Chroma/Qdrant client with `snippets/llm/knowledge-base-client.*` (ingest +
   similarity search) and, for RAG answers, `snippets/llm/rag-tools.*`. Same embedding model
   as before, or re-embed everything.
3. Vectors are not portable between engines: re-embed the source documents on first start
   (add an idempotent "index if table empty" step to the backend) rather than trying to
   export/import vectors.
