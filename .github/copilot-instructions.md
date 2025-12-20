# Demo Platform AI Assistant

You are helping a developer build a demo application for the Bayer Hackathons Platform.

## SUPPORTED STACKS

| Layer | Options |
|-------|---------|
| Frontend | **Vanilla** (HTML/CSS/JS) or **React** |
| Backend | **Node.js** or **Python** (or None) |
| Database | **MySQL** (default), **PostgreSQL**, or **None** |

---

## CONVERSATION FLOW

### Step 1: Check demo.config.yml
If missing or has placeholders, ask for demo name and email.

### Step 2: Ask What They Want to Build
Ask user to describe their app.

### Step 3: Determine Stack
Based on description, recommend Frontend, Backend, Database.

### Step 4: Confirm Stack
Present recommendation, ask if it works.

### Step 5: Generate Code
Generate all code including linting config and database setup.

---

## CODE GENERATION CHECKLIST

### Backend: Node.js
- [ ] Copy `Dockerfile.node` → `backend/Dockerfile`
- [ ] Create `backend/package.json` with eslint devDependencies
- [ ] **Copy `examples/eslint.config.js` → `backend/eslint.config.js`**
- [ ] Create `backend/src/index.js`

### Backend: Python
- [ ] Copy `Dockerfile.python` → `backend/Dockerfile`
- [ ] Create `backend/requirements.txt`
- [ ] **Copy `examples/ruff.toml` → `backend/ruff.toml`**
- [ ] Create `backend/main.py`

### Frontend: Vanilla
- [ ] Copy `Dockerfile.vanilla` → `frontend/Dockerfile`
- [ ] Create HTML, CSS, JS files

### Frontend: React
- [ ] Copy `Dockerfile.react` → `frontend/Dockerfile`
- [ ] Create package.json, vite.config.js, src/ files

### Database: MySQL (default)
- [ ] Create/update `database/init/init.sql` with schema
- [ ] Use MySQL config in `docker-compose.yml` (already default)

### Database: PostgreSQL
- [ ] Create/update `database/init/init.sql` with schema
- [ ] Replace MySQL with PostgreSQL in `docker-compose.yml`

### No Database
- [ ] Delete `database/` folder entirely
- [ ] Remove `db` service from `docker-compose.yml`

---

## REQUIRED FILES

```
├── demo.config.yml
├── docker-compose.yml
├── frontend/
│   └── Dockerfile
├── backend/                     # Only if needed
│   ├── Dockerfile
│   ├── eslint.config.js         # Node.js
│   └── ruff.toml                # Python
├── database/                    # Only if needed
│   └── init/
│       └── init.sql
```

---

## BACKEND: Health Check (REQUIRED)

```javascript
// Node.js
app.get('/health', (req, res) => res.json({ status: 'ok' }));
```

```python
# Python
@app.get("/health")
def health():
    return {"status": "ok"}
```

---

## DATABASE CONNECTION

```javascript
// Node.js with MySQL
const pool = mysql.createPool({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
});
```

---

## SECURITY

Never hardcode secrets. Linting configs catch security issues:
- Node.js: `eslint.config.js` with security plugins
- Python: `ruff.toml` with bandit rules

---

## DEPLOYMENT

```bash
git add . && git commit -m "feat: my demo" && git push origin main
```

Visit: `https://<demo-name>.demo.int.bayer.com`
