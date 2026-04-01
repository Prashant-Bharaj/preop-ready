# ⚠️ CRITICAL PLATFORM RULES

These rules MUST be followed or deployments will fail!

---

## 📁 Required Project Structure

```
your-repo/
├── frontend/              ← Required if you have a UI
│   ├── Dockerfile         ← MUST exist (copy from Dockerfile.vanilla or .react)
│   ├── nginx.conf         ← MUST exist (production - NO proxy_pass)
│   ├── nginx.local.conf   ← MUST exist (local dev - WITH proxy_pass)
│   └── [your frontend code]
│
├── backend/               ← Required if you have server logic
│   ├── Dockerfile         ← MUST exist (copy from Dockerfile.node or .python)
│   └── [your backend code]
│
├── database/              ← Optional (relational database)
│   ├── Dockerfile         ← MUST exist if using database (copy from templates)
│   └── init/
│       └── init.sql       ← Database initialization (for SQL databases)
│
├── vectordb/              ← Optional (vector database, independent from database/)
│   ├── Dockerfile         ← MUST exist if using vector DB (copy from templates)
│   └── init/
│       └── init.sql       ← Vector DB initialization (for pgvector)
│
├── docker-compose.yml     ← For local development (mounts nginx.local.conf)
└── .github/
    └── workflows/
        └── deploy.yml     ← Triggers deployment
```

---

## 🔒 Protected Files — Do Not Modify

### ⛔ NEVER Modify (Platform-Managed)

These files are managed by the platform and auto-updated via `template-sync.yml`. **AI assistants must NEVER edit these files.** They will be overwritten on the next template sync.

| File | Purpose |
|------|---------|
| `.github/workflows/deploy.yml` | Deployment pipeline — triggers on CodeQL completion |
| `.github/workflows/template-sync.yml` | Auto-update mechanism — syncs platform files |
| `.github/workflows/dependabot-auto-merge.yml` | Auto-merges patch/minor dependency updates |
| `.template-version` | Tracks current template version |
| `.template-manifest.yml` | Defines which files are synced |

**If user asks to modify one of these:**
```
That file is managed by the platform and will be overwritten on the
next template update. Let me help you find an alternative approach
that doesn't require changing it.
```

### ⚠️ Modify with EXTREME CARE

These files are critical for deployment. Follow the exact patterns documented below in this file.

| File | Rules |
|------|-------|
| `frontend/nginx.conf` | Production only — NO `events{}`, NO `http{}`, NO `proxy_pass`. See § NGINX below. |
| `frontend/nginx.local.conf` | Local dev — WITH `proxy_pass`. See § NGINX below. |
| `database/Dockerfile` | Must use EFS paths (`/data/postgres` or `/data/mysql`). See § Persistence below. |
| `vectordb/Dockerfile` | Must use EFS paths. See § Persistence below. |
| `docker-compose.yml` | Service names must match platform expectations (`frontend`, `backend`, `db`, `vectordb`). |

**If user wants to change these:** Always check the relevant section in this file first to ensure the change follows platform requirements.

---

### Database Templates Available (`database/`)
| Template | Use Case |
|----------|----------|
| `Dockerfile.postgres` | Standard SQL database (recommended) |
| `Dockerfile.mysql` | MySQL database |

### Vector Database Templates Available (`vectordb/`)
Use `vectordb/` for **all vector database needs** — whether standalone or alongside a relational `database/`.

| Template | Use Case |
|----------|----------|
| `Dockerfile.pgvector` | PostgreSQL with pgvector (vector extension enabled by default) |
| `Dockerfile.chroma` | ChromaDB vector database |
| `Dockerfile.qdrant` | Qdrant vector database |

**Dual-database setup:** `database/Dockerfile.postgres` + `vectordb/Dockerfile.chroma` gives you SQL + vector search as separate services.

### 💾 Database Data Persistence

**Data is NOT erased between deployments!** The platform mounts EFS at `/data` in each database container. All templates are pre-configured to store data there.

| Service | Data Directory | EFS Access Point |
|---------|---------------|-----------------|
| PostgreSQL (`database/`) | `/data/postgres` | `/projects/{project}/db-data` |
| MySQL (`database/`) | `/data/mysql` | `/projects/{project}/db-data` |
| pgvector (`vectordb/`) | `/data/postgres` | `/projects/{project}/vectordb-data` |
| ChromaDB (`vectordb/`) | `/data/chroma` | `/projects/{project}/vectordb-data` |
| Qdrant (`vectordb/`) | `/data/qdrant` | `/projects/{project}/vectordb-data` |
| App file uploads | `/data/uploads` | (backend EFS) |

⚠️ **Init scripts only run once!** Files in `database/init/` and `vectordb/init/` execute on **first deployment only**.

**For detailed Dockerfile examples and critical persistence configuration (CMD flags, PGDATA), see `05-building.md` § Database Persistence Requirements.**

---

## 🌐 NGINX Configuration

**THIS IS THE #1 CAUSE OF DEPLOYMENT FAILURES!**

The `nginx.conf` file is copied to `/etc/nginx/conf.d/default.conf` inside the container.
Files in `conf.d/` are INCLUDED inside nginx's main config, so they must ONLY contain server blocks.

### How It Works: Two Config Files

| File | Used By | Has API Proxy? |
|------|---------|----------------|
| `nginx.conf` | Production (ECS) | ❌ No - Traefik handles /api/* |
| `nginx.local.conf` | Local dev (docker-compose) | ✅ Yes - proxies to backend:3000 |

**Why two files?** In production, the `backend` hostname doesn't exist (containers are separate ECS tasks). If nginx.conf contains `proxy_pass http://backend:3000/`, nginx fails to start. The solution: production nginx only serves static files, local dev mounts a different config with proxy.

### ✅ nginx.conf (Production - static files only):

```nginx
# frontend/nginx.conf - PRODUCTION (deployed to ECS)
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # ============================================
    # SECURITY HEADERS - REQUIRED!
    # ============================================
    server_tokens off;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Health check endpoint (REQUIRED for deployment)
    location /health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    # Handle SPA routing (React, Vue, Angular)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Prevent caching of HTML files (critical for SPA deployments)
    location ~* \.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        add_header Expires "0";
    }

    # Cache static assets with hashed filenames (safe to cache long-term)
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### ✅ nginx.local.conf (Local development - with API proxy):

```nginx
# frontend/nginx.local.conf - LOCAL DEVELOPMENT ONLY
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # ============================================
    # SECURITY HEADERS - REQUIRED!
    # ============================================
    server_tokens off;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Health check endpoint
    location /health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    # Proxy API requests to backend (LOCAL only)
    location /api/ {
        proxy_pass http://backend:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
    }

    # Proxy Socket.IO/WebSocket requests (LOCAL only)
    location /socket.io/ {
        proxy_pass http://backend:3000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    # Handle SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache headers (same as production)
    location ~* \.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### ✅ docker-compose.yml (Mount local config):

```yaml
services:
  frontend:
    build: ./frontend
    ports:
      - "8080:8080"
    volumes:
      # Mount local nginx config with API proxy (production has no proxy)
      - ./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - backend
```

### How Automatic Selection Works

```
PRODUCTION (git push):
  1. Dockerfile runs: COPY nginx.conf /etc/nginx/conf.d/default.conf
  2. nginx.conf (NO proxy) is baked into image
  3. nginx starts successfully (no backend hostname to resolve)
  4. Traefik handles /api/* routing to backend

LOCAL DEV (docker-compose up):
  1. Dockerfile runs: COPY nginx.conf /etc/nginx/conf.d/default.conf
  2. docker-compose OVERRIDES it with volume mount
  3. nginx.local.conf (WITH proxy) is used instead
  4. nginx proxies /api/* to backend:3000 (Docker resolves hostname)
```

**Key points:**
- **No manual switching**: docker-compose volume mount automatically uses the local config
- **Production safe**: nginx.conf has no `backend` hostname reference
- **Local works**: nginx.local.conf proxies to backend:3000 via Docker DNS
- **HTML no-cache**: Browsers always fetch the latest `index.html` after deployments
- **Static assets cache**: JS/CSS with hashes (e.g., `app.abc123.js`) are safe to cache

### ❌ WRONG nginx.conf (WILL CRASH OR FAIL):

```nginx
events {           # ❌ NOT ALLOWED in conf.d files!
    worker_connections 1024;
}

http {             # ❌ NOT ALLOWED in conf.d files!
    server { ... }
}
```

### ⚠️ Never Put proxy_pass in Production nginx.conf!

In **production (ECS)**, `proxy_pass http://backend:3000/` **WON'T WORK** because:
- Containers run as separate ECS tasks with no shared network
- There's no `backend` hostname - nginx fails to start
- Traefik handles all routing to the backend

**The production nginx.conf should ONLY serve static files.** Keep proxy_pass in nginx.local.conf only.

### ⚠️ Frontend-Only Apps (No Backend)

For **frontend-only** projects:
- **Production `nginx.conf`**: Already correct — no proxy_pass, serves static files only ✅
- **Local `nginx.local.conf`**: Must NOT have `proxy_pass` blocks. Copy `nginx.conf` as `nginx.local.conf` (they're identical for frontend-only).
- **`docker-compose.yml`**: Must NOT reference a `backend` service. Remove `depends_on: backend` from the frontend service, and delete the backend/db service blocks entirely.

If you leave proxy_pass blocks pointing to `http://backend:3000/` with no backend service, nginx will fail to resolve the hostname and won't start.

---

## 🔌 Port Requirements

| Component | Port | Notes |
|-----------|------|-------|
| Frontend  | **8080** | nginx listens on port 8080 inside container (non-root compatible) |
| Backend   | **3000** | Express/FastAPI MUST listen on port 3000 |

**Backend example (Node.js):**
```javascript
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

**Backend example (Python FastAPI):**
```python
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3000)
```

---

## ❤️ Health Check Endpoints (REQUIRED!)

Every container MUST have a health endpoint or deployment will fail!

### Frontend Health Check

In `nginx.conf`:
```nginx
location /health {
    return 200 'OK';
    add_header Content-Type text/plain;
}
```

### Backend Health Check

**Node.js/Express:**
```javascript
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
```

**Python/FastAPI:**
```python
@app.get("/health")
def health():
    return {"status": "ok"}
```

**Python/Flask:**
```python
@app.route('/health')
def health():
    return jsonify({"status": "ok"})
```

---

## 🔀 API Routing (Traefik)

In production, Traefik routes traffic like this:

- `https://<repo-name>.vibe.intranet.cnb/` → Frontend container (port 8080)
- `https://<repo-name>.vibe.intranet.cnb/api/*` → Backend container (port 3000)
- `https://<repo-name>.vibe.intranet.cnb/socket.io/*` → Backend container (WebSocket)

### 🔌 WebSocket Support (Socket.IO)

WebSocket routing is **automatically enabled** for all projects. If your backend uses Socket.IO:

```javascript
// Backend - Socket.IO setup
const { Server } = require('socket.io');
const io = new Server(httpServer, {
  cors: { origin: '*' }
});
```

```javascript
// Frontend - Connect to same origin (Traefik handles routing)
import { io } from 'socket.io-client';
const socket = io(window.location.origin);  // ✅ Works in production
```

**Important:** In production with Traefik, the frontend should NOT try to proxy WebSocket connections through nginx. The frontend nginx.conf should only serve static files - Traefik routes `/socket.io/*` directly to the backend.

### ⚠️ IMPORTANT: The `/api` prefix is STRIPPED!

**How it works**: Traefik uses `stripprefix` middleware in production; nginx.local.conf uses trailing `/` in `proxy_pass http://backend:3000/` to strip locally.

- Request: `GET /api/users` → Backend receives: `GET /users`
- Request: `POST /api/data` → Backend receives: `POST /data`
- Request: `GET /api/health` → Backend receives: `GET /health`

### Frontend API Calls

Always use relative URLs starting with `/api`:

```javascript
// ✅ Correct - works in both local dev and production
fetch('/api/users')
fetch('/api/data', { method: 'POST', body: JSON.stringify(data) })

// ❌ Wrong - hardcoded URL won't work in different environments
fetch('http://localhost:3000/users')
fetch('https://myapp.example.com/api/users')
```

### Backend Route Definitions

Define routes WITHOUT the `/api` prefix:

```javascript
// Node.js/Express - CORRECT
app.get('/users', (req, res) => { ... });      // Accessed via /api/users
app.get('/health', (req, res) => { ... });     // Accessed via /api/health
app.post('/data', (req, res) => { ... });      // Accessed via /api/data

// ❌ WRONG - don't include /api in routes
app.get('/api/users', (req, res) => { ... });  // Would need /api/api/users to access!
```

---

## 🐳 Docker Compose for Local Development

Your `docker-compose.yml` must mount the local nginx config:

```yaml
version: '3.8'

services:
  frontend:
    build: ./frontend
    ports:
      - "8080:8080"
    volumes:
      # IMPORTANT: Mount local nginx config with API proxy
      # Production nginx.conf has no proxy (Traefik handles it)
      - ./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - backend

  backend:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - PORT=3000
      - DATABASE_HOST=database
      - DATABASE_NAME=myapp
      - DATABASE_USER=myapp_user
      - DATABASE_PASSWORD=localdev123
    depends_on:
      - database

  # Optional database (same pattern: build from Dockerfile)
  database:
    build: ./database
    environment:
      # For PostgreSQL:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp_user
      POSTGRES_PASSWORD: localdev123
      # For MySQL (if using Dockerfile.mysql):
      # MYSQL_DATABASE: myapp
      # MYSQL_USER: myapp_user
      # MYSQL_PASSWORD: localdev123
      # MYSQL_ROOT_PASSWORD: localdev123
    volumes:
      - db-data:/data

  # Optional vector database (independent from database/)
  # vectordb:
  #   build: ./vectordb
  #   environment:
  #     # For pgvector:
  #     POSTGRES_DB: vectors
  #     POSTGRES_USER: vectordb_user
  #     POSTGRES_PASSWORD: localdev123
  #   volumes:
  #     - vectordb-data:/data

volumes:
  db-data:
  # vectordb-data:
```

**⚠️ CRITICAL: The nginx.local.conf volume mount is required!** Without it, local API calls will fail because the production nginx.conf doesn't have proxy_pass.

**Local URLs:**
- Frontend: http://localhost:8080
- Backend: http://localhost:3000
- API via frontend proxy: http://localhost:8080/api/*

**For vector databases (Chroma, Qdrant):** No environment variables needed, just build and connect.

---

## 🔐 Environment Variables

### Local Development

Create `backend/.env` for local development (gitignored, stays private):
```bash
cat > backend/.env << 'EOF'
# Local development secrets — this file is gitignored
OPENAI_KEY=
API_KEY=
API_SECRET=
JWT_SECRET=
SECRET_1=
SECRET_2=
SECRET_3=
EOF
```

### Production (Deployed)

Add secrets in GitHub:
1. Go to repo → Settings → Secrets → Actions
2. Add secrets with `APP_` prefix

⚠️ **CRITICAL: The `APP_` prefix is stripped when injected into containers!**

⚠️ **This is a FIXED list of exactly 10 secrets. Users CANNOT add custom secret names — only these are passed through the deployment workflow.**

| # | GitHub Secret | Available in Code As | Common Use |
|---|---------------|---------------------|------------|
| 1 | `APP_OPENAI_KEY` | `process.env.OPENAI_KEY` | OpenAI / LLM API key |
| 2 | `APP_DATABASE_URL` | `process.env.DATABASE_URL` | Custom database connection string |
| 3 | `APP_API_KEY` | `process.env.API_KEY` | Generic API key |
| 4 | `APP_API_SECRET` | `process.env.API_SECRET` | API secret |
| 5 | `APP_JWT_SECRET` | `process.env.JWT_SECRET` | JWT signing key |
| 6 | `APP_WEBHOOK_SECRET` | `process.env.WEBHOOK_SECRET` | Webhook validation secret |
| 7 | `APP_ENCRYPTION_KEY` | `process.env.ENCRYPTION_KEY` | Data encryption key |
| 8 | `APP_SECRET_1` | `process.env.SECRET_1` | Custom secret (e.g., password) |
| 9 | `APP_SECRET_2` | `process.env.SECRET_2` | Custom secret (e.g., username) |
| 10 | `APP_SECRET_3` | `process.env.SECRET_3` | Custom secret (e.g., admin email) |

### Auto-Injected Database Credentials

⚠️ **If `database/Dockerfile` exists, these are auto-injected (NO GitHub secret needed):**

| Environment Variable | Description |
|---------------------|-------------|
| `DATABASE_HOST` | Internal hostname (e.g., `myapp-db.vibe.local`) |
| `DATABASE_NAME` | Database name (derived from repo name) |
| `DATABASE_USER` | Auto-generated username |
| `DATABASE_PASSWORD` | Auto-generated password |
| `DATABASE_URL` | Full connection string |

### Auto-Injected Vector Database Credentials

⚠️ **If `vectordb/Dockerfile` exists, these are auto-injected (NO GitHub secret needed):**

| Environment Variable | Description |
|---------------------|-------------|
| `VECTORDB_HOST` | Internal hostname (e.g., `myapp-vectordb.vibe.local`) |
| `VECTORDB_PORT` | Port (5432 for pgvector, 6333 for Qdrant, 8000 for Chroma) |
| `VECTORDB_NAME` | Database name (pgvector only) |
| `VECTORDB_USER` | Auto-generated username (pgvector only) |
| `VECTORDB_PASSWORD` | Auto-generated password (pgvector only) |

### Code Pattern for Secrets

When migrating apps, support both local env vars AND platform secrets:

```javascript
// Helper to check multiple env var names
const getEnv = (primary, fallback) => 
  process.env[primary] || (fallback ? process.env[fallback] : undefined);

// Usage
const username = getEnv('MY_API_USERNAME', 'SECRET_2');
const password = getEnv('MY_API_PASSWORD', 'SECRET_1');
```

**See `08-secrets.md` for detailed examples.**

---

## 📋 Pre-Deployment Checklist

Before deploying, verify ALL of these:

### Structure
- [ ] `frontend/Dockerfile` exists (if frontend)
- [ ] `frontend/nginx.conf` exists (if frontend) - NO proxy_pass!
- [ ] `frontend/nginx.local.conf` exists (if frontend) - WITH proxy_pass
- [ ] `docker-compose.yml` mounts nginx.local.conf
- [ ] `backend/Dockerfile` exists (if backend)
- [ ] `database/Dockerfile` exists (if database)
- [ ] `.github/workflows/deploy.yml` exists

### Health Checks
- [ ] Frontend has `/health` endpoint (in nginx.conf)
- [ ] Backend has `/health` endpoint returning JSON
- [ ] Database Dockerfile has HEALTHCHECK instruction

### Ports
- [ ] Frontend nginx listens on port 8080
- [ ] Backend listens on port 3000

### API Routes
- [ ] Frontend calls `/api/*` (not direct backend URLs)
- [ ] Backend routes don't include `/api` prefix

### Database (if used)
- [ ] Copied template to `database/Dockerfile`
- [ ] Backend has `DATABASE_HOST` env var configured
- [ ] For SQL: `database/init/init.sql` has schema

### Vector Database (if used)
- [ ] Copied template to `vectordb/Dockerfile`
- [ ] Backend has `VECTORDB_HOST` env var configured
- [ ] For pgvector: `vectordb/init/init.sql` has `CREATE EXTENSION vector`

### 🔒 Security (REQUIRED) — See `18-security.md` for full details
- [ ] nginx.conf has security headers (`server_tokens off`, X-Frame-Options, etc.)
- [ ] Dockerfiles run as non-root user (`USER appuser`)
- [ ] All user inputs validated server-side
- [ ] Database queries use parameterized statements (NO string concatenation!)
- [ ] No hardcoded secrets in code

### Local Test
- [ ] `docker-compose up --build` works
- [ ] Frontend loads at http://localhost:8080
- [ ] Backend health at http://localhost:3000/health returns 200
- [ ] API calls work through frontend
- [ ] Database connection works (if used)

---

## 🔄 Removing a Segment

Segments (frontend, backend, database, vectordb) are **optional and independent**. Users can add or remove them at any time. The presence of a `Dockerfile` in the segment's directory is what triggers deployment — the directory itself can exist without causing issues.

### How to Remove Each Segment

**Remove Frontend** (backend-only deployment):
1. Delete `frontend/Dockerfile` (keep template Dockerfiles for reference)
2. Remove the `frontend:` service from `docker-compose.yml`
3. Remove any `nginx.local.conf` volume mount from docker-compose.yml
4. Run `./scripts/preflight-check.sh` to verify

**Remove Backend** (static frontend-only):
1. Delete `backend/Dockerfile`
2. Remove the `backend:` service from `docker-compose.yml`
3. Remove `nginx.local.conf` proxy config if exists (no backend to proxy to)
4. Run `./scripts/preflight-check.sh` to verify

**Remove Database:**
1. Delete `database/Dockerfile`
2. Remove the `db:` / `database:` service from `docker-compose.yml`
3. Remove `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` env vars from backend service in docker-compose.yml
4. Run `./scripts/preflight-check.sh` to verify

**Remove Vector Database:**
1. Delete `vectordb/Dockerfile`
2. Remove the `vectordb:` service from `docker-compose.yml`
3. Remove `VECTORDB_HOST`, `VECTORDB_PORT` env vars from backend service in docker-compose.yml
4. Run `./scripts/preflight-check.sh` to verify

### What Happens During Deployment After Removal

The platform **automatically cleans up** orphaned services:
- **Deleted:** ECS service (stopped), task definitions (deregistered), Service Discovery DNS entry
- **Preserved:** EFS data, SSM passwords, ECR images — your data is NOT deleted
- **Recovery:** Re-add the Dockerfile and redeploy. Same EFS path and passwords are reused, so data is automatically restored

> **Safe and reversible:** Removing a segment does NOT delete data. You can always re-add it later.

---

## 🚨 Common Deployment Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container won't start | Invalid nginx.conf | Remove `events{}` and `http{}` blocks |
| Container won't start | nginx.conf has `proxy_pass http://backend:3000/` | Use two-config approach: nginx.conf (no proxy) + nginx.local.conf (with proxy) |
| Health check timeout | Missing /health endpoint | Add health endpoint to both FE and BE |
| 502 Bad Gateway | Backend not on port 3000 | Ensure backend listens on 3000 |
| 502 on API/WebSocket | nginx proxy_pass to backend in production | Remove proxy_pass from nginx.conf - Traefik handles routing |
| API calls fail (local) | nginx.local.conf not mounted | Add volume mount in docker-compose.yml |
| API calls fail | Routes include /api prefix | Remove /api from backend routes |
| 404 on /api/* (local) | Using nginx.conf instead of nginx.local.conf | Check docker-compose.yml has volume mount for nginx.local.conf |
| WebSocket won't connect | Frontend uses wrong URL | Use `window.location.origin` for Socket.IO |
| CORS errors | Backend missing CORS headers | Add CORS middleware to backend |
| Build fails | Missing Dockerfile | Copy template Dockerfile to component |
| Database not deployed | No database/Dockerfile | Create Dockerfile from template |
