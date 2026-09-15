# Code Snippet Library

> **AI INSTRUCTION**: Read this file FIRST when user requests a feature.
> If a snippet exists for what the user needs, USE IT instead of writing from scratch.
> This saves time and ensures consistency with Bayer best practices.

---

## How to Use This Library

1. **Search this index** for relevant snippets
2. **Read the snippet file** if found
3. **Adapt the code** to user's project
4. **Tell the user** you used a pre-built snippet
5. **If no snippet exists**, implement from scratch

---

## Available Snippets

### Dockerfile Templates

Byte-deployable Dockerfile templates per scope. Copy via `copy_template(template="Dockerfile.X", dest="<scope>/Dockerfile")` (resolver fetches from `snippets/<scope>/`); or fetch as prose via `get_snippet({path: "<scope>/Dockerfile.X"})` for inlining.

| Template | Scope | File | Purpose |
|----------|-------|------|---------|
| Node + Express | backend | `backend/Dockerfile.node` | Node.js runtime, `npm install`, EXPOSE 3000 |
| Python + FastAPI/Flask | backend | `backend/Dockerfile.python` | Python runtime, `pip install`, `uvicorn main:app`, EXPOSE 3000 |
| Rust + Cargo | backend | `backend/Dockerfile.rust` | Multi-stage Rust build, EXPOSE 3000 |
| React + Vite | frontend | `frontend/Dockerfile.react` | Multi-stage build (Node → nginx), non-root, EXPOSE 8080 |
| PostgreSQL | database | `database/Dockerfile.postgres` | EFS-aware (`PGDATA=/data`), init scripts |
| pgvector | vectordb | `vectordb/Dockerfile.pgvector` | Pinned to `pgvector/pgvector:0.7.4-pg16` (upstream `pg16` floating tag is unreliable) |

### Authentication & Access Control

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| User Identity | TS | `auth/user-identity.ts` | Get logged-in user from OIDC headers |
| User Identity | Python | `auth/user-identity.py` | Get logged-in user (FastAPI/Flask) |
| User Identity | Rust | `auth/user-identity.rs` | Get logged-in user (Actix-web) |
| Token Refresh | TS | `auth/token-refresh.ts` | Handle expired ALB sessions (auto-reload on 1hr timeout) |
| User Roles & Whitelisting | TS + SQL | `auth/user-roles.ts` + `auth/user-roles-schema.sql` | Role-based access control (user/expert/admin), approval workflow |
| User Roles & Whitelisting | Python | `auth/user-roles.py` | RBAC with FastAPI dependencies (same SQL schema) |
| User Management Page | React | `auth/UserManagement.tsx` | Admin page to approve/deny users and manage roles |

### File Handling

> **IMPORTANT**: All file handlers use MEMORY storage - files are NOT saved to disk!
> This is intentional - containers are ephemeral.

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| File Upload | TS | `file-handling/upload-handler.ts` | Handle file uploads (memory, not disk!) |
| File Upload | Python | `file-handling/upload-handler.py` | Handle file uploads (FastAPI UploadFile) |
| Document Text Extractor | TS | `file-handling/document-text-extractor.ts` | Extract text from PDF, DOCX, XLSX, PPTX, CSV for AI analysis |
| Document Text Extractor | Python | `file-handling/document-text-extractor.py` | Extract text from documents (pypdf, python-docx, openpyxl) |

### AI / LLM

> Apps wire credentials from the workspace-root `.env` (written by the harness,
> gitignored): `DATABASE_*`, `VECTORDB_*` and, for AI features, `MGA_API_KEY`,
> `MGA_BASE_URL`, `MGA_ASSISTANT_ID`. Compose references them as `${VAR}` and the
> backend loads the file via `env_file` — never a literal value in
> docker-compose.yml. See `.platform-rules/mga-platform.md` for the full
> capability catalog (models, tools, endpoints).

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| MGA Assistant Client | TS | `llm/mga-assistant-client.ts` | Canonical text chat with the per-app MGA assistant (`/chat/agent`, conversation_id memory) |
| MGA Assistant Client | Python | `llm/mga-assistant-client.py` | Same, async httpx |
| MGA Streaming Chat | TS | `llm/mga-streaming-chat.ts` | SSE-forwarder for real-time token rendering |
| MGA Streaming Chat | Python | `llm/mga-streaming-chat.py` | FastAPI SSE endpoint |
| MGA Vision Chat | TS | `llm/mga-vision-chat.ts` | Image input via `/chat/completions` multi-content blocks |
| MGA Vision Chat | Python | `llm/mga-vision-chat.py` | Same, httpx |
| MGA Embeddings | TS | `llm/mga-embedding.ts` | `/embeddings` for RAG (pairs with vectordb scope) |
| MGA Embeddings | Python | `llm/mga-embedding.py` | Same, async httpx |
| MGA File Upload | TS | `llm/mga-file-upload.ts` | Upload to `/assistants/{id}/files` for `uploaded_docs` RAG |
| MGA File Upload | Python | `llm/mga-file-upload.py` | Same, async httpx |
| Bayer LLM Client | TS | `llm/bayer-llm-client.ts` | Direct chat completions (no assistant) — alternative when MGA_ASSISTANT_ID isn't set |
| Bayer LLM Client | Python | `llm/bayer-llm-client.py` | Same, async httpx |
| Knowledge Base Client | JS + Python | `llm/knowledge-base-client.js` / `.py` | Managed RAG over an MGA Knowledge Base (preferred RAG path) |
| RAG Tools | JS + Python | `llm/rag-tools.js` / `.py` | Chunking + retrieval helpers for embeddings-based RAG |

### Microsoft 365 Integration

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| SharePoint Client | TS | `sharepoint/sharepoint-client.ts` | Fetch files from SharePoint/OneDrive via Microsoft Graph API |
| SharePoint Client | Python | `sharepoint/sharepoint-client.py` | Fetch files from SharePoint/OneDrive (async httpx) |
| Graph Proxy (backend) | JS + Python | `auth/graph-proxy-backend.js` / `.py` | Server-side Microsoft Graph via the platform proxy (SigV4, ECS task role) — see `auth/graph-proxy-operations.md` |
| Graph Proxy (browser) | JS | `auth/graph-proxy-client.js` | Microsoft Graph from the frontend (identity, SharePoint, calendar, mail) |
| Graph Proxy (offline) | JS + Python | `auth/graph-proxy-offline.js` / `.py` | App-only (daemon) Graph access, no signed-in user |

### Email

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| SMTP Client | TS | `email/smtp-client.ts` | Send emails via Bayer's internal SMTP server |
| SMTP Client | Python | `email/smtp-client.py` | Send emails via Bayer SMTP (built-in smtplib) |

### UI Components

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Datepicker | React | `ui/datepicker-react.tsx` | Date picker + date range picker with timezone-safe helpers |
| MGA Chat Panel | React | `frontend/MgaChatComponent.tsx` | Streaming chat UI consuming the backend's SSE proxy (pairs with `llm/mga-streaming-chat.ts`) |

### Realtime

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| WebSocket Helper | TS | `realtime/websocket-helper.ts` | Socket.IO server + client setup with auth and rooms |
| WebSocket Helper | Python | `realtime/websocket-helper.py` | Socket.IO server with FastAPI (python-socketio) |

### Configuration

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| App Settings | TS + SQL | `config/app-settings.ts` + `config/app-settings-schema.sql` | Runtime config from DB (change settings without redeploying) |
| App Settings | Python | `config/app-settings.py` | Runtime config from DB (asyncpg, same SQL schema) |
| DB Migration Runner | TS | `database/migration-runner.ts` | Staged by the harness at `backend/src/lib/migrate.ts`; applies `backend/migrations/NNN_*.sql` once each at startup (`_migrations` ledger) |
| DB Migration Runner | JS | `config/db-migrations.js` | Python/CommonJS reference for the same logic (`_migrations` table, sequential idempotent files) |
| Error Handler | JS + Python | `security/error-handler.js` / `.py` | Global JSON error middleware (structured `{error,message,statusCode}`, no stack leaks) |
| App Settings Page | React | `config/AppSettings.tsx` | Admin page for managing app settings |
| CORS & Proxy | TS | `config/cors-proxy.ts` | CORS middleware (when needed) + explanation of platform routing |
| CORS Middleware | Python | `config/cors-middleware.py` | FastAPI CORS middleware setup |

### Security

> **REQUIRED**: All projects MUST follow security best practices. See `.platform-rules/security.md` (served on demand — call `get_rules('security')`).

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Sanitize Middleware | TS | `security/sanitize-middleware.ts` | Global body/response sanitization + validation helpers |
| Sanitize Middleware | Python | `security/sanitize-middleware.py` | Global sanitization middleware for FastAPI |
| Input Validation | TS | `security/input-validation.ts` | Per-route input validation (express-validator) |
| Input Validation | Python | `security/input-validation.py` | Pydantic models + sanitization helpers |
| Parameterized Queries | TS | `security/parameterized-queries.ts` | Safe SQL queries (PostgreSQL/MySQL) |
| Parameterized Queries | Python | `security/parameterized-queries.py` | Safe SQL queries (asyncpg) |