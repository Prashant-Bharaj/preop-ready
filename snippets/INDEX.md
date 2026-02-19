# 📚 Code Snippet Library

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

### 🔐 Authentication

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| User Identity | JS | `auth/user-identity.js` | Get logged-in user from OIDC headers |
| User Identity | Python | `auth/user-identity.py` | Get logged-in user (FastAPI/Flask) |
| User Identity | Rust | `auth/user-identity.rs` | Get logged-in user (Actix-web) |

### 📁 File Handling

> ⚠️ **IMPORTANT**: All file handlers use MEMORY storage - files are NOT saved to disk!
> This is intentional - containers are ephemeral.

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| File Upload | JS | `file-handling/upload-handler.js` | Handle file uploads (memory, not disk!) |

### 🔒 Security

> ⚠️ **REQUIRED**: All projects MUST follow security best practices. See `.clinerules/18-security.md`

| Snippet | Language | File | Description |
|---------|----------|------|-------------|
| Input Validation | JS | `security/input-validation.js` | Server-side input validation (express-validator) |
| Parameterized Queries | JS | `security/parameterized-queries.js` | Safe SQL queries (PostgreSQL/MySQL) |
