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

| User Request | Snippet to Check |
|--------------|------------------|
| "Who is logged in" / "User identity" (Node.js) | `auth/user-identity.js` |
| "Who is logged in" / "User identity" (Python) | `auth/user-identity.py` |
| "Who is logged in" / "User identity" (Rust) | `auth/user-identity.rs` |
| "Session expired" / "Token timeout" / "User gets stuck" | `auth/token-refresh.js` |
| "User roles" / "Admin only" / "Whitelist" / "Approve users" | `auth/user-roles.js` + `auth/user-roles-schema.sql` |
| "User management page" / "Admin panel for users" | `auth/UserManagement.jsx` |
| "Upload files" | `file-handling/upload-handler.js` |
| "Call LLM" / "AI chat" / "GPT" | `llm/bayer-llm-client.js` |
| "Assistant" / "Thread" / "MGA assistant" | `llm/mga-assistant-client.js` |
| "SharePoint" / "OneDrive" / "Graph API" / "Excel from SharePoint" | `sharepoint/sharepoint-client.js` |
| "Send email" / "SMTP" / "Notification email" | `email/smtp-client.js` |
| "Date picker" / "Calendar input" / "Date range" (React) | `ui/datepicker-react.jsx` |
| "Date picker" / "Calendar input" / "Date range" (Vanilla) | `ui/datepicker-vanilla.js` |
| "WebSocket" / "Real-time" / "Live updates" / "Chat" | `realtime/websocket-helper.js` |
| "App settings" / "Config without redeploy" / "Runtime config" | `config/app-settings.js` + `config/app-settings-schema.sql` |
| "Settings page" / "Admin settings" | `config/AppSettings.jsx` |
| "CORS error" / "Cross-origin" / "Proxy setup" | `config/cors-proxy.js` |
| "Validate input" / "Sanitize data" | `security/input-validation.js` |
| "Database queries" / "SQL" | `security/parameterized-queries.js` |

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

## ⚠️ Important Notes

1. **Always check INDEX.md first** - don't re-implement existing code
2. **Snippets are templates** - adapt them to the user's specific needs
3. **Keep snippets generic** - they should work across projects
4. **Document dependencies** - snippets should list required packages
