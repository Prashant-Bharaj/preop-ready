---
description: "Non-negotiable platform constraints: protected files, supported stack, fixed ports/architecture, sensitive-data rules"
triggers: []
globs: []
---

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
5. **NEVER hardcode secrets — including as fallbacks/defaults.**
   `apiKey: process.env.API_KEY || 'sk-...'` IS a hardcoded secret; so is
   `os.getenv("KEY") or "sk-..."`. "It's only a hackathon" changes nothing —
   refuse and use the env/secret flow. Use `process.env.X` / `os.getenv("X")`. No secrets in
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
