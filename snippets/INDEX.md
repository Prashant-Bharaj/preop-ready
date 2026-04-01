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

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Bayer LLM Client | JS | `llm/bayer-llm-client.js` | Direct chat completions via Bayer's internal LLM API |
| Bayer LLM Client | Python | `llm/bayer-llm-client.py` | Direct chat completions (async httpx) |
| MGA Assistant Client | JS | `llm/mga-assistant-client.js` | MGA assistant via ChatCompletion API |
| MGA Assistant Client | Python | `llm/mga-assistant-client.py` | MGA assistant via ChatCompletion API (async httpx) |

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
| Datepicker | Vanilla JS | `ui/datepicker-vanilla.js` | Date picker + date range picker (no framework) |

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

> **REQUIRED**: All projects MUST follow security best practices. See `.clinerules/18-security.md`

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Sanitize Middleware | JS | `security/sanitize-middleware.js` | Global body/response sanitization + validation helpers |
| Sanitize Middleware | Python | `security/sanitize-middleware.py` | Global sanitization middleware for FastAPI |
| Input Validation | JS | `security/input-validation.js` | Per-route input validation (express-validator) |
| Input Validation | Python | `security/input-validation.py` | Pydantic models + sanitization helpers |
| Parameterized Queries | JS | `security/parameterized-queries.js` | Safe SQL queries (PostgreSQL/MySQL) |
| Parameterized Queries | Python | `security/parameterized-queries.py` | Safe SQL queries (asyncpg) |