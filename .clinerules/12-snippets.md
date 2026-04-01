# 📚 Code Snippet Library

## ⚠️ IMPORTANT: Check Snippets Before Writing Code

**When a user requests a feature, ALWAYS check the snippet library first!**

This saves tokens, ensures consistency, and uses pre-vetted code.

---

## 🔍 How to Use Snippets

### Step 1: Check the Index

When user asks for a feature, first read:
```
snippets/INDEX.md
```

### Step 2: If Snippet Exists

1. Read the snippet file
2. Copy the relevant code
3. Adapt to user's project:
   - Update variable names
   - Adjust import paths
   - Add project-specific customizations
4. Tell user: "I used a pre-built snippet for [X]"

### Step 3: If No Snippet Exists

Implement from scratch. No need to add it to the library.

---

## 📋 Available Snippet Categories

| Category | Folder | Common Uses |
|----------|--------|-------------|
| **Auth** | `snippets/auth/` | User identity, token refresh, roles & whitelisting |
| **File Handling** | `snippets/file-handling/` | File uploads (memory-based) |
| **AI / LLM** | `snippets/llm/` | Direct LLM chat, MGA assistant (threads/runs) |
| **SharePoint** | `snippets/sharepoint/` | Fetch files from SharePoint via Graph API |
| **Email** | `snippets/email/` | Send emails via Bayer SMTP |
| **UI Components** | `snippets/ui/` | Datepicker (React + Vanilla) |
| **Realtime** | `snippets/realtime/` | WebSocket (Socket.IO) server + client |
| **Configuration** | `snippets/config/` | App settings (runtime), CORS setup |
| **Security** | `snippets/security/` | Input validation, parameterized SQL queries |

---

## 🎯 Feature → Snippet Mapping

When user says... → Check this snippet:

| User Request | JS Snippet | Python Snippet |
|--------------|------------|----------------|
| "Who is logged in" / "User identity" | `auth/user-identity.js` | `auth/user-identity.py` |
| "Session expired" / "Token timeout" | `auth/token-refresh.js` | — (frontend only) |
| "User roles" / "Admin only" / "Whitelist" | `auth/user-roles.js` + schema | `auth/user-roles.py` + same schema |
| "User management page" | `auth/UserManagement.jsx` | — (React frontend) |
| "Upload files" | `file-handling/upload-handler.js` | `file-handling/upload-handler.py` |
| "Extract text" / "Parse PDF" / "Read DOCX" | `file-handling/document-text-extractor.js` | `file-handling/document-text-extractor.py` |
| "Call LLM" / "AI chat" / "GPT" | `llm/bayer-llm-client.js` | `llm/bayer-llm-client.py` |
| "MGA assistant" | `llm/mga-assistant-client.js` | `llm/mga-assistant-client.py` |
| "SharePoint" / "OneDrive" / "Graph API" | `sharepoint/sharepoint-client.js` | `sharepoint/sharepoint-client.py` |
| "Send email" / "SMTP" | `email/smtp-client.js` | `email/smtp-client.py` |
| "Date picker" / "Calendar input" (React) | `ui/datepicker-react.jsx` | — (frontend only) |
| "Date picker" / "Calendar input" (Vanilla) | `ui/datepicker-vanilla.js` | — (frontend only) |
| "WebSocket" / "Real-time" / "Live updates" | `realtime/websocket-helper.js` | `realtime/websocket-helper.py` |
| "App settings" / "Config without redeploy" | `config/app-settings.js` + schema | `config/app-settings.py` + same schema |
| "Settings page" / "Admin settings" | `config/AppSettings.jsx` | — (React frontend) |
| "CORS error" / "Cross-origin" | `config/cors-proxy.js` | `config/cors-middleware.py` |
| "Sanitize" / "Strip HTML" / "Global middleware" | `security/sanitize-middleware.js` | `security/sanitize-middleware.py` |
| "Validate input" / "Sanitize data" | `security/input-validation.js` | `security/input-validation.py` |
| "Database queries" / "SQL" | `security/parameterized-queries.js` | `security/parameterized-queries.py` |

> **Note:** Pick JS or Python based on the user's backend stack. Frontend snippets (React, Vanilla JS) work with both backends.

---

## 💬 How to Communicate

### When Using a Snippet

```
I'll use a pre-built snippet for [file uploads] - this follows best practices
and saves us time. Let me adapt it to your project...
```

### When No Snippet Exists

```
I don't have a pre-built snippet for [this feature], so I'll implement it
from scratch. This will be custom code for your project.
```

---

## 📦 Recommended Libraries

**ALWAYS use these libraries when the user needs the feature.** This keeps the ecosystem consistent across projects and ensures compatibility with platform snippets.

### Backend (Node.js)

| Purpose | Library | Why |
|---------|---------|-----|
| **HTTP client** | `axios` | Used across all snippets, clean API |
| **File uploads** | `multer` | Express standard, memory + disk storage |
| **PDF text extraction** | `pdf-parse` | Simple, no native deps |
| **DOCX text extraction** | `mammoth` | Clean text output, lightweight |
| **Excel parsing** | `exceljs` | Reads XLS + XLSX, streaming support |
| **PPTX text extraction** | `adm-zip` | Extract text from zip-based formats |
| **CSV parsing** | `csv-parse` | Streaming support for large files |
| **Email** | `nodemailer` | Standard Node.js mailer |
| **WebSocket** | `socket.io` | Rooms, auth middleware, auto-reconnect |
| **Input validation** | `express-validator` | Middleware-based, sanitization built-in |
| **Date manipulation** | `date-fns` | Lightweight, tree-shakeable (avoid moment.js) |
| **UUID generation** | `uuid` | Standard RFC4122 UUIDs |
| **Encryption / hashing** | `bcrypt` | Password hashing (use built-in `crypto` for general hashing) |
| **Scheduling / cron** | `node-cron` | Simple cron-like task scheduling |
| **Database (PostgreSQL)** | `pg` | Official PostgreSQL driver |
| **Database (MySQL)** | `mysql2` | Promise-based, prepared statements |

### Backend (Python)

| Purpose | Library | Why |
|---------|---------|-----|
| **Web framework** | `fastapi` | Async, auto-docs, type hints |
| **ASGI server** | `uvicorn` | Standard FastAPI server |
| **HTTP client** | `httpx` | Async support, similar to requests |
| **PDF text extraction** | `pypdf` or `pdfplumber` | pdfplumber for tables, pypdf for simple text |
| **DOCX text extraction** | `python-docx` | Read/write Word documents |
| **Excel parsing** | `openpyxl` | Read/write XLSX (or `pandas` for data analysis) |
| **CSV parsing** | `csv` (built-in) | Standard library, no install needed |
| **Data analysis** | `pandas` | DataFrames, CSV/Excel/JSON I/O |
| **Email** | `smtplib` (built-in) | Standard library SMTP client |
| **WebSocket** | `python-socketio` | Socket.IO compatible with JS client |
| **Input validation** | `pydantic` | Built into FastAPI, type-safe |
| **Date manipulation** | `datetime` (built-in) | Standard library (use `pendulum` for complex tz handling) |
| **Database (PostgreSQL)** | `asyncpg` or `psycopg2` | asyncpg for async, psycopg2 for sync |
| **Database (MySQL)** | `aiomysql` or `pymysql` | aiomysql for async, pymysql for sync |
| **ORM** | `sqlalchemy` | Industry standard, async support in v2 |
| **LLM / AI calls** | `openai` | OpenAI-compatible API client (works with Bayer MGA) |
| **Charts (server-side)** | `matplotlib` or `plotly` | Generate chart images or interactive HTML |

### Frontend (React)

| Purpose | Library | Why |
|---------|---------|-----|
| **Charts / dashboards** | `recharts` | React-native, composable, responsive |
| **Complex charts** | `chart.js` + `react-chartjs-2` | More chart types, canvas-based, performant |
| **Data tables** | `@tanstack/react-table` | Headless, sorting/filtering/pagination built-in |
| **Icons** | `lucide-react` | Clean, consistent, tree-shakeable |
| **Date picker** | Use platform snippet | `ui/datepicker-react.jsx` (no external dep needed) |
| **Form handling** | `react-hook-form` | Minimal re-renders, validation built-in |
| **Animations** | `framer-motion` | Declarative, spring physics, layout animations |
| **Toast notifications** | `react-hot-toast` | Lightweight, customizable |
| **Rich text editor** | `@tiptap/react` | Extensible, ProseMirror-based |
| **Markdown rendering** | `react-markdown` | Safe rendering, supports GFM |
| **PDF generation** | `@react-pdf/renderer` | React components to PDF output |
| **Export to CSV/Excel** | `exceljs` | `workbook.xlsx.writeBuffer()` for export |
| **Drag and drop** | `@dnd-kit/core` | Accessible, flexible, performant |
| **Syntax highlighting** | `react-syntax-highlighter` | Code blocks with theme support |

### Frontend (Vanilla JS)

| Purpose | Library | Why |
|---------|---------|-----|
| **Charts** | `chart.js` | No framework dependency, canvas-based |
| **Animations** | `gsap` | Industry standard, performant |
| **Date picker** | Use platform snippet | `ui/datepicker-vanilla.js` (no external dep needed) |
| **Drag and drop** | `sortablejs` | Simple, no dependencies |

### Libraries to AVOID

| ❌ Don't Use | ✅ Use Instead | Why |
|-------------|---------------|-----|
| `moment.js` | `date-fns` | Moment is deprecated, bloated (330KB) |
| `request` | `axios` | Request is deprecated |
| `body-parser` | `express.json()` | Built into Express 4.16+ |
| `node-fetch` | `axios` | Consistency with snippets (or use built-in `fetch` in Node 18+) |
| `jquery` | Vanilla JS / React | Not needed in modern apps |
| `lodash` (full) | `lodash-es` or native methods | Full lodash is 70KB, most methods exist natively |
| `d3` (for simple charts) | `recharts` or `chart.js` | D3 is overkill for common chart types |

> **Note:** If a user specifically requests a library not on this list, that's fine — these are recommendations, not hard rules. But always check if a recommended alternative would work first.

---

## ⚠️ Important Notes

1. **Always check INDEX.md first** - don't re-implement existing code
2. **Snippets are templates** - adapt them to the user's specific needs
3. **Keep snippets generic** - they should work across projects
4. **Document dependencies** - snippets should list required packages
