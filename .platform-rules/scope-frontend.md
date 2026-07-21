---
description: "Build or change the frontend: React+Vite or vanilla HTML served by nginx, the two-nginx-config model, UI libraries"
triggers: ["build the UI", "create the frontend", "make it look better", "add a page", "use React", "nginx won't start", "blank page", "date picker"]
globs: ["frontend/**"]
---

# Frontend Rules

Core rules (relative `/api` routing, ports 8080/3000, `/health`, security headers, secrets) are in `.platform-rules/01-common.md` — this file adds frontend depth only.

## Framework Choice

⛔ NO Next.js, Nuxt, Remix, or any server-side framework. The platform serves frontends via nginx as **static files only** — frameworks needing their own Node server fail on deploy. If a user asks for Next.js, offer React + Vite as the static-build alternative.

| Stack | When | Setup |
|-------|------|-------|
| Vanilla HTML/CSS/JS | Simple sites, forms, landing pages | `cp frontend/Dockerfile.vanilla frontend/Dockerfile` |
| React + Vite | Interactive apps, dashboards | `cp frontend/Dockerfile.react frontend/Dockerfile` |

- **Vanilla files:** `frontend/index.html`, `frontend/style.css`, optional `frontend/script.js`.
- **React files:** `frontend/package.json` (React + Vite), `frontend/vite.config.js`, `frontend/src/App.jsx`. Vite builds to static `/dist`, served by nginx.

## The Two nginx Configs (critical)

| File | Used by | API proxy? |
|------|---------|------------|
| `frontend/nginx.conf` | Production (ECS) | NO — Traefik routes `/api/*` and `/socket.io/*` |
| `frontend/nginx.local.conf` | Local dev (docker-compose volume mount) | YES — proxies to `backend:3000` |

**Why two files:** in production, containers run as separate ECS tasks — the `backend` hostname does not exist. A `proxy_pass http://backend:3000/` in `nginx.conf` makes nginx fail to start. So production nginx serves static files only; docker-compose mounts `nginx.local.conf` over `/etc/nginx/conf.d/default.conf` for local dev.

```
PRODUCTION (git push):        image bakes nginx.conf (no proxy) → Traefik routes /api/*
LOCAL (docker-compose up):    volume mount overrides with nginx.local.conf → proxy to backend:3000
```
No manual switching — the volume mount does it automatically.

**Rules for `nginx.conf` (production):**
- `server {}` block ONLY — ⛔ never `events {}` or `http {}` (file is included inside conf.d)
- ⛔ NEVER `proxy_pass` — this is the #1 cause of deployment failures
- Must keep: `/health` returning 200, security headers, SPA `try_files $uri $uri/ /index.html`, HTML no-cache + long-cache for hashed assets

**Rules for `nginx.local.conf` (local dev only):**
- Same as `nginx.conf` PLUS two proxy blocks:
  - `location /api/ { proxy_pass http://backend:3000/; ... }` — trailing `/` strips the `/api` prefix
  - `location /socket.io/ { proxy_pass http://backend:3000/socket.io/; ... }`
- Both proxy blocks need WebSocket headers: `proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`
- docker-compose MUST mount it: `./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro`

Complete copy-paste configs already exist in `frontend/nginx.conf` and `frontend/nginx.local.conf` — edit those in place, never rewrite from scratch.

## Frontend-Only Apps (no backend) — mandatory cleanup

1. **docker-compose.yml** — keep ONLY the `frontend` service. Delete `backend`/`db` services, `depends_on`, `networks`, and `volumes` blocks (keep the nginx.local.conf mount).
2. **nginx.local.conf** — must have NO proxy blocks: `cp frontend/nginx.conf frontend/nginx.local.conf` (identical for frontend-only). A leftover `proxy_pass` to `backend:3000` with no backend service means nginx fails to start.
3. **nginx.conf** — already correct as-is (no proxy blocks).

## API Calls from the Frontend

```javascript
fetch('/api/items')   // always relative, always with /api — never http://localhost:3000/... or absolute URLs
```
WebSockets: `io(window.location.origin)` — never a hardcoded host.

**Rendering API data:** never interpolate response values into `innerHTML` template literals —
use `textContent` (or `createElement` + `textContent`) for anything that came from a request.
Interpolated user/API data in `innerHTML` is an XSS hole.

## Design Principles

Clean layout with whitespace · modern subtle colors (no harsh primaries) · `border-radius: 8px` on buttons/cards · system or Google fonts · mobile-friendly at narrow widths · loading spinners and success/error feedback.

## Recommended Libraries

Use these when the feature is needed — keeps projects consistent with platform snippets.

### React

| Purpose | Library |
|---------|---------|
| Charts / dashboards | `recharts` |
| Complex charts | `chart.js` + `react-chartjs-2` |
| Data tables | `@tanstack/react-table` |
| Icons | `lucide-react` |
| Date picker | platform snippet `snippets/ui/datepicker-react.jsx` (no dep) |
| Form handling | `react-hook-form` |
| Animations | `framer-motion` |
| Toast notifications | `react-hot-toast` |
| Rich text editor | `@tiptap/react` |
| Markdown rendering | `react-markdown` |
| PDF generation | `@react-pdf/renderer` |
| Export to CSV/Excel | `exceljs` (`workbook.xlsx.writeBuffer()`) |
| Drag and drop | `@dnd-kit/core` |
| Syntax highlighting | `react-syntax-highlighter` |

### Vanilla JS

| Purpose | Library |
|---------|---------|
| Charts | `chart.js` |
| Animations | `gsap` |
| Date picker | platform snippet `snippets/ui/datepicker-vanilla.js` (no dep) |
| Drag and drop | `sortablejs` |

Avoid `jquery`, `moment.js`, full `lodash`, `d3` for simple charts — full avoid table in `.platform-rules/scope-backend.md`.

## Snippets (check before writing code)

| Need | Snippet |
|------|---------|
| Date picker / range picker (React) | `snippets/ui/datepicker-react.jsx` |
| Date picker / range picker (vanilla) | `snippets/ui/datepicker-vanilla.js` |
| Microsoft Graph from the browser (identity, SharePoint, calendar, mail) | `snippets/auth/graph-proxy-client.js` — read `snippets/auth/graph-proxy-operations.md` first |

Deployment, testing, and secrets depth: `.platform-rules/reference/*.md`.
