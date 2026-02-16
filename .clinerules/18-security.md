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
FROM node:20-alpine

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
CMD ["node", "src/index.js"]
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
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine

# Create non-root user for nginx
RUN addgroup -g 1001 -S appgroup && \
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

## 🛡️ Input Validation (REQUIRED)

**NEVER trust user input.** Validate ALL inputs server-side.

### Node.js/Express Validation

```javascript
// Use express-validator for input validation
const { body, validationResult } = require('express-validator');

// Route with validation
app.post('/users',
  // Validation rules
  body('email').isEmail().normalizeEmail(),
  body('name').trim().isLength({ min: 1, max: 100 }).escape(),
  body('age').optional().isInt({ min: 0, max: 150 }),
  
  // Handler
  (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    // Safe to use validated data
    const { email, name, age } = req.body;
    // ... process request
  }
);
```

### Python/FastAPI Validation

```python
from pydantic import BaseModel, EmailStr, constr, conint
from fastapi import HTTPException

# Define validated model
class UserCreate(BaseModel):
    email: EmailStr
    name: constr(min_length=1, max_length=100)
    age: conint(ge=0, le=150) | None = None

# Route with automatic validation
@app.post("/users")
def create_user(user: UserCreate):
    # Pydantic already validated - safe to use
    return {"email": user.email, "name": user.name}
```

### Validation Rules to Apply

| Input Type | Validation |
|-----------|------------|
| Email | Use email validator, normalize |
| Names/Text | Trim whitespace, limit length, escape HTML |
| Numbers | Check type, range (min/max) |
| IDs | Validate format (UUID, integer) |
| URLs | Validate URL format, whitelist domains if needed |
| File uploads | Check type, size, scan for malware |
| Dates | Parse with library, validate range |

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

## 🔐 Secrets Management

### Never Hardcode Secrets

```javascript
// ❌ WRONG - hardcoded secret
const apiKey = "sk-abc123xyz";

// ✅ CORRECT - from environment
const apiKey = process.env.API_KEY;
```

### Don't Log Sensitive Data

```javascript
// ❌ WRONG - logging sensitive data
console.log('User login:', { email, password });

// ✅ CORRECT - redact sensitive fields
console.log('User login:', { email, password: '[REDACTED]' });
```

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
