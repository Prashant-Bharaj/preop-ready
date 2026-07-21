---
description: "Deploy the app to production via git push, verify readiness, and handle deploy failures"
triggers: ["deploy", "go live", "push", "production", "is my site live", "make it live", "publish"]
globs: []
---

# Deployment (AWS ECS via git push)

Deployment needs at least a `frontend/Dockerfile` or `backend/Dockerfile`. Production URL: `https://<repo-name>.vibe.intranet.cnb` (Bayer VPN required).

## 1. Whitelisting Check (BEFORE any deploy commands)

```bash
gh run list --workflow=deploy.yml --status=success --limit=1 --json conclusion --jq 'length'
```

- `1`+ → has deployed before → whitelisted, proceed.
- `0` or error → likely NOT whitelisted → **STOP**. Tell the user: one-time setup — contact a platform admin with the repo name (e.g. `bayer-int/your-repo`), they add it to the whitelist (~5 min). Do NOT push until confirmed; it fails with "Unauthorized repository".
- No `gh` available → ask the user "Has this repo been deployed before?"

## 2. Preflight Check (MANDATORY before EVERY push)

```bash
./scripts/preflight-check.sh
```

If it fails, fix the reported issues before proceeding. Never skip.

## 3. Push to Deploy

Add specific files by name — **never `git add .`** (protected-files rule in the always-on core):

```bash
git add <changed files>
git commit -m "feat: description"
git push
```

Then: deployment takes **3–5 minutes**; progress is under GitHub repo → Actions tab. When done: "Your app is live at `https://<repo-name>.vibe.intranet.cnb` (Bayer VPN needed) — share it with your team!" Updates use the same flow: change code, preflight, push again.

## Pre-Deployment Checklist (condensed)

- **Structure:** `frontend/Dockerfile` + `nginx.conf` (NO proxy_pass) + `nginx.local.conf` (WITH proxy_pass, mounted in docker-compose) if frontend; `backend/Dockerfile` if backend; `database/Dockerfile` if DB; `.github/workflows/deploy.yml` present
- **Health:** `/health` in nginx.conf; backend `/health` returns JSON; database Dockerfile has HEALTHCHECK
- **Ports / API routes / security musts:** per always-on core (frontend 8080, backend 3000, no `/api` prefix in backend routes, headers, non-root, parameterized SQL)
- **Database:** template Dockerfile copied; backend has `DATABASE_HOST`; schema in `database/init/init.sql`. Vectordb: `VECTORDB_HOST`; pgvector needs `CREATE EXTENSION vector`
- **Local test passed:** `docker-compose up --build` works, frontend at :8080, `:3000/health` returns 200, API calls work through frontend
- **Fits production resources:** each ECS task is 0.5 vCPU / 1 GB RAM / 1 GB storage (frontend+backend share one task; database and vectordb each get their own). No memory-hungry dependencies, bounded file processing, no in-process ML models. Symptom of oversizing: container restarts / health-check flaps under load.

## Common Deployment Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Unauthorized repository | Not whitelisted | Add repo to `github_allowed_deploy_repos` in infra repo's `variables.tf` |
| Container won't start | Invalid nginx.conf | Remove `events{}`/`http{}` blocks; no `proxy_pass` in nginx.conf (use nginx.local.conf for local proxy) |
| Health check timeout / failed | Missing `/health` | Add health endpoint to frontend AND backend |
| 502 Bad Gateway | Backend not on port 3000 | Listen on 3000 |
| 502 on API/WebSocket | proxy_pass in production nginx.conf | Remove it — Traefik handles routing |
| API calls fail | Backend routes have `/api` prefix | Remove `/api` from backend routes |
| 404 on `/api/*` (local) | nginx.local.conf not mounted | Add the volume mount in docker-compose.yml |
| WebSocket won't connect | Wrong frontend URL | Use `window.location.origin` for Socket.IO |
| Build failed | Code/syntax error | Read Actions log, fix it |
| npm ci failed | Missing package-lock.json | Run `npm install` to create it |
| Push rejected | Behind remote | `git pull --rebase && git push` |
| No deployable content / DB not deployed | Missing Dockerfile | Copy the template Dockerfile into the segment |

If deployment fails, stay calm for the user: check the Actions log, explain simply, fix it yourself.

## Removing a Segment

Segments (frontend, backend, database, vectordb) are optional and independent — the segment's `Dockerfile` is what triggers deployment. To remove one:

1. Delete `<segment>/Dockerfile` (keep template Dockerfiles for reference)
2. Remove its service from `docker-compose.yml` (frontend: also the `nginx.local.conf` mount; backend: also proxy config; database: also `DATABASE_*` env vars on backend; vectordb: also `VECTORDB_*` env vars)
3. Run `./scripts/preflight-check.sh`

Safe and reversible: the platform auto-removes the ECS service/task defs/DNS but **preserves EFS data, SSM passwords, and ECR images**. Re-add the Dockerfile and redeploy to restore with the same data.

## Afterwards

Update `docs/PROJECT_STATUS.md` after success OR failure: deployment status, production URL, date, error if any — see `.platform-rules/reference/status-tracking.md`.
