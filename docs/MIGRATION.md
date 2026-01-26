# 🔄 Migrating Your Existing Project

This guide helps you bring an existing project into the Vibe Platform deployment structure.

> **Starting fresh?** Skip this guide - just tell the AI what you want to build!

---

## 📋 Quick Checklist

Before your project can be deployed, ensure this structure:

```
your-repo/
├── frontend/                 ← Required (if you have UI)
│   ├── Dockerfile           ← Copy from Dockerfile.vanilla or Dockerfile.react
│   ├── nginx.conf           ← Required for nginx configuration
│   └── [your frontend code]
│
├── backend/                  ← Required (if you have server)
│   ├── Dockerfile           ← Copy from Dockerfile.node or Dockerfile.python
│   └── [your backend code]
│
├── database/                 ← Optional
│   └── init/
│       └── init.sql
│
├── docker-compose.yml        ← For local testing
└── .github/
    └── workflows/
        └── deploy.yml        ← Already included in template
```

---

## 🚀 Migration Steps

### Step 1: Copy Your Code

Copy your existing project files into this repository:

```bash
# Option A: If your code is in another git repo
git clone https://github.com/bayer-int/your-other-repo.git temp-code
cp -r temp-code/* .
rm -rf temp-code

# Option B: If your code is local
cp -r /path/to/your/project/* .
```

### Step 2: Reorganize Into Required Structure

Move your files into the correct folders:

| Your Current Structure | Move To |
|----------------------|---------|
| `index.html`, `style.css`, `app.js` in root | → `frontend/` |
| `src/` folder (React/Vue) | → `frontend/src/` |
| `public/` folder | → `frontend/public/` |
| `client/` folder | → Rename to `frontend/` |
| `server.js`, `app.py` in root | → `backend/` |
| `server/` folder | → Rename to `backend/` |
| `api/` folder | → `backend/api/` |

**Example commands:**
```bash
# Create folders
mkdir -p frontend backend database/init

# Move frontend files
mv index.html style.css script.js frontend/
# OR for React projects
mv src/ public/ package.json vite.config.js frontend/

# Move backend files  
mv server.js package.json backend/
# OR for Python
mv app.py requirements.txt backend/
```

### Step 3: Add Required Dockerfiles

Copy the appropriate Dockerfile templates:

**For Frontend:**
```bash
# Vanilla HTML/CSS/JS
cp Dockerfile.vanilla frontend/Dockerfile

# OR React/Vue/Angular
cp Dockerfile.react frontend/Dockerfile
```

**For Backend:**
```bash
# Node.js
cp Dockerfile.node backend/Dockerfile

# OR Python
cp Dockerfile.python backend/Dockerfile
```

### Step 4: Add Health Endpoints

**Frontend** - Create/update `frontend/nginx.conf`:
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

**Backend (Node.js)** - Add to your server file:
```javascript
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});
```

**Backend (Python/FastAPI)**:
```python
@app.get("/health")
def health():
    return {"status": "ok"}
```

### Step 5: Update docker-compose.yml

Use this template:
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
```

### Step 6: Test Locally

```bash
docker-compose up --build
```

Then verify:
- ✅ Frontend loads at http://localhost:8080
- ✅ Backend health check at http://localhost:3000/health
- ✅ API calls work (if applicable)

### Step 7: Request Whitelist Access

Contact the Vibe Platform team to add your repository to the allowed list.

### Step 8: Deploy

```bash
git add .
git commit -m "Migrated project to Vibe Platform structure"
git push
```

Your app will be live at: `https://<repo-name>.vibe.demo.bfrg.de`

---

## ⚠️ Common Migration Issues

| Issue | Solution |
|-------|----------|
| nginx won't start | Check `nginx.conf` - must only contain `server {}` block, no `events {}` or `http {}` |
| Health check fails | Ensure `/health` endpoint exists and returns 200 |
| Backend not accessible | Ensure backend listens on port 3000 |
| API calls fail in production | Use `/api/*` URLs in frontend, define routes WITHOUT `/api` prefix in backend |
| Build fails | Check Dockerfile is in the correct folder |
| Database: "chown: Operation not permitted" | EFS doesn't support chown. Use `/data` directly as PGDATA/datadir, NOT `/data/postgres` or `/data/mysql`. Remove any `mkdir`/`chown` commands from database Dockerfile. |

---

## 🤖 Let AI Help!

After migrating, open Cursor/Copilot and say:

> "I migrated my existing project. Can you verify the structure is correct?"

The AI will check your setup and fix any issues!
