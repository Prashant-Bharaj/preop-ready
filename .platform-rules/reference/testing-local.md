---
description: "Run and test the app locally with Docker, set up hot reload, and show the user the right URL"
triggers: ["run it", "test", "start the app", "docker", "hot reload", "which URL", "test locally", "see my app"]
globs: []
---

# Local Testing

## Before Every `docker-compose up`

Verify docker-compose services, `nginx.local.conf` proxy blocks, and `nginx.conf` match the chosen architecture (frontend-only vs backend vs full-stack) — full matrix in `.platform-rules/scope-integration.md`. Key crash causes: `proxy_pass` to a non-existent backend service, or ANY `proxy_pass` in production `nginx.conf` (Traefik routes the API, not nginx).

## Standard Workflow

Check first, then start in background so the user can keep prompting:

```bash
docker-compose ps                 # already running? don't start again
docker-compose up -d --build      # start detached
docker-compose logs -f            # follow logs
docker-compose down               # stop (add -v to also remove volumes)
docker-compose restart            # restart
```

**Rebuild rule:** when verifying a fix, after changing dependencies (`package.json`,
`requirements.txt`) or a `Dockerfile`, or whenever changes don't show up in the running app,
force a clean rebuild — Docker's layer cache otherwise serves stale code:

```bash
docker-compose build --no-cache && docker-compose up -d
```

In beginner mode, RUN these yourself — "Let's test your app before making it live! Want me to start it?" First build takes 1–2 minutes; wait for "ready"/"Server running on port 3000" messages.

## Background vs Foreground

| Background | Foreground |
|------------|------------|
| `docker-compose up -d` (server keeps running) | `npm install` (must finish before next step) |
| `npm run dev` / `npm run watch` (`nohup ... &`) | `git` commands (quick, need result) |
| Long-running builds | `docker build`, tests, `./scripts/preflight-check.sh` (need to see the result) |

## Hot Reload

- **Vite/React:** built-in — keep `npm run dev` running, edits in `frontend/src/` appear automatically.
- **Node backend:** run `npm run dev` (`tsc --watch`) alongside `node --watch dist/index.js` to restart on rebuild; `npm start` (`node dist/index.js`) for production.
- **Docker:** mount source and protect node_modules, run the dev script:

```yaml
services:
  backend:
    build: ./backend
    volumes:
      - ./backend:/app
      - /app/node_modules
    command: npm run dev
  # frontend: same pattern with ./frontend:/app, port 8080
```

## Which URL to Show

Detect the environment before showing any URL:

```bash
if [ -n "$CODESPACES" ]; then echo "CODESPACES: $CODESPACE_NAME"; else echo "LOCAL"; fi
```

| User action | URL to show |
|-------------|-------------|
| "Start my app" / "Test locally" (Local) | `http://localhost:8080` |
| "Start my app" / "Test locally" (Codespaces) | `https://{CODESPACE_NAME}-8080.app.github.dev` |
| "Deploy" / "Make it live" (after `git push`) | `https://<repo-name>.vibe.intranet.cnb` (Bayer VPN required) |
| "What's my app URL?" | Ask: local testing or deployed version? |

Codespaces URL not loading → Ports tab (bottom panel) → port 8080 → globe icon; if "Private", make it Public/org-visible. Local not loading → Docker not running. "Connection refused" → wrong port (frontend 8080, backend 3000).

## Before Calling It Tested

- Frontend loads at the environment-appropriate URL, no console errors
- `http://localhost:3000/health` returns 200
- Main features work; mobile view okay (resize the window)

Encourage iteration ("Make the button bigger" → update → refresh). Errors: ask them to paste the message, or check browser console / `docker-compose ps` / logs yourself. Stop = Ctrl+C (foreground) or `docker-compose down`.

## Afterwards

Update `docs/PROJECT_STATUS.md`: mark local testing complete, note issues, set next step (usually deploy) — see `.platform-rules/reference/status-tracking.md`.
