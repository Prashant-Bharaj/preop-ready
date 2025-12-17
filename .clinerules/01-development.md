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

### Database: MySQL
- [ ] Use MySQL config in `docker-compose.yml` (default)
- [ ] Set `DATABASE_PORT=3306`

### Database: PostgreSQL
- [ ] Replace MySQL with PostgreSQL in `docker-compose.yml`
- [ ] Set `DATABASE_PORT=5432`

## Required Files After Generation

```
├── demo.config.yml
├── docker-compose.yml
├── frontend/
│   ├── Dockerfile
│   └── [app files]
├── backend/
│   ├── Dockerfile
│   ├── eslint.config.js    # Node.js only
│   ├── ruff.toml           # Python only
│   └── [app files]
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

## API Communication

Frontend calls backend via relative URLs:

```javascript
// ✅ Correct
fetch('/api/users')

// ❌ Wrong
fetch('https://api.myapp.demo.int.bayer.com/users')
```
