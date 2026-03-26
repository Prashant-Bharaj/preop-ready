# 🔨 Building the App

---

## 🚨🚨🚨 CRITICAL: NEVER Use /api Prefix in Backend Routes 🚨🚨🚨

> **⛔ ABSOLUTE RULE: Backend routes must NEVER include `/api` prefix.**
>
> Traefik (production) and nginx (local dev) STRIP the `/api` prefix before forwarding to the backend.
> If your backend route is `/api/users`, the request arrives as `/api/users` but Traefik strips `/api`,
> so the backend receives `/users` — and your `/api/users` route never matches → **404 error**.
>
> **Frontend calls `/api/*` → Traefik/nginx strips `/api` → Backend receives `/*`**

### ✅ CORRECT — Backend routes WITHOUT /api:

**Node.js/Express:**
```javascript
app.get('/users', (req, res) => { ... });      // Frontend: fetch('/api/users')
app.get('/health', (req, res) => { ... });     // Frontend: fetch('/api/health')
app.post('/data', (req, res) => { ... });      // Frontend: fetch('/api/data', {method:'POST'})
```

**Python/FastAPI:**
```python
@app.get("/users")                              # Frontend: fetch('/api/users')
def get_users(): ...

@app.get("/health")                             # Frontend: fetch('/api/health')
def health(): ...
```

**Python/Flask:**
```python
@app.route('/users')                            # Frontend: fetch('/api/users')
def get_users(): ...
```

**Rust/Actix-web:**
```rust
web::resource("/users").route(web::get().to(get_users))  // Frontend: fetch('/api/users')
```

### ❌ WRONG — These WILL break in production:
```javascript
app.get('/api/users', ...);    // ❌ Would need /api/api/users to reach!
```
```python
@app.get("/api/users")         // ❌ Would need /api/api/users to reach!
```

> **Full details, examples, and common mistakes: see `10-platform-rules.md` § API Routing.**

---

## ⚠️ FIRST: Configure docker-compose.yml AND nginx.local.conf for Your Architecture

**BEFORE creating any code files, update BOTH `docker-compose.yml` AND `frontend/nginx.local.conf` to match the chosen stack:**

### Step 1: docker-compose.yml

| Architecture | Action |
|-------------|--------|
| **Frontend-only** (no backend) | Remove `backend`, `db` services, `depends_on`, `networks`, `volumes`. Keep only the `frontend` service. See "Frontend-Only Apps" section below. |
| **Frontend + Backend** (no database) | Remove `db` service and its `depends_on`. Keep `frontend` and `backend`. |
| **Full-stack** (frontend + backend + database) | Keep all services. Switch MySQL/PostgreSQL as needed. |

### Step 2: nginx.local.conf (if frontend-only)

| Architecture | Action |
|-------------|--------|
| **Frontend-only** (no backend) | Remove the entire API proxy section from `nginx.local.conf` (marked with `>>> REMOVE THIS ENTIRE SECTION FOR FRONTEND-ONLY APPS <<<`). Or copy `nginx.conf` as `nginx.local.conf`. |
| **Has backend** | Keep nginx.local.conf as-is (proxy blocks needed). |

**Do BOTH steps FIRST** — if you run `docker-compose up` with services that reference missing Dockerfiles or with nginx proxy_pass pointing to a non-existent backend, the build/start will fail.

> **Segments are optional.** Projects can use any combination: frontend-only, backend-only, with or without database/vectordb. To remove a segment, see the "Removing a Segment" section in `10-platform-rules.md`. Removal is safe — data is preserved on EFS.

---

## Always Start with Something Visual

Users get excited when they SEE something. Build the frontend first!

```
Let me create the first version of your app - give me a moment...

[create the files]

Done! ✨ I've created your app with:
- A clean, modern homepage
- [specific feature they asked for]
- Mobile-friendly design

Would you like me to start it so you can see it? 
```

**If user says yes, RUN THE COMMAND FOR THEM:**
```bash
docker-compose up --build
```

Then **show the correct URL based on environment** (see `15-urls.md` for detection and formats). Tell them the app takes ~30 seconds the first time.

## Project Structure (For Your Reference)

```
frontend/              ← Website (what users see)
├── index.html         ← Main page
├── style.css          ← Colors and styling
├── script.js          ← Interactive features (optional)
├── Dockerfile         ← Copy from Dockerfile.vanilla or .react
├── Dockerfile.vanilla ← Template for static HTML sites
└── Dockerfile.react   ← Template for React apps

backend/               ← Server (saves data, APIs)
├── server.js          ← Main server code (Node.js)
├── Dockerfile         ← Copy from Dockerfile.node, .python, or .rust
├── Dockerfile.node    ← Template for Node.js
├── Dockerfile.python  ← Template for Python
└── Dockerfile.rust    ← Template for Rust (advanced, developer-only)

database/              ← Data storage (optional, relational)
├── Dockerfile         ← Copy from Dockerfile.postgres or .mysql
├── Dockerfile.postgres  ← PostgreSQL (recommended)
├── Dockerfile.mysql     ← MySQL
└── init/init.sql        ← Database initialization scripts

vectordb/              ← Vector database (optional, independent from database/)
├── Dockerfile         ← Copy from one of the templates below
├── Dockerfile.pgvector  ← PostgreSQL + pgvector (vector extension auto-enabled)
├── Dockerfile.chroma    ← ChromaDB vector database
├── Dockerfile.qdrant    ← Qdrant vector database
└── init/init.sql        ← Vector DB initialization (for pgvector)
```

## Building Frontend

### ❌ DO NOT use Next.js, Nuxt, Remix, or other server-side frameworks

The platform serves frontends via **nginx** (static files only). Frameworks that need their own Node.js server (Next.js `next start`, Nuxt, Remix, etc.) **will not work** — the deployment will fail.

**Only use:**
- **Vanilla HTML/CSS/JS** → `Dockerfile.vanilla`
- **React + Vite** → `Dockerfile.react` (builds to static `/dist`, served by nginx)

If a user specifically asks for Next.js, explain that the platform requires static builds and offer React + Vite as the alternative.

### For Simple Sites (Vanilla HTML)
Create these files:
- `frontend/index.html` - the webpage
- `frontend/style.css` - make it pretty
- Copy `Dockerfile.vanilla` → `frontend/Dockerfile`

### For Interactive Apps (React)
Create these files:
- `frontend/package.json` with React + Vite
- `frontend/vite.config.js` (or use your preferred Vite config)
- `frontend/src/App.jsx` - main component
- Copy `Dockerfile.react` → `frontend/Dockerfile`

## ⚠️ Frontend-Only Apps — CRITICAL CLEANUP

**If building a frontend-only app (NO backend), you MUST clean up the template files:**

### 1. docker-compose.yml — REMOVE backend and db services

Use this minimal version for frontend-only apps:

```yaml
version: '3.8'

services:
  frontend:
    build: ./frontend
    ports:
      - "8080:8080"
    volumes:
      - ./frontend/nginx.local.conf:/etc/nginx/conf.d/default.conf:ro
```

**Delete:** the `backend`, `db` services, `depends_on`, `networks`, and `volumes` blocks.

### 2. nginx.local.conf — REMOVE proxy blocks

For frontend-only apps, `nginx.local.conf` should be **identical to `nginx.conf`** (no proxy_pass needed). Either:
- Copy `nginx.conf` as `nginx.local.conf`: `cp frontend/nginx.conf frontend/nginx.local.conf`
- Or remove the `/api/` and `/socket.io/` proxy blocks from `nginx.local.conf`

**If you leave proxy_pass blocks pointing to `backend:3000` and there's no backend service, nginx will fail to start!**

### 3. Production nginx.conf — Already correct

The production `nginx.conf` has no proxy blocks, so it works for frontend-only apps as-is. No changes needed.

---

## Building Backend (Only If Needed)

Only add a backend if they need:
- Save/load data
- User accounts
- External API calls (like OpenAI)
- Server-side logic

### Node.js Backend (Recommended)
- Create `backend/server.js`
- Copy `Dockerfile.node` → `backend/Dockerfile`

### Rust Backend (Advanced — only if user explicitly requests Rust)

> ⚠️ **Do NOT recommend Rust** unless the user specifically asks for it. Rust is complex and not well-suited for AI-assisted code generation. Default to Node.js or Python.

- Create `backend/src/main.rs`
- Create `backend/Cargo.toml`
- Copy `Dockerfile.rust` → `backend/Dockerfile`

**📋 COPY THIS for backend/Cargo.toml:**

```toml
[package]
name = "backend"
version = "0.1.0"
edition = "2021"

[dependencies]
actix-web = "4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
```

**📋 COPY THIS for backend/src/main.rs:**

```rust
use actix_web::{web, App, HttpServer, HttpResponse, Responder};
use serde::Serialize;

#[derive(Serialize)]
struct HealthResponse {
    status: String,
}

// =============================================================================
// ROUTES - Note: NO /api prefix! Frontend calls /api/X, backend defines /X
// The /api prefix is STRIPPED by Traefik (production) and nginx (local dev)
// WRONG: .route("/api/users", ...) -> user calls /api/api/users -> 404!
// RIGHT: .route("/users", ...)     -> user calls /api/users     -> works!
// =============================================================================

// Health check (REQUIRED - deployment fails without this!)
async fn health() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let addr = format!("0.0.0.0:{}", port);
    println!("Server running on port {}", port);

    HttpServer::new(|| {
        App::new()
            .route("/health", web::get().to(health))
    })
    .bind(&addr)?
    .run()
    .await
}
```

**Generate `Cargo.lock` before building Docker:**
```bash
cd backend && cargo generate-lockfile && cd ..
```

---

### Node.js Backend — Templates

### 📋 COPY THIS TEMPLATE for backend/server.js:

```javascript
const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// =============================================================================
// ROUTES - Note: NO /api prefix! Frontend calls /api/X, backend defines /X
// The /api prefix is STRIPPED by Traefik (production) and nginx (local dev)
// WRONG: app.get('/api/users') -> user calls /api/api/users -> 404!
// RIGHT: app.get('/users')     -> user calls /api/users     -> works!
// =============================================================================

// Health check (REQUIRED - deployment fails without this!)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Example routes - Frontend calls fetch('/api/items'), backend receives '/items'
app.get('/items', (req, res) => {
  res.json({ items: [] });
});

app.post('/items', (req, res) => {
  const { name } = req.body;
  res.json({ message: `Created: ${name}` });
});

// =============================================================================
// START SERVER - Must be port 3000!
// =============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### 📋 COPY THIS for backend/package.json:

```json
{
  "name": "backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5"
  }
}
```

### Frontend API Calls (in script.js or React component):

```javascript
// ✅ CORRECT - Always use /api prefix when calling from frontend
async function getItems() {
  const response = await fetch('/api/items');
  return response.json();
}

async function createItem(name) {
  const response = await fetch('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  return response.json();
}
```

## Design Principles

Make it look good! Users judge apps by appearance:

- **Clean layout** - lots of white space
- **Modern colors** - subtle gradients, not harsh primaries
- **Rounded corners** - `border-radius: 8px` on buttons/cards
- **Good fonts** - Use system fonts or Google Fonts
- **Mobile friendly** - Test narrow widths
- **Feedback** - Loading spinners, success/error messages

## After Creating Files

Always tell them what you made:

```
✅ Your app is ready! Here's what I created:

📁 frontend/
   - index.html (your main page with the voting form)
   - style.css (modern dark theme with your brand colors)

📁 backend/
   - server.js (saves votes and shows results)

Want to test it locally, or should we deploy it right away?
```

---

# ➕ Adding Components to Existing Projects

## When Users Want to Extend Their App

Users often start simple and want to add features later. Here's how to handle common requests:

### Adding a Backend to Frontend-Only App

**User says:** "I want to save data" / "Add a database" / "Connect to OpenAI"

```
Great idea! Right now your app is frontend-only (just the website).
To save data or use APIs, we need to add a backend server.

I'll create:
- A backend folder with your server code
- Connect your frontend to talk to it

Want me to set that up?
```

**Then create:**
1. `backend/` folder
2. `backend/server.js` (or `app.py` for Python)
3. `backend/package.json` (or `requirements.txt`)
4. Copy `Dockerfile.node` → `backend/Dockerfile`
5. Add health endpoint
6. Update `docker-compose.yml` to include backend service
7. Update frontend to call `/api/*` endpoints

### Adding a Database

**User says:** "I need a database" / "Save user data permanently"

```
To store data permanently, we'll add a database. 

I'll set up:
- A database container with persistent storage
- Initial tables for your data
- Backend code to read/write from it

Your data will persist even when the app restarts!
```

**Then create:**
1. Copy the appropriate Dockerfile template to `database/Dockerfile`
2. Create `database/init/init.sql` with table definitions (for SQL databases)
3. Update `backend/server.js` to connect to database
4. Update `docker-compose.yml` with database service
5. Add database environment variables

**Database choice guide:**

| Use Case | Template | Notes |
|----------|----------|-------|
| Most web apps | `database/Dockerfile.postgres` | Recommended default |
| Familiar with MySQL | `database/Dockerfile.mysql` | Traditional choice |

For **vector databases** (AI/embeddings), use the `vectordb/` folder instead — see "Adding a Vector Database" below.

**Setup steps:**
```bash
# Pick one:
cp database/Dockerfile.postgres database/Dockerfile    # PostgreSQL (recommended)
cp database/Dockerfile.mysql database/Dockerfile       # MySQL
```

### ⚠️ CRITICAL: Database Persistence Requirements

**The platform mounts EFS (persistent storage) at `/data` in the container.** Your database MUST store data in `/data/<subdir>` to persist across deployments.

**MySQL - ALWAYS use CMD with --datadir flag:**
```dockerfile
FROM mysql:8.0
COPY init/ /docker-entrypoint-initdb.d/
RUN mkdir -p /data/mysql && chown -R mysql:mysql /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD mysqladmin ping -h localhost || exit 1
EXPOSE 3306
# CRITICAL: Command line --datadir ALWAYS takes precedence
CMD ["mysqld", "--datadir=/data/mysql"]
```

**PostgreSQL - use PGDATA environment variable:**
```dockerfile
FROM postgres:16
COPY init/ /docker-entrypoint-initdb.d/
ENV PGDATA=/data/postgres
RUN mkdir -p /data/postgres && chown -R postgres:postgres /data
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD pg_isready -U postgres || exit 1
EXPOSE 5432
```

**Why this matters:**
- Without this, data is stored inside the container and **LOST on every deployment**
- The database container restarts and sees an "empty" data directory
- MySQL/PostgreSQL reinitializes, wiping all data

**NEVER use config files alone** - they can be overridden. Always use:
- MySQL: `CMD ["mysqld", "--datadir=/data/mysql"]`
- PostgreSQL: `ENV PGDATA=/data/postgres`

### Database Schema Changes (Migrations)

**IMPORTANT:** Init scripts in `database/init/` only run on **first deployment** (when database is empty). After that, schema changes require migrations.

**User says:** "I need to add a new column" / "Change the database schema"

```
Since your database already has data, we can't just change init.sql - 
that only runs once when the database is first created.

For schema changes, I'll add migration logic to your backend that runs 
on startup. This is the safe way to update your database structure 
without losing data.
```

**Implementation approach:**

1. **Add a migrations table** to track which migrations have run:

```javascript
// backend/src/db/migrations.js
async function runMigrations(db) {
  // Create migrations table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Define migrations
  const migrations = [
    {
      name: '001_add_user_email',
      sql: 'ALTER TABLE users ADD COLUMN email VARCHAR(255)'
    },
    {
      name: '002_add_created_at',
      sql: 'ALTER TABLE posts ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
    }
  ];
  
  // Run pending migrations
  for (const migration of migrations) {
    const [rows] = await db.query(
      'SELECT * FROM _migrations WHERE name = ?',
      [migration.name]
    );
    
    if (rows.length === 0) {
      console.log(`Running migration: ${migration.name}`);
      await db.query(migration.sql);
      await db.query(
        'INSERT INTO _migrations (name) VALUES (?)',
        [migration.name]
      );
    }
  }
}
```

2. **Call migrations on startup** (in server.js):

```javascript
// After database connection
await runMigrations(db);
console.log('✅ Database migrations complete');
```

3. **For PostgreSQL**, use the same pattern:

```javascript
const migrations = [
  {
    name: '001_add_user_email',
    sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)'
  }
];
```

**Migration rules:**
- ✅ Always add new migrations, never edit old ones
- ✅ Name migrations sequentially (001_, 002_, etc.)
- ✅ Make migrations idempotent when possible (IF NOT EXISTS)
- ✅ Test migrations locally before deploying
- ❌ Never delete data columns without backing up first
- ❌ Never rename tables/columns (add new, migrate data, drop old)

**Tell the user:**
```
I've added migration support to your backend. Now when you need
schema changes:

1. Add a new migration to the migrations array
2. Deploy - it will automatically run on startup
3. Your existing data stays safe!

Want me to add a migration for your change?
```

### ⚠️ Database Management — Critical Principles

**Understanding the deployment model:**

Every `git push` triggers a redeployment. The **database container is NOT rebuilt** — it persists on EFS at `/data`. But the **backend container IS rebuilt** and runs migrations on startup.

| What | Behavior | Implication |
|------|----------|-------------|
| `database/init/*.sql` | Runs **ONCE** on first deploy only | Editing after first deploy has NO effect |
| Backend migrations | Run on **every** backend startup | This is how you change schema |
| Database data (EFS `/data`) | Persists across deployments | Your data survives redeploys |
| Database container image | Rebuilt on deploy | But data dir is mounted from EFS |

**Key principles:**

1. **Don't rebuild the database to change schema.** Init scripts only run when the database is empty (first time). All subsequent schema changes MUST go through backend migrations.

2. **Don't commit data to git.** Data lives in the database on EFS. Seed data goes in `database/init/*.sql` (first deploy). User-generated data stays in the DB. Never export SQL dumps to the repo.

3. **Schema changes = backend migrations.** If you edit `database/init/init.sql` after the database already has data, nothing happens. The migration system above is the ONLY way to change schema post-deployment.

### Common Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|-------------------|
| Editing `database/init/*.sql` after first deploy | Add a backend migration |
| Committing SQL dump files to git | Keep data in DB, use migrations for schema |
| Rebuilding DB container to apply schema changes | Use backend migrations (data preserved) |
| Adding `NOT NULL` column without default | Add as nullable first, backfill, then add constraint |
| Deleting and recreating tables | Use `ALTER TABLE` in migrations |

### Continuous Deployment Considerations

Since every push triggers a redeploy and migrations run on startup:

**Migrations must be backward-compatible.** The new backend code starts serving traffic immediately after deployment. If a migration fails, the backend won't start.

**Zero-downtime migration pattern** (for complex changes):

```
Phase 1: Add new column (nullable or with default)     → git push
Phase 2: Update code to write to both old + new column → git push
Phase 3: Backfill data from old → new column            → git push
Phase 4: Remove old column usage from code              → git push
Phase 5: (Optional) Drop old column via migration       → git push
```

**Testing migrations locally:**
```bash
# Test from scratch (simulates first deployment)
docker-compose down -v && docker-compose up --build

# Test migration on existing data (simulates redeployment)
docker-compose restart backend
```

**Rollback:** If a migration causes issues, add a NEW migration that reverses the change. Never edit or delete old migrations.

### Adding a Vector Database (Dual-Database Setup)

**User says:** "I need vector search AND a regular database" / "Add embeddings alongside my SQL data"

Use the `vectordb/` folder for a **second, independent** database dedicated to vector operations:

```
I'll set up a dedicated vector database alongside your existing database:
- Your relational data stays in database/ (PostgreSQL/MySQL)
- Vector embeddings go in vectordb/ (Chroma/Qdrant/pgvector)
- They run as completely separate services
```

**Decision guide:**

| Scenario | Use |
|----------|-----|
| Only need vectors, no relational DB | Use `vectordb/` folder (no `database/` needed) |
| Need SQL + separate vector service | `database/Dockerfile.postgres` + `vectordb/Dockerfile.chroma` |
| Need two independent Postgres instances | `database/Dockerfile.postgres` + `vectordb/Dockerfile.pgvector` |

**Setup steps:**
```bash
# Pick your vector DB:
cp vectordb/Dockerfile.chroma vectordb/Dockerfile      # Simple, Python-native
cp vectordb/Dockerfile.qdrant vectordb/Dockerfile      # High-performance
cp vectordb/Dockerfile.pgvector vectordb/Dockerfile    # SQL-based vectors
```

**Backend receives these env vars automatically:**
- `VECTORDB_HOST` — hostname of the vector DB service
- `VECTORDB_PORT` — port (8000 for Chroma, 6333 for Qdrant, 5432 for pgvector)
- `VECTORDB_NAME`, `VECTORDB_USER`, `VECTORDB_PASSWORD` — credentials (pgvector only)

**Update docker-compose.yml** with the vectordb service for local dev.

### Adding OpenAI / AI Features

**User says:** "Add AI" / "Use ChatGPT" / "Make it smart"

```
Let's add AI to your app! I'll:
- Set up the OpenAI connection in your backend
- Create an endpoint your frontend can call
- You'll need to add your API key as a secret

Ready to add some AI magic? ✨
```

**Then:**
1. Add OpenAI package to backend
2. Create `/api/ai` endpoint (or similar)
3. Add proper error handling
4. Update frontend with AI interaction UI
5. Guide them to add `APP_OPENAI_KEY` secret (see `08-secrets.md`)

### Switching Frontend Framework

**User says:** "Can we use React instead?" / "I want a more interactive UI"

```
Sure! We can upgrade to React for a more interactive experience.

This will replace your current HTML with React components.
Your design and features will stay the same, just built differently.

Want me to convert it?
```

**Migration steps:**
1. Keep existing HTML/CSS as reference
2. Create new React structure in `frontend/`
3. Convert HTML → JSX components
4. Move styles to CSS modules or styled-components
5. Replace `Dockerfile.vanilla` with `Dockerfile.react`
6. Update nginx.conf for React SPA routing

### Adding Authentication (Advanced)

**User says:** "Add login" / "User accounts"

```
Adding user accounts is more complex, but doable!

For a hackathon, I'd recommend keeping it simple:
- Basic username/password stored in database
- Session-based login

For production apps, you'd want proper auth (OAuth, SSO), 
but for demo purposes, simple auth works great.

Want me to add basic login?
```

---

## ⚠️ Common Dockerfile Pitfalls

### Using `echo` for multiline config files

**WRONG** - `echo` doesn't interpret `\n` without `-e` flag:
```dockerfile
# This creates ONE LINE with literal \n characters - CONFIG WILL NOT WORK!
RUN echo '[mysqld]\ndatadir=/data/mysql\n' > /etc/mysql/conf.d/datadir.cnf
```

**CORRECT** - Use `printf` which interprets escape sequences:
```dockerfile
# This creates proper multiline config file
RUN printf '[mysqld]\n\
datadir=/data/mysql\n\
socket=/var/run/mysqld/mysqld.sock\n' > /etc/mysql/conf.d/datadir.cnf
```

**Also correct** - Use heredoc:
```dockerfile
RUN cat > /etc/mysql/conf.d/datadir.cnf <<'EOF'
[mysqld]
datadir=/data/mysql
socket=/var/run/mysqld/mysqld.sock
EOF
```

This is a critical bug that causes **data loss** - the database won't use the EFS mount and data will be lost on every deployment!

---

## 🔄 Component Addition Checklist

When adding any new component, always:

- [ ] Update `docker-compose.yml` with new service
- [ ] Ensure health endpoints exist for new services
- [ ] Update frontend API calls if backend changed
- [ ] Test locally before deploying
- [ ] Add any new secrets to GitHub if needed
- [ ] For databases: verify config files are valid (use `printf` not `echo` for multiline)

## Communication When Adding Components

**Always reassure them:**
```
Don't worry - your existing features will keep working exactly the same.
We're just adding new capabilities on top of what you already have.
```

**After adding:**
```
✅ Done! I've added [component] to your app.

Here's what's new:
- [list new files/features]

Your existing [features] still work the same way.

Want to test the new features locally?
```

---

## 📋 Don't Forget: Update Project Status!

**After building or adding components, update `docs/PROJECT_STATUS.md`:**
- Update the Stack section (Frontend/Backend/Database status)
- Add completed tasks with dates
- Note what's in progress

See `11-status-tracking.md` for details.
