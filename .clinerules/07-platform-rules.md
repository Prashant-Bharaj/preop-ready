# ⚠️ CRITICAL PLATFORM RULES

These rules MUST be followed or deployments will fail!

---

## 📁 Required Project Structure

```
your-repo/
├── frontend/              ← Required if you have a UI
│   ├── Dockerfile         ← MUST exist (copy from Dockerfile.vanilla or .react)
│   ├── nginx.conf         ← MUST exist
│   └── [your frontend code]
│
├── backend/               ← Required if you have server logic
│   ├── Dockerfile         ← MUST exist (copy from Dockerfile.node or .python)
│   └── [your backend code]
│
├── database/              ← Optional
│   ├── Dockerfile         ← MUST exist if using database (copy from templates)
│   └── init/
│       └── init.sql       ← Database initialization (for SQL databases)
│
├── docker-compose.yml     ← For local development
└── .github/
    └── workflows/
        └── deploy.yml     ← Triggers deployment
```

### Database Templates Available
| Template | Use Case |
|----------|----------|
| `Dockerfile.postgres` | Standard SQL database (recommended) |
| `Dockerfile.mysql` | MySQL database |
| `Dockerfile.pgvector` | PostgreSQL with vector search (AI apps) |
| `Dockerfile.chroma` | ChromaDB vector database |
| `Dockerfile.qdrant` | Qdrant vector database |

---

## 🌐 NGINX Configuration

**THIS IS THE #1 CAUSE OF DEPLOYMENT FAILURES!**

The `nginx.conf` file is copied to `/etc/nginx/conf.d/default.conf` inside the container.
Files in `conf.d/` are INCLUDED inside nginx's main config, so they must ONLY contain server blocks.

### ✅ CORRECT nginx.conf:

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }
}
```

### ❌ WRONG nginx.conf (WILL CRASH THE CONTAINER):

```nginx
events {           # ❌ NOT ALLOWED in conf.d files!
    worker_connections 1024;
}

http {             # ❌ NOT ALLOWED in conf.d files!
    server { ... }
}
```

---

## 🔌 Port Requirements

| Component | Port | Notes |
|-----------|------|-------|
| Frontend  | **80** | nginx listens on port 80 inside container |
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

- `https://<repo-name>.vibe.demo.bfrg.de/` → Frontend container (port 80)
- `https://<repo-name>.vibe.demo.bfrg.de/api/*` → Backend container (port 3000)

### ⚠️ IMPORTANT: The `/api` prefix is STRIPPED!

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

Your `docker-compose.yml` should mirror production routing:

```yaml
version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "8080:80"
    depends_on:
      - backend

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
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
    build:
      context: ./database
      dockerfile: Dockerfile
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

volumes:
  db-data:
```

**Local URLs:**
- Frontend: http://localhost:8080
- Backend: http://localhost:3000
- API via frontend proxy: http://localhost:8080/api/*

**For vector databases (Chroma, Qdrant):** No environment variables needed, just build and connect.

---

## 🔐 Environment Variables

### Local Development

Create `backend/.env` from `backend/env.example`:
```bash
cp backend/env.example backend/.env
```

### Production (Deployed)

Add secrets in GitHub:
1. Go to repo → Settings → Secrets → Actions
2. Add secrets with `APP_` prefix

| GitHub Secret | Available in Code As |
|---------------|---------------------|
| APP_OPENAI_KEY | `process.env.OPENAI_KEY` |
| APP_API_KEY | `process.env.API_KEY` |
| APP_DATABASE_URL | `process.env.DATABASE_URL` |

---

## 📋 Pre-Deployment Checklist

Before deploying, verify ALL of these:

### Structure
- [ ] `frontend/Dockerfile` exists (if frontend)
- [ ] `frontend/nginx.conf` exists (if frontend)
- [ ] `backend/Dockerfile` exists (if backend)
- [ ] `database/Dockerfile` exists (if database)
- [ ] `.github/workflows/deploy.yml` exists

### Health Checks
- [ ] Frontend has `/health` endpoint (in nginx.conf)
- [ ] Backend has `/health` endpoint returning JSON
- [ ] Database Dockerfile has HEALTHCHECK instruction

### Ports
- [ ] Frontend nginx listens on port 80
- [ ] Backend listens on port 3000

### API Routes
- [ ] Frontend calls `/api/*` (not direct backend URLs)
- [ ] Backend routes don't include `/api` prefix

### Database (if used)
- [ ] Copied template to `database/Dockerfile`
- [ ] Backend has `DATABASE_HOST` env var configured
- [ ] For SQL: `database/init/init.sql` has schema

### Local Test
- [ ] `docker-compose up --build` works
- [ ] Frontend loads at http://localhost:8080
- [ ] Backend health at http://localhost:3000/health returns 200
- [ ] API calls work through frontend
- [ ] Database connection works (if used)

---

## 🚨 Common Deployment Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container won't start | Invalid nginx.conf | Remove `events{}` and `http{}` blocks |
| Health check timeout | Missing /health endpoint | Add health endpoint to both FE and BE |
| 502 Bad Gateway | Backend not on port 3000 | Ensure backend listens on 3000 |
| API calls fail | Routes include /api prefix | Remove /api from backend routes |
| CORS errors | Backend missing CORS headers | Add CORS middleware to backend |
| Build fails | Missing Dockerfile | Copy template Dockerfile to component |
