# 🔒 Security Hardening

> **Security is NOT optional.** These rules MUST be followed for all projects.

---

## 🎯 Security Checklist

Before deployment, verify:

- [ ] NGINX has security headers (see below)
- [ ] Containers run as non-root user
- [ ] All user inputs are validated server-side
- [ ] Database queries are parameterized (no string concatenation)
- [ ] No secrets hardcoded in code
- [ ] Sensitive data not logged

---

## 🌐 NGINX Security Headers (REQUIRED)

**Add these to EVERY nginx.conf file at the server block level:**

```nginx
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # ============================================
    # SECURITY HEADERS - REQUIRED!
    # ============================================
    
    # Hide nginx version (prevents information leakage)
    server_tokens off;
    
    # Prevent clickjacking attacks
    add_header X-Frame-Options "SAMEORIGIN" always;
    
    # Prevent MIME type sniffing
    add_header X-Content-Type-Options "nosniff" always;
    
    # Enable XSS filter in browsers
    add_header X-XSS-Protection "1; mode=block" always;

    # ============================================
    # ... rest of your config ...
    # ============================================
    
    location /health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Why These Headers Matter

| Header | Protects Against |
|--------|-----------------|
| `server_tokens off` | Information disclosure - hides nginx version from attackers |
| `X-Frame-Options "SAMEORIGIN"` | Clickjacking - prevents embedding your site in iframes |
| `X-Content-Type-Options "nosniff"` | MIME sniffing attacks - forces browser to trust declared content-type |
| `X-XSS-Protection "1; mode=block"` | XSS attacks - enables browser's built-in XSS filter |

### ⚠️ Use `always` Keyword

The `always` keyword ensures headers are added to ALL responses, including error pages (4xx, 5xx). Without it, attackers could exploit error pages.

```nginx
# ✅ CORRECT - headers apply to all responses including errors
add_header X-Frame-Options "SAMEORIGIN" always;

# ❌ WRONG - headers won't apply to 404, 500, etc.
add_header X-Frame-Options "SAMEORIGIN";
```

---

## 🐳 Non-Root Container User (REQUIRED)

**Run containers as non-root user for defense in depth.**

If an attacker exploits your application, running as root gives them full control of the container, making it easier to escape and attack the host system.

### Node.js Dockerfile (Secure)

```dockerfile
# Node.js Backend - SECURE
FROM node:22-alpine

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy package files and install dependencies as root
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY --chown=appuser:appgroup . .

# Switch to non-root user
USER appuser

EXPOSE 3000
CMD ["node", "server.js"]
```

### Python Dockerfile (Secure)

```dockerfile
# Python Backend - SECURE
FROM python:3.11-slim

# Create non-root user
RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/bash appuser

WORKDIR /app

# Install dependencies as root
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY --chown=appuser:appgroup . .

# Switch to non-root user
USER appuser

EXPOSE 3000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3000"]
```

### React/Vanilla Frontend Dockerfile (Secure)

```dockerfile
# React Frontend - SECURE
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine

# Install curl (required for ECS health checks) and create non-root user
RUN apk add --no-cache curl && \
    addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    # nginx needs to write to these directories
    chown -R appuser:appgroup /var/cache/nginx && \
    chown -R appuser:appgroup /var/log/nginx && \
    chown -R appuser:appgroup /etc/nginx/conf.d && \
    touch /var/run/nginx.pid && \
    chown appuser:appgroup /var/run/nginx.pid

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Switch to non-root user
USER appuser

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
```

### Why Non-Root Matters

| Scenario | As Root | As Non-Root |
|----------|---------|-------------|
| Attacker exploits app bug | Full container control, easier host escape | Limited permissions, contained damage |
| File system access | Can modify any file | Only files owned by appuser |
| Network operations | Can bind to privileged ports | Restricted to unprivileged ports |
| Container escape attempt | Higher success chance | Much harder |

---

## 🛡️ Input Validation & Sanitization (REQUIRED)

**NEVER trust user input.** Validate ALL inputs server-side.

### ⚡ AI Rule: Always Validate and Sanitize

**When generating ANY Express/FastAPI app, ALWAYS apply these patterns:**

1. **Add global sanitization middleware** — use snippet `security/sanitize-middleware.js` (or `.py`)
   - `sanitizeBody` strips HTML from ALL incoming request body strings
   - `sanitizeResponse` strips HTML from ALL outgoing JSON responses
   - Apply BEFORE routes — this is your safety net
2. **Set explicit body size limit** — `express.json({ limit: '1mb' })` (adjust based on use case; file uploads use multer separately)
3. **Validate `:id` params** with `isPositiveInt()` on EVERY route that takes an ID
4. **Validate query params** against allowed values (don't just pass them through)
5. **Enforce max lengths** on all string fields matching DB column sizes
6. **Check required fields** on POST/PUT — return 400 if missing
7. **Never return `error.message`** to clients — use generic messages for 500s
8. **Add a global error handler** — AFTER all routes

### Setup (Node.js/Express)

```javascript
const express = require('express');
const { applySecurityMiddleware, globalErrorHandler } = require('./middleware/sanitize');

const app = express();

// Apply global sanitization BEFORE routes
applySecurityMiddleware(app);

// ... define routes here ...

// Global error handler AFTER routes
app.use(globalErrorHandler);
```

### Setup (Python/FastAPI)

```python
from fastapi import FastAPI
from sanitize_middleware import apply_security_middleware

app = FastAPI()
apply_security_middleware(app)

# ... define routes here ...
```

### Per-Route Validation Example

```javascript
const { isPositiveInt, isAllowedValue, validateRequiredFields, enforceMaxLengths } = require('./middleware/sanitize');

app.get('/items/:id', (req, res) => {
  if (!isPositiveInt(req.params.id)) {
    return res.status(400).json({ error: 'ID must be a positive integer' });
  }
  // ...
});

app.get('/items', (req, res) => {
  const { status, sort } = req.query;
  if (status && !isAllowedValue(status, ['active', 'archived', 'draft'])) {
    return res.status(400).json({ error: 'Invalid status value' });
  }
  // ...
});

app.post('/items', (req, res) => {
  const missing = validateRequiredFields(req.body, ['title', 'description']);
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }
  const tooLong = enforceMaxLengths(req.body, { title: 200, description: 2000 });
  if (tooLong.length) {
    return res.status(400).json({ error: `Fields too long: ${tooLong.map(v => v.field).join(', ')}` });
  }
  // ...
});
```

### Validation Rules to Apply

| Input Type | Validation |
|-----------|------------|
| Email | Use email validator, normalize |
| Names/Text | Trim whitespace, limit length, escape HTML |
| Numbers | Check type, range (min/max) |
| IDs | Validate format (UUID, integer) — use `isPositiveInt()` |
| URLs | Validate URL format, whitelist domains if needed |
| File uploads | Check type, size, scan for malware |
| Dates | Parse with library, validate range |
| Query params | Validate against allowed values — use `isAllowedValue()` |
| Settings keys | Validate format (e.g. `/^[a-z0-9_]+$/`) |

---

## 💾 SQL Injection Prevention (REQUIRED)

**NEVER build SQL queries with string concatenation!**

### ❌ WRONG - Vulnerable to SQL Injection

```javascript
// ❌ EXTREMELY DANGEROUS - Never do this!
const userId = req.params.id;
const query = `SELECT * FROM users WHERE id = ${userId}`;
// Attacker can send: id = "1; DROP TABLE users;--"

// ❌ Also dangerous with string concatenation
const query = "SELECT * FROM users WHERE name = '" + userName + "'";
```

### ✅ CORRECT - Parameterized Queries

**Node.js with PostgreSQL (pg):**

```javascript
const { Pool } = require('pg');
const pool = new Pool();

// ✅ Parameterized query - SAFE
app.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  
  // $1 is a parameter placeholder
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [id]  // Parameters are safely escaped
  );
  
  res.json(result.rows);
});

// ✅ Multiple parameters
app.post('/users', async (req, res) => {
  const { name, email } = req.body;
  
  const result = await pool.query(
    'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
    [name, email]
  );
  
  res.json(result.rows[0]);
});
```

**Node.js with MySQL (mysql2):**

```javascript
const mysql = require('mysql2/promise');
const pool = mysql.createPool({ /* config */ });

// ✅ Parameterized query - SAFE
app.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  
  // ? is a parameter placeholder in MySQL
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE id = ?',
    [id]
  );
  
  res.json(rows);
});
```

**Python with SQLAlchemy:**

```python
from sqlalchemy import text
from sqlalchemy.orm import Session

# ✅ Parameterized query - SAFE
@app.get("/users/{user_id}")
def get_user(user_id: int, db: Session = Depends(get_db)):
    result = db.execute(
        text("SELECT * FROM users WHERE id = :id"),
        {"id": user_id}
    )
    return result.fetchone()

# ✅ Using ORM (even safer)
@app.get("/users/{user_id}")
def get_user(user_id: int, db: Session = Depends(get_db)):
    return db.query(User).filter(User.id == user_id).first()
```

### SQL Security Checklist

- [ ] ALL queries use parameterized statements
- [ ] Never use string concatenation or f-strings for queries
- [ ] Use ORM when possible (SQLAlchemy, Prisma, Sequelize)
- [ ] Validate input types before querying
- [ ] Limit query results (pagination)
- [ ] Use least-privilege database users

---

## 🚨 Error Response Handling (REQUIRED)

**All API endpoints must return descriptive JSON error responses. Never return plain text errors or expose stack traces.**

### Standard Error Response Format

```json
{
  "error": "NOT_FOUND",
  "message": "User with ID 42 was not found",
  "statusCode": 404
}
```

### HTTP Status Code Guide

| Code | When to Use |
|------|-------------|
| 400 | Bad request — invalid input, missing fields |
| 401 | Unauthorized — not authenticated |
| 403 | Forbidden — authenticated but no permission |
| 404 | Not found — resource doesn't exist |
| 409 | Conflict — duplicate entry, version mismatch |
| 422 | Unprocessable — valid format but failed business rules |
| 429 | Too many requests — rate limited |
| 500 | Internal error — unexpected server failure |

### ❌ WRONG — Generic/Dangerous Error Responses

```javascript
// ❌ No useful information
res.status(500).send('Error');

// ❌ Exposes internal details (stack trace, file paths)
res.status(500).json({ error: err.stack });

// ❌ Plain text error
res.status(400).send('Bad request');
```

### ✅ CORRECT — Node.js/Express Error Middleware

```javascript
// Error handler middleware — add AFTER all routes
app.use((err, req, res, next) => {
  console.error(err); // Log full error server-side

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.code || 'INTERNAL_ERROR',
    message: statusCode === 500
      ? 'An unexpected error occurred'  // Hide internal details
      : err.message,
    statusCode
  });
});

// Throwing errors in routes
app.get('/users/:id', async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      err.code = 'NOT_FOUND';
      throw err;
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
});
```

### ✅ CORRECT — Python/FastAPI Exception Handler

```python
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

@app.exception_handler(Exception)
async def generic_exception_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={
            "error": "INTERNAL_ERROR",
            "message": "An unexpected error occurred",
            "statusCode": 500
        }
    )

# Raising errors in routes
@app.get("/users/{user_id}")
def get_user(user_id: int):
    user = find_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user
```

### Security Rules for Errors
- **Never expose stack traces** in production responses
- **Never reveal internal paths**, database details, or library versions
- **Always log the full error server-side** (for debugging)
- **Use generic messages for 500 errors** — "An unexpected error occurred"
- **Be specific for 4xx errors** — help the client fix their request

---

## 🔐 Secrets Management

### Never Hardcode Secrets

```javascript
// ❌ WRONG - hardcoded secret
const apiKey = "sk-abc123xyz";

// ✅ CORRECT - from environment
const apiKey = process.env.API_KEY;
```

### ⛔ Logging Restrictions — Must Not Log

These rules are mandatory. The pre-commit hook will warn if it detects dangerous logging patterns.

**NEVER log any of the following:**

| Forbidden | Examples | Why |
|-----------|----------|-----|
| Request/response payloads | `console.log(req.body)`, `print(request.json())` | May contain user-submitted PII or sensitive data |
| File content or upload data | `console.log(req.file)`, `console.log(req.files)` | Uploaded files may contain confidential documents |
| Secrets, tokens, credentials | `console.log(apiKey)`, `console.log(req.headers.authorization)` | Secrets end up in CloudWatch, visible to platform admins |
| Auth headers | `console.log(req.headers)` | Contains OIDC tokens and session data |
| PII fields | `console.log(user.email)`, `console.log(user.name)` | Personal data in logs violates GDPR principles |

**Safe logging patterns:**

```javascript
// ❌ NEVER — logs entire request body (may contain PII, passwords, sensitive data)
console.log('Request:', req.body);
console.log('Headers:', req.headers);
console.log('File:', req.file);
console.log('User:', { email, password });

// ✅ SAFE — log only what you need, redact sensitive fields
console.log('Request received:', { path: req.path, method: req.method });
console.log('User action:', { userId: req.user?.userId, action: 'login' });
console.log('Upload:', { filename: req.file?.originalname, size: req.file?.size });
console.log('User login:', { email, password: '[REDACTED]' });
```

```python
# ❌ NEVER
print(request.body)
logger.info(f"Request: {request.json()}")
logger.info(f"Headers: {request.headers}")

# ✅ SAFE
logger.info(f"Request: {request.method} {request.url.path}")
logger.info(f"Upload: filename={file.filename} size={file.size}")
```

**When debugging locally**, you may temporarily log payloads — but **remove all debug logging before committing**. The pre-commit hook will warn you if it detects `console.log(req.body)` or similar patterns in staged files.

### Use GitHub Secrets for Production

See `08-secrets.md` for details on adding secrets via GitHub.

---

## 🚫 Common Security Mistakes

| Mistake | Risk | Fix |
|---------|------|-----|
| Missing security headers | XSS, clickjacking | Add headers to nginx.conf |
| Running as root | Container escape | Use non-root USER in Dockerfile |
| String concatenation in SQL | SQL injection | Use parameterized queries |
| No input validation | Various attacks | Validate server-side |
| Hardcoded secrets | Credential exposure | Use environment variables |
| Logging passwords/tokens | Credential exposure | Redact sensitive data |
| Missing rate limiting | DoS attacks | Add rate limiting middleware |

---

## 💬 How to Communicate

### When Building for Users

```
I'll add security hardening to your app:

- Security headers to prevent common attacks
- Non-root container user for defense in depth  
- Input validation on all endpoints
- Parameterized database queries

This is automatic - you don't need to do anything extra!
```

### When User Asks About Security

```
Good question! The platform includes several security layers:

1. **NGINX security headers** - Prevent XSS, clickjacking, MIME sniffing
2. **Non-root containers** - Limit damage if app is compromised
3. **Input validation** - Server-side validation on all inputs
4. **Parameterized queries** - Prevent SQL injection

All code I generate follows these patterns automatically.
```

---

## 🎯 Summary

| Area | Requirement |
|------|-------------|
| **NGINX** | Add security headers with `always` keyword |
| **Containers** | Run as non-root user |
| **Inputs** | Validate ALL user inputs server-side |
| **Database** | Use parameterized queries ONLY |
| **Secrets** | Never hardcode, use environment variables |
| **Logging** | Never log passwords, tokens, or PII |
