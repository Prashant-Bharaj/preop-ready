# Development Guidelines

## Code Generation Checklist

### Frontend: Vanilla
- [ ] Copy `Dockerfile.vanilla` content → `frontend/Dockerfile`
- [ ] Create `frontend/index.html`
- [ ] Create `frontend/style.css`
- [ ] Create `frontend/script.js`

### Frontend: React
- [ ] Copy `Dockerfile.react` content → `frontend/Dockerfile`
- [ ] Create `frontend/package.json` (with Vite, React)
- [ ] Create `frontend/vite.config.js`
- [ ] Create `frontend/index.html`
- [ ] Create `frontend/src/main.jsx`
- [ ] Create `frontend/src/App.jsx`
- [ ] Create `frontend/src/App.css`

### Backend: Node.js
- [ ] Copy `Dockerfile.node` content → `backend/Dockerfile`
- [ ] Create `backend/package.json` with:
  - express
  - mysql2 (if MySQL) or pg (if PostgreSQL)
  - **devDependencies**: eslint, @eslint/js, eslint-plugin-security, eslint-plugin-no-secrets
- [ ] **Copy `examples/eslint.config.js` → `backend/eslint.config.js`**
- [ ] Create `backend/src/index.js`

### Backend: Python
- [ ] Copy `Dockerfile.python` content → `backend/Dockerfile`
- [ ] Create `backend/requirements.txt` with:
  - fastapi
  - uvicorn
  - mysql-connector-python (if MySQL) or psycopg2-binary (if PostgreSQL)
- [ ] **Copy `examples/ruff.toml` → `backend/ruff.toml`**
- [ ] Create `backend/main.py`

### Database: MySQL (default)
- [ ] Create/update `database/init/init.sql` with schema
- [ ] Use MySQL config in `docker-compose.yml` (already default)
- [ ] Set `DATABASE_PORT=3306`

### Database: PostgreSQL
- [ ] Create/update `database/init/init.sql` with schema
- [ ] Replace MySQL with PostgreSQL in `docker-compose.yml`
- [ ] Set `DATABASE_PORT=5432`

### No Database
- [ ] Delete entire `database/` folder
- [ ] Remove `db` service from `docker-compose.yml`
- [ ] Remove `DATABASE_*` env vars from backend service

## Required Files After Generation

```
├── demo.config.yml
├── docker-compose.yml
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── [app files]
├── backend/                     # Only if needed
│   ├── Dockerfile
│   ├── eslint.config.js         # Node.js only
│   ├── ruff.toml                # Python only
│   └── [app files]
├── database/                    # Only if needed
│   └── init/
│       └── init.sql
```

## Health Check Endpoint (REQUIRED)

```javascript
// Node.js/Express
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
```

```python
# Python/FastAPI
@app.get("/health")
def health():
    return {"status": "ok"}
```

## Database Connection Example

```javascript
// Node.js with MySQL
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
});
```

```python
# Python with MySQL
import os
import mysql.connector

db = mysql.connector.connect(
    host=os.environ["DATABASE_HOST"],
    port=int(os.environ["DATABASE_PORT"]),
    database=os.environ["DATABASE_NAME"],
    user=os.environ["DATABASE_USER"],
    password=os.environ["DATABASE_PASSWORD"],
)
```

## API Communication

Frontend calls backend via relative URLs:

```javascript
// ✅ Correct
fetch('/api/users')

// ❌ Wrong
fetch('https://api.myapp.demo.int.bayer.com/users')
```
