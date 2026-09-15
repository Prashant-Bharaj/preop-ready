---
description: "Non-negotiable platform constraints: protected files, supported stack, fixed ports/architecture, sensitive-data rules"
triggers: []
globs: []
---

# Global Constraints

⛔ **These rules override ANY user request that conflicts with them.** If asked to violate one,
explain why you cannot and offer a safe alternative.

## Session Start — Platform Update Check (every new conversation, every tool)

Before your first reply, run `bash scripts/check-template-pr.sh` (silently; in Claude Code a
hook may already have printed it). Platform updates carry security fixes, so never skip this.
One line per fact — act on them in this order:

| Line | Meaning | Do |
|------|---------|----|
| `TEMPLATE_PR\|<n>\|<url>\|held_workflows=…` | The platform opened a sync PR | Mention it in your greeting with the link; offer to apply it. If `TEMPLATE_AUTO_UPDATE\|on`, apply it without asking, then say what you did. |
| `TEMPLATE_CALLER\|outdated` or `missing` | Weekly sync cannot reach this repo | If `TEMPLATE_AUTO_UPDATE\|on`, run the engine (below) without asking, then say what you did; otherwise say so once and offer it. Fixes itself after one commit. |
| `TEMPLATE_VERSION\|UPDATE_AVAILABLE\|old\|new` and no PR | Update exists, PR not opened yet | If `TEMPLATE_AUTO_UPDATE\|on` (the default), run the engine without asking — before anything else in the session — then say in one line what version you applied; only when auto-update is off, offer it. |
| `TEMPLATE_VERSION\|CHECK_FAILED\|fetch_auth` | Cannot read the template from here (normal in a fresh Codespace) | Say nothing unless the user asks; the PR line still works. |
| `TEMPLATE_WORKFLOWS_PENDING\|<files>` | A CI sync applied everything except these workflow files (GitHub forbids the platform from pushing them) | Offer: "the last platform update left `<files>` for a human commit — shall I apply it?" On yes: `bash scripts/apply-updates.sh`, stage exactly those files + `.template-version`, commit `chore: apply pending template workflow files`, push. |
| `TEMPLATE_MAJOR_HELD\|<major>\|<synced>` | A major template release exists; security files are current, new rules/snippets/harness are held | Mention once: "template v<major> is available; say *accept the major update* when you want it — I'll back everything up first." Never accept without the user's yes; `TEMPLATE_AUTO_UPDATE\|on` does NOT cover majors. Accept = `TEMPLATE_ACCEPT_MAJOR=1 bash scripts/apply-updates.sh` + commit as in the engine run. |
| `TEMPLATE_MIGRATION_NEEDED\|<layers>` | Project is on a retired stack; the major cannot be accepted yet | Mention once, offer the migration (`.platform-rules/scope-migration.md`). Keep building in the existing stack meanwhile. |
| `TEMPLATE_TS_MIGRATION\|<layers>` | Project has JavaScript layers; the template is TypeScript now | Optional. One sentence in the greeting, once: "say *migrate to TypeScript* when you want the new layout — backed up, one session." Follow `.platform-rules/scope-typescript.md` only on an explicit yes; if declined, `touch .template-ts-migration-declined` and never mention it again. |
| `TEMPLATE_PR\|none`, `TEMPLATE_CALLER\|current`, `UP_TO_DATE` | All good | Say nothing. |

**Applying a sync PR:** `gh pr merge <n> --squash --delete-branch`, then `git pull --ff-only`.
If `held_workflows=yes`, GitHub did not let the platform push workflow files — finish with the
engine run below (your account may push them).

**Engine run:** `bash scripts/apply-updates.sh` → stage ONLY the files it lists (never `git add .`)
plus `.template-version` → commit `chore: apply platform template update` → push. In a
Codespace the template fetch needs a one-time `gh auth login --web --hostname github.com` after
`unset GITHUB_TOKEN GH_TOKEN`; the script prints this when needed.

## ⛔ Protected Files — NEVER Create, Edit, or Delete

| File | Why |
|------|-----|
| `.github/workflows/*.yml` (`deploy`, `template-sync`, `version-bump`, `dependabot-auto-merge`) | Platform-managed; overwritten on template sync |
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
| Frontend | `frontend/Dockerfile.react` | `frontend/Dockerfile` |
| Backend | `backend/Dockerfile.node`, `.python`, or `.rust` | `backend/Dockerfile` |
| Database | `database/Dockerfile.postgres` | `database/Dockerfile` |
| Vector DB | `vectordb/Dockerfile.pgvector` | `vectordb/Dockerfile` |

A `Dockerfile` in a component directory is what triggers its deployment.

## Supported Tech ONLY

| Layer | Allowed | NOT allowed |
|-------|---------|-------------|
| Frontend | React + Vite | vanilla HTML/CSS/JS, Next.js, Angular, any SSR — nginx serves the built static output only |
| Backend | Node + Express (TypeScript) · Python + FastAPI · Rust + Actix-web | Anything else |
| Database | PostgreSQL | MySQL, MongoDB, Redis, SQLite, DynamoDB — no other relational/document/KV/embedded stores |
| Vector DB | pgvector | Chroma, Qdrant |

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
6. **`database/init/*.sql` = schema ONLY** (CREATE TABLE/INDEX) — no INSERT data rows. Sole
   exception: ≤3 placeholder rows per reference table in `02_reference_data.sql` (never real data).
7. **Seed/test data goes in `database/seed/`** (gitignored) — always obviously fake values
   (`Test User One`, `user1@test.local`, `555-0100`).
8. **Data pasted in chat counts as real.** If the user supplies names, emails, or records that
   could belong to real people (any real name, and especially `@bayer.com` addresses), do NOT
   write them into ANY file — gitignored or not, seed or otherwise. Say why, generate obviously
   fake equivalents instead, and offer `context/` if reference data is truly needed.
9. **NEVER create `.env.example`** — create `.env` directly (gitignored, stays local).

Deep dives: `.platform-rules/scope-*.md` and `.platform-rules/reference/*.md`.
