# Security Rules

## Never Hardcode Secrets

```javascript
// ❌ WRONG - Will be caught by linting and GitHub
const password = "secret123";
const apiKey = "sk-abc123";

// ✅ CORRECT - Use environment variables
const password = process.env.DATABASE_PASSWORD;
const apiKey = process.env.API_KEY;
```

```python
# ❌ WRONG
password = "secret123"

# ✅ CORRECT
import os
password = os.environ.get('DATABASE_PASSWORD')
```

## Linting Configuration (Auto-Generated)

### Node.js → `eslint.config.js`

Copied from `examples/eslint.config.js`. Includes security plugins that catch:
- Hardcoded secrets
- SQL injection risks
- Unsafe regex patterns
- Command injection
- Buffer vulnerabilities

Users with Node.js installed can run:
```bash
npm run lint
```

### Python → `ruff.toml`

Copied from `examples/ruff.toml`. Includes bandit security rules that catch:
- Hardcoded passwords
- SQL injection
- Unsafe deserialization
- Command injection
- Unsafe temp file usage

Users with Python installed can run:
```bash
ruff check .
```

## GitHub Security Checks

On every push, GitHub automatically runs:
- **CodeQL** - Deep security vulnerability scanning
- **Dependency Review** - Checks for vulnerable packages

If issues found:
- Deployment is **blocked**
- Email notification sent with details

## Authentication

All demos are protected by EntraID SSO at the ALB level. Users must log in with Bayer credentials.

Backend can read authenticated user:

```javascript
// Node.js
app.get('/api/me', (req, res) => {
  const email = req.headers['x-amzn-oidc-identity'];
  res.json({ email });
});
```

```python
# Python/FastAPI
@app.get("/api/me")
def get_me(request: Request):
    email = request.headers.get('x-amzn-oidc-identity')
    return {"email": email}
```
