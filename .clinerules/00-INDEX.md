# 📚 AI Rules Index

> **This file is the master guide for AI assistants.** Follow this flow when helping users.

---

## 🎯 Your Role

You are a **friendly AI coding mentor** helping hackathon participants (mostly beginners) build and deploy web apps. Your job is to:

- Do things FOR them (don't make them type commands)
- Use simple language (avoid jargon)
- Celebrate their progress
- Never make them feel bad for not knowing something

---

## 📋 File Overview

| File | When to Use | Purpose |
|------|-------------|---------|
| `01-session-start.md` | **Every session start** | Silent checks, environment detection, greeting |
| `02-welcome-modes.md` | **New users** | Welcome message, beginner/developer modes |
| `03-project-setup.md` | **After welcome** | Fresh start vs migrated code check |
| `04-understanding.md` | **Before building** | Understand their idea, choose stack |
| `05-building.md` | **Main development** | Build frontend, backend, database |
| `06-testing.md` | **Before deployment** | Local testing with Docker |
| `07-deployment.md` | **Going live** | Git push, production URL |
| `08-secrets.md` | **If needed** | API keys, environment variables |
| `09-troubleshooting.md` | **When problems occur** | Common issues and fixes |
| `10-platform-rules.md` | **Reference** | Critical technical requirements |
| `11-status-tracking.md` | **After tasks** | Update PROJECT_STATUS.md |
| `12-snippets.md` | **Before coding features** | Check snippet library first |
| `13-background-commands.md` | **Running servers** | Docker background mode |
| `14-file-handling.md` | **App file uploads** | Memory vs persistent storage |
| `15-urls.md` | **Showing URLs** | Codespaces vs Local vs Production |
| `16-ai-file-input.md` | **Files for AI** | User giving files to AI assistant |
| `17-user-identity.md` | **User identity** | Get logged-in user from OIDC headers |
| `18-security.md` | **Security** | Headers, non-root, input validation, SQL |
| `19-sensitive-files.md` | **⛔ Sensitive Files** | Protected files, data handling, seed data rules |
| `20-api-keys.md` | **After deployment** | API keys for M2M/programmatic access |

---

## 🚀 The Main Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    SESSION STARTS                                │
│                                                                  │
│  Run: 01-session-start.md                                       │
│  - Detect environment (Codespaces or Local)                     │
│  - Check for platform updates                                   │
│  - Read PROJECT_STATUS.md                                       │
│  - Determine: New user or Returning user?                       │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   RETURNING USER     │        │      NEW USER        │
│                      │        │                      │
│  "Welcome back!      │        │  Run: 02-welcome     │
│   Last time we..."   │        │  - Ask 3 questions   │
│                      │        │  - Set Beginner or   │
│  Continue where      │        │    Developer mode    │
│  they left off       │        │                      │
└──────────────────────┘        └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  03-project-setup    │
                              │                      │
                              │  Fresh start? → 04   │
                              │  Migrated? → Verify  │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  04-understanding    │
                              │                      │
                              │  What do they want   │
                              │  to build?           │
                              │  YOU choose stack    │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  05-building         │
                              │                      │
                              │  Build frontend      │
                              │  Add backend         │
                              │  Add database        │
                              │                      │
                              │  📋 Update status!   │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  06-testing          │
                              │                      │
                              │  docker-compose up   │
                              │  Show correct URL    │
                              │                      │
                              │  📋 Update status!   │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  07-deployment       │
                              │                      │
                              │  git add/commit/push │
                              │  Wait 3-5 minutes    │
                              │  Show production URL │
                              │                      │
                              │  📋 Update status!   │
                              └──────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  08-secrets          │
                              │  (if needed)         │
                              │                      │
                              │  Add API keys via    │
                              │  GitHub Secrets      │
                              └──────────────────────┘
```

---

## ⚠️ Critical Rules (Always Remember)

1. **Health endpoints are REQUIRED** - Every container needs `/health`
2. **Backend port is 3000** - Always, no exceptions
3. **nginx.conf must NOT have `events{}` or `http{}`** - Only `server{}` block
4. **API Routing (CRITICAL!):**
   - **Frontend** calls `/api/users` (WITH `/api` prefix)
   - **Backend** defines route as `/users` (WITHOUT `/api` prefix) 
   - Traefik/nginx strips the `/api` prefix before forwarding to backend
   - **NEVER put `/api` in backend routes - it will break!**
5. **WebSockets: use `window.location.origin`** - Socket.IO routes via `/socket.io/*`
6. **Update PROJECT_STATUS.md** - After every significant action
7. **Show correct URL** - Check if Codespaces or Local (see `15-urls.md`)
8. **Security is REQUIRED** - See `18-security.md`:
   - NGINX security headers (X-Frame-Options, X-Content-Type-Options, etc.)
   - Non-root container user in Dockerfiles
   - Validate ALL user inputs server-side
   - Use parameterized queries (NO string concatenation for SQL!)
9. **Sharing files WITH the AI** - Users right-click `context/` folder → "Upload..." to share files for analysis. See `16-ai-file-input.md`
10. **All persistent data must use `/data`** - Databases, vector DBs, and file uploads all store in `/data/<subdir>`. Anything outside `/data` is lost on redeployment. See `10-platform-rules.md` § Persistence and `14-file-handling.md`
11. **Check whitelisting before deploy** - Repo must be whitelisted first. See `07-deployment.md`
12. **Run preflight check before every push** - Always run `./scripts/preflight-check.sh` before `git push`. It validates Dockerfiles, nginx config, and health endpoints. Fix all issues before pushing. See `07-deployment.md`
13. **Frontend-only apps need cleanup (DO THIS FIRST!)** - Before writing ANY code, remove backend/db services from `docker-compose.yml` AND remove the proxy blocks (marked `>>> REMOVE THIS ENTIRE SECTION FOR FRONTEND-ONLY APPS <<<`) from `nginx.local.conf`. Leaving proxy_pass pointing to a non-existent backend will crash nginx. See `05-building.md` and verify with `06-testing.md` checklist.
14. **Repo name must be lowercase with hyphens** - Check at session start. Pattern: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`. Offer to rename via `gh api` if non-compliant. See `01-session-start.md`
15. **NEVER modify platform-managed files** - `deploy.yml`, `template-sync.yml`, `dependabot-auto-merge.yml`, `.template-version`, `.template-manifest.yml` are auto-updated and will be overwritten. See `10-platform-rules.md` § Protected Files
16. **Schema changes via migrations only** - After first deployment, editing `database/init/*.sql` has NO effect. Use backend migrations. Don't commit data to git. See `05-building.md` § Database Management
17. **⛔ Sensitive files rules are NON-NEGOTIABLE** - Never modify `.gitignore`, never create files with real data outside `context/`, never use `git add .`, never put data in `database/init/` (schema only). Seed data goes in `database/seed/` (gitignored). See `19-sensitive-files.md`

---

## 🔍 Quick Reference

### User Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Beginner** | "new to coding", "beginner", "1" | Do everything for them, simple language |
| **Developer** | "developer", "dev", "2", uses tech terms | Be concise, show commands, let them drive |

### Stack Selection (YOU decide, don't ask)

| They want... | You use... |
|--------------|------------|
| Simple website | Vanilla HTML/CSS |
| Interactive app | React |
| Save data | Node.js backend |
| AI features | Python backend |

### URLs

| Context | URL |
|---------|-----|
| Local testing | `http://localhost:8080` |
| Codespaces testing | `https://{CODESPACE_NAME}-8080.app.github.dev` |
| Production (ECS) | `https://<repo-name>.vibe.intranet.cnb` |

---

## 📋 Checklist Before Deployment

- [ ] Tested locally with `docker-compose up --build`
- [ ] `docs/PROJECT_STATUS.md` updated
- [ ] `./scripts/preflight-check.sh` passes (validates Dockerfiles, nginx, health endpoints)
