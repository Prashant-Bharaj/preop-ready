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

### 🤖 LLM / AI Integration

| Snippet | Language | File | Description | Status |
|---------|----------|------|-------------|--------|
| Bayer LLM Client | JS | `llm/bayer-llm-client.js` | Connect to internal LLM API | 🔜 TODO |
| Bayer LLM Client | Python | `llm/bayer-llm-client.py` | Connect to internal LLM API | 🔜 TODO |
| OpenAI Client | JS | `llm/openai-client.js` | OpenAI API wrapper | 🔜 TODO |

### 📁 File Handling

> ⚠️ **IMPORTANT**: All file handlers use MEMORY storage - files are NOT saved to disk!
> This is intentional - containers are ephemeral.

| Snippet | Language | File | Description | Status |
|---------|----------|------|-------------|--------|
| File Upload | JS | `file-handling/upload-handler.js` | Handle file uploads (memory, not disk!) | ✅ Ready |
| File Download | JS | `file-handling/download-handler.js` | Generate downloadable files | 🔜 TODO |
| File Upload | Python | `file-handling/upload-handler.py` | Handle file uploads (FastAPI) | 🔜 TODO |

### 📊 Data Parsing

| Snippet | Language | File | Description | Status |
|---------|----------|------|-------------|--------|
| CSV Parser | JS | `parsing/csv-parser.js` | Parse CSV with headers | 🔜 TODO |
| Excel Parser | JS | `parsing/excel-parser.js` | Parse .xlsx files | 🔜 TODO |
| PDF Text Extract | JS | `parsing/pdf-parser.js` | Extract text from PDF | 🔜 TODO |
| PDF Text Extract | Python | `parsing/pdf-parser.py` | Extract text from PDF | 🔜 TODO |
| JSON Handler | JS | `parsing/json-handler.js` | Safe JSON parse/stringify | 🔜 TODO |

### 🔐 Authentication

| Snippet | Language | File | Description | Status |
|---------|----------|------|-------------|--------|
| User Identity | JS | `auth/user-identity.js` | Get logged-in user from OIDC headers | ✅ Ready |
| User Identity | Python | `auth/user-identity.py` | Get logged-in user (FastAPI/Flask) | ✅ Ready |
| Bayer SSO | JS | `auth/bayer-sso.js` | Integrate with Bayer SSO | 🔜 TODO |
| JWT Handler | JS | `auth/jwt-handler.js` | JWT token management | 🔜 TODO |
| Basic Auth | JS | `auth/basic-auth.js` | Simple username/password | 🔜 TODO |

### 🔒 Security

> ⚠️ **REQUIRED**: All projects MUST follow security best practices. See `.clinerules/18-security.md`

| Snippet | Language | File | Description | Status |
|---------|----------|------|-------------|--------|
| Input Validation | JS | `security/input-validation.js` | Server-side input validation (express-validator) | ✅ Ready |
| Parameterized Queries | JS | `security/parameterized-queries.js` | Safe SQL queries (PostgreSQL/MySQL) | ✅ Ready |
| Input Validation | Python | `security/input-validation.py` | Server-side validation (Pydantic) | 🔜 TODO |

### 🎨 UI Components (React)

| Snippet | Language | File | Description | Status |
|---------|----------|------|-------------|--------|
| File Upload Form | React | `ui-components/file-upload-form.jsx` | Drag-drop file upload UI | 🔜 TODO |
| Data Table | React | `ui-components/data-table.jsx` | Sortable, filterable table | 🔜 TODO |
| Export Button | React | `ui-components/export-button.jsx` | Export data as CSV/Excel | 🔜 TODO |
| Loading Spinner | React | `ui-components/loading-spinner.jsx` | Animated loading indicator | 🔜 TODO |
| Modal Dialog | React | `ui-components/modal-dialog.jsx` | Reusable modal component | 🔜 TODO |

---

## Status Legend

| Icon | Meaning |
|------|---------|
| ✅ | Ready to use |
| 🔜 | Placeholder - TODO |
| ⚠️ | Needs update |

---

## Adding New Snippets

When adding a new snippet:

1. Create the file in the appropriate category folder
2. Follow the snippet file format (see any existing snippet)
3. Update this INDEX.md with the new entry
4. Change status from 🔜 to ✅

---

## Snippet File Format

Each snippet should include:

```javascript
/**
 * SNIPPET: [Name]
 * CATEGORY: [Category]
 * LANGUAGE: [JS/Python/React]
 * 
 * DESCRIPTION: 
 *   [What this snippet does]
 * 
 * DEPENDENCIES: 
 *   [npm/pip packages needed]
 * 
 * ENVIRONMENT VARIABLES:
 *   [Required env vars]
 * 
 * USAGE:
 *   [How to use this snippet]
 * 
 * EXAMPLE:
 *   [Code example]
 */

// ... actual code ...
```
