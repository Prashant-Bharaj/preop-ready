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
| User Identity | JS | `auth/user-identity.js` | Get logged-in user from OIDC headers |
| User Identity | Python | `auth/user-identity.py` | Get logged-in user (FastAPI/Flask) |
| User Identity | Rust | `auth/user-identity.rs` | Get logged-in user (Actix-web) |
| Token Refresh | JS | `auth/token-refresh.js` | Handle expired ALB sessions (auto-reload on 1hr timeout) |
| User Roles & Whitelisting | JS + SQL | `auth/user-roles.js` + `auth/user-roles-schema.sql` | Role-based access control (user/expert/admin), approval workflow |
| User Roles & Whitelisting | Python | `auth/user-roles.py` | RBAC with FastAPI dependencies (same SQL schema) |
| User Management Page | React | `auth/UserManagement.jsx` | Admin page to approve/deny users and manage roles |

### File Handling

> **IMPORTANT**: All file handlers use MEMORY storage - files are NOT saved to disk!
> This is intentional - containers are ephemeral.

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| File Upload | JS | `file-handling/upload-handler.js` | Handle file uploads (memory, not disk!) |
| File Upload | Python | `file-handling/upload-handler.py` | Handle file uploads (FastAPI UploadFile) |
| Document Text Extractor | JS | `file-handling/document-text-extractor.js` | Extract text from PDF, DOCX, XLSX, PPTX, CSV for AI analysis |
| Document Text Extractor | Python | `file-handling/document-text-extractor.py` | Extract text from documents (pypdf, python-docx, openpyxl) |

### AI / LLM

> Apps with AI features wire env vars from workspace root `.env` (written by
> the harness during `/confirm`): `MGA_API_KEY`, `MGA_BASE_URL`,
> `MGA_ASSISTANT_ID`. See `.platform-rules/mga-platform.md` for the full
> capability catalog (models, tools, endpoints).

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| MGA Assistant Client | JS | `llm/mga-assistant-client.js` | Canonical text chat with the per-app MGA assistant (`/chat/agent`, conversation_id memory) |
| MGA Assistant Client | Python | `llm/mga-assistant-client.py` | Same, async httpx |
| MGA Streaming Chat | JS | `llm/mga-streaming-chat.js` | SSE-forwarder for real-time token rendering |
| MGA Streaming Chat | Python | `llm/mga-streaming-chat.py` | FastAPI SSE endpoint |
| MGA Vision Chat | JS | `llm/mga-vision-chat.js` | Image input via `/chat/completions` multi-content blocks |
| MGA Vision Chat | Python | `llm/mga-vision-chat.py` | Same, httpx |
| MGA Embeddings | JS | `llm/mga-embedding.js` | `/embeddings` for RAG (pairs with vectordb scope) |
| MGA Embeddings | Python | `llm/mga-embedding.py` | Same, async httpx |
| MGA File Upload | JS | `llm/mga-file-upload.js` | Upload to `/assistants/{id}/files` for `uploaded_docs` RAG |
| MGA File Upload | Python | `llm/mga-file-upload.py` | Same, async httpx |
| Bayer LLM Client | JS | `llm/bayer-llm-client.js` | Direct chat completions (no assistant) — alternative when MGA_ASSISTANT_ID isn't set |
| Bayer LLM Client | Python | `llm/bayer-llm-client.py` | Same, async httpx |

### Microsoft 365 Integration

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| SharePoint Client | JS | `sharepoint/sharepoint-client.js` | Fetch files from SharePoint/OneDrive via Microsoft Graph API |
| SharePoint Client | Python | `sharepoint/sharepoint-client.py` | Fetch files from SharePoint/OneDrive (async httpx) |

### Email

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| SMTP Client | JS | `email/smtp-client.js` | Send emails via Bayer's internal SMTP server |
| SMTP Client | Python | `email/smtp-client.py` | Send emails via Bayer SMTP (built-in smtplib) |

### UI Components

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Datepicker | React | `ui/datepicker-react.jsx` | Date picker + date range picker with timezone-safe helpers |
| MGA Chat Panel | React | `frontend/MgaChatComponent.jsx` | Streaming chat UI consuming the backend's SSE proxy (pairs with `llm/mga-streaming-chat.js`) |

### Realtime

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| WebSocket Helper | JS | `realtime/websocket-helper.js` | Socket.IO server + client setup with auth and rooms |
| WebSocket Helper | Python | `realtime/websocket-helper.py` | Socket.IO server with FastAPI (python-socketio) |

### Configuration

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| App Settings | JS + SQL | `config/app-settings.js` + `config/app-settings-schema.sql` | Runtime config from DB (change settings without redeploying) |
| App Settings | Python | `config/app-settings.py` | Runtime config from DB (asyncpg, same SQL schema) |
| App Settings Page | React | `config/AppSettings.jsx` | Admin page for managing app settings |
| CORS & Proxy | JS | `config/cors-proxy.js` | CORS middleware (when needed) + explanation of platform routing |
| CORS Middleware | Python | `config/cors-middleware.py` | FastAPI CORS middleware setup |

### Security

> **REQUIRED**: All projects MUST follow security best practices. See `.platform-rules/security.md` (served on demand — call `get_rules('security')`).

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Sanitize Middleware | JS | `security/sanitize-middleware.js` | Global body/response sanitization + validation helpers |
| Sanitize Middleware | Python | `security/sanitize-middleware.py` | Global sanitization middleware for FastAPI |
| Input Validation | JS | `security/input-validation.js` | Per-route input validation (express-validator) |
| Input Validation | Python | `security/input-validation.py` | Pydantic models + sanitization helpers |
| Parameterized Queries | JS | `security/parameterized-queries.js` | Safe SQL queries (PostgreSQL/MySQL) |
| Parameterized Queries | Python | `security/parameterized-queries.py` | Safe SQL queries (asyncpg) |