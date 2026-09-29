---
applyTo: "backend/**"
---

<!-- GENERATED FILE - DO NOT EDIT. Source: .platform-rules/scope-backend.md -->
<!-- Regenerate: node scripts/build-rule-adapters.js -->

# Backend Rules

Core rules (routing, ports, `/health`, security musts, secrets table) are in `.platform-rules/01-common.md` — this file adds backend depth only. Two-line recap:
- Routes are defined WITHOUT `/api` (`app.get('/users')` ← frontend calls `/api/users`); backend listens on port 3000; `/health` is required.
- ⛔ When EDITING or REWRITING an existing server file, re-verify every route before finishing — rewrites are where the `/api` prefix sneaks back in. This applies to middleware mounts too: `app.use('/users', requireApproved)`, never `app.use('/api', ...)` (that path never reaches the backend). Self-check: `grep -rn "('/api" backend/src` must return nothing.
- ⛔ Database migration files belong in `backend/migrations/NNN_*.sql` — they are backend code, executed by the runner inside this container. NEVER put them under `database/` (invisible to the backend, they'd silently never run). See `.platform-rules/scope-database.md`.
- Every endpoint returns descriptive JSON errors with proper HTTP status codes — never plain text, never stack traces.

## Setup

| Stack | Dockerfile | Entry files |
|-------|-----------|-------------|
| Node.js/Express (recommended for NEW projects) | `cp backend/Dockerfile.node backend/Dockerfile` | `src/index.ts`, `package.json`, `tsconfig.json` |
| Python/FastAPI | `cp backend/Dockerfile.python backend/Dockerfile` | `main.py`, `requirements.txt` |
| Rust/Actix-web (only if user explicitly asks) | `cp backend/Dockerfile.rust backend/Dockerfile` | `src/main.rs`, `Cargo.toml` |

An existing backend keeps its language (core rule "Existing Project → Continue in ITS Stack").
A JavaScript `server.js` app stays JavaScript **and keeps its current `backend/Dockerfile`** —
never re-copy `Dockerfile.node` over it: that template is TypeScript-only (it expects
`tsconfig.json` and a `build` script and ships `dist/`). Fix a JS project's Dockerfile in place.

TypeScript + ESM (new Node projects): source is `src/index.ts`, compiled by `tsc` to `dist/index.js`. `backend/Dockerfile.node` is multi-stage — the builder installs all deps and runs `tsc`; the runtime ships `dist/` plus pruned production deps.

## Express Starter

```typescript
// backend/src/index.ts
import express, { Request, Response } from 'express';
import cors from 'cors';
const app = express();
app.use(cors());
app.use(express.json());

// Routes: NO /api prefix (Traefik/nginx strip it). Frontend fetch('/api/items') → backend '/items'
app.get('/health', (req: Request, res: Response) => res.json({ status: 'ok' }));   // REQUIRED — deploy fails without it
app.get('/items', (req: Request, res: Response) => res.json({ items: [] }));
app.post('/items', (req: Request, res: Response) => res.json({ message: `Created: ${req.body.name}` }));

const PORT = process.env.PORT || 3000;                           // must be 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
```

```json
{
  "name": "backend", "version": "1.0.0", "type": "module", "main": "dist/index.js",
  "scripts": { "build": "tsc", "typecheck": "tsc --noEmit", "start": "node dist/index.js", "dev": "tsc --watch" },
  "dependencies": { "express": "^4.18.2", "cors": "^2.8.5" },
  "devDependencies": { "typescript": "^5.4.0", "@types/node": "^20.11.0", "@types/express": "^4.17.21", "@types/cors": "^2.8.17" }
}
```

## FastAPI Starter

```python
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")            # REQUIRED — and no /api prefix on any route
def health():
    return {"status": "ok"}

# Serve with: uvicorn main:app --host 0.0.0.0 --port 3000
```

## Rust Caveat

⛔ Do NOT recommend Rust — use it only when the user explicitly requests it (complex, poor fit for AI-assisted generation). If requested: copy `backend/Dockerfile.rust`, scaffold a minimal Actix app with `/health` and routes without `/api`, and run `cd backend && cargo generate-lockfile` before the Docker build.

## Database Connection

`DATABASE_*` env vars are auto-injected in production (see core); locally the same names come from docker-compose `environment:`. Never hardcode credentials.

```typescript
import { Pool } from 'pg';
const pool = new Pool({
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
});
// Parameterized queries only: pool.query('SELECT * FROM users WHERE id = $1', [id])
```

Vector DB apps get `VECTORDB_*` the same way — see `.platform-rules/scope-vectordb.md`.

## Recommended Libraries

Use these when the feature is needed — they match the platform snippets.

### Node.js

| Purpose | Library |
|---------|---------|
| HTTP client | `axios` |
| File uploads | `multer` |
| PDF text extraction | `pdf-parse` |
| DOCX text extraction | `mammoth` |
| Excel parsing / export | `exceljs` |
| PPTX text extraction | `adm-zip` |
| CSV parsing | `csv-parse` |
| Email | `nodemailer` |
| WebSocket | `socket.io` |
| Input validation | `express-validator` |
| Date manipulation | `date-fns` |
| UUID generation | `uuid` |
| Password hashing | `bcrypt` (built-in `crypto` for general hashing) |
| Scheduling / cron | `node-cron` |
| PostgreSQL | `pg` |

### Python

| Purpose | Library |
|---------|---------|
| Web framework / server | `fastapi` + `uvicorn` |
| HTTP client | `httpx` |
| PDF text extraction | `pypdf` (or `pdfplumber` for tables) |
| DOCX text extraction | `python-docx` |
| Excel parsing | `openpyxl` (or `pandas` for analysis) |
| CSV parsing | `csv` (built-in) |
| Data analysis | `pandas` |
| Email | `smtplib` (built-in) |
| WebSocket | `python-socketio` |
| Input validation | `pydantic` |
| Date manipulation | `datetime` (built-in; `pendulum` for complex tz) |
| PostgreSQL | `asyncpg` (async) or `psycopg2` (sync) |
| ORM | `sqlalchemy` |
| LLM / AI calls | `openai` (works with Bayer MGA) |
| Server-side charts | `matplotlib` or `plotly` |

### Libraries to AVOID

| ⛔ Don't use | Use instead | Why |
|-------------|-------------|-----|
| `moment.js` | `date-fns` | Deprecated, 330KB |
| `request` | `axios` | Deprecated |
| `body-parser` | `express.json()` | Built into Express 4.16+ |
| `node-fetch` | `axios` (or built-in `fetch`, Node 18+) | Snippet consistency |
| `jquery` | React | Not needed |
| `lodash` (full) | `lodash-es` or native methods | 70KB, mostly native now |
| `d3` (simple charts) | `recharts` / `chart.js` | Overkill |

If the user insists on another library that's fine — these are defaults, not hard rules.

## Snippets (check `snippets/INDEX.md` before writing code)

| Need | Snippet |
|------|---------|
| Input validation, sanitize middleware, safe SQL | `snippets/security/*` |
| Logged-in user from OIDC headers | `snippets/auth/user-identity.ts` / `.py` / `.rs` |
| LLM chat / MGA assistant | `snippets/llm/*` |
| Send email via Bayer EBR (no credentials, `@bayer.com` sender) | `snippets/email/smtp-client.ts` / `.py` |
| WebSocket (Socket.IO) server + client | `snippets/realtime/*` |

Deployment, testing, and secrets depth: `.platform-rules/reference/*.md`.
