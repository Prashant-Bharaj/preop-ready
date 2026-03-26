# 👤 User Identity & Personalization

> **AWS ALB automatically authenticates users via Azure AD.**
> User identity is passed to your backend via HTTP headers - no auth code needed!

---

## 🎯 When to Use This

| User Wants... | Use This Guide |
|---------------|----------------|
| "Show my name in the app" | ✅ Yes |
| "Save my preferences" | ✅ Yes |
| "Each user has their own data" | ✅ Yes |
| "Personalized dashboard" | ✅ Yes |
| "Track who did what" | ✅ Yes |

---

## 📋 How It Works

```
User visits app
      │
      ▼
AWS ALB checks Azure AD login
      │
      ▼
ALB injects OIDC headers into request
      │
      ▼
Your backend reads headers → gets user info
```

**No authentication code needed!** AWS ALB handles login/logout automatically.

---

## 📨 OIDC Headers Available

When a request reaches your backend, AWS ALB injects these headers:

| Header | Content |
|--------|---------|
| `x-amzn-oidc-data` | JWT containing user claims (sub, email, name, etc.) |
| `x-amzn-oidc-identity` | User's unique subject ID |
| `x-amzn-oidc-accesstoken` | The OIDC access token |

---

## 🔧 Node.js Implementation

### Middleware: `backend/middleware/user-identity.js`

```javascript
/**
 * User Identity Middleware
 * Extracts user identity from AWS ALB OIDC headers
 */

function extractUserIdentity(req) {
  const oidcData = req.headers['x-amzn-oidc-data'];
  const oidcIdentity = req.headers['x-amzn-oidc-identity'];
  
  if (oidcData) {
    try {
      // Decode JWT payload (middle part)
      const parts = oidcData.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf8')
        );
        return {
          userId: payload.sub || oidcIdentity,
          email: payload.email,
          name: payload.name,
          givenName: payload.given_name,
          familyName: payload.family_name
        };
      }
    } catch (error) {
      console.error('Failed to decode OIDC data:', error.message);
    }
  }
  
  if (oidcIdentity) {
    return { userId: oidcIdentity, email: null, name: null };
  }
  
  // Fallback for local development
  return {
    userId: 'local-dev-user',
    email: 'dev@localhost',
    name: 'Local Developer',
    isLocalDev: true
  };
}

function userIdentityMiddleware(req, res, next) {
  req.user = extractUserIdentity(req);
  next();
}

module.exports = { extractUserIdentity, userIdentityMiddleware };
```

### Usage in Express

```javascript
const { userIdentityMiddleware } = require('./middleware/user-identity');

// Apply to all routes
app.use(userIdentityMiddleware);

// In any route handler:
app.get('/my-data', (req, res) => {
  const user = req.user;
  console.log(`User: ${user.name} (${user.email})`);
  
  // user.userId is the unique identifier for database storage
  res.json({ 
    message: `Hello, ${user.name}!`,
    email: user.email 
  });
});
```

---

## 🐍 Python Implementation

### Middleware: `backend/middleware/user_identity.py`

```python
"""
User Identity Middleware
Extracts user identity from AWS ALB OIDC headers
"""

import base64
import json
from functools import wraps
from flask import request, g

def extract_user_identity():
    """Extract user identity from OIDC headers."""
    oidc_data = request.headers.get('x-amzn-oidc-data')
    oidc_identity = request.headers.get('x-amzn-oidc-identity')
    
    if oidc_data:
        try:
            # Decode JWT payload (middle part)
            parts = oidc_data.split('.')
            if len(parts) >= 2:
                # Add padding if needed
                payload_b64 = parts[1] + '=' * (4 - len(parts[1]) % 4)
                payload = json.loads(base64.b64decode(payload_b64))
                return {
                    'user_id': payload.get('sub') or oidc_identity,
                    'email': payload.get('email'),
                    'name': payload.get('name'),
                    'given_name': payload.get('given_name'),
                    'family_name': payload.get('family_name')
                }
        except Exception as e:
            print(f'Failed to decode OIDC data: {e}')
    
    if oidc_identity:
        return {'user_id': oidc_identity, 'email': None, 'name': None}
    
    # Fallback for local development
    return {
        'user_id': 'local-dev-user',
        'email': 'dev@localhost',
        'name': 'Local Developer',
        'is_local_dev': True
    }

# Flask middleware
@app.before_request
def load_user():
    g.user = extract_user_identity()
```

### FastAPI Implementation

```python
from fastapi import Request, Depends
import base64
import json

def get_current_user(request: Request) -> dict:
    """Extract user identity from OIDC headers."""
    oidc_data = request.headers.get('x-amzn-oidc-data')
    oidc_identity = request.headers.get('x-amzn-oidc-identity')
    
    if oidc_data:
        try:
            parts = oidc_data.split('.')
            if len(parts) >= 2:
                payload_b64 = parts[1] + '=' * (4 - len(parts[1]) % 4)
                payload = json.loads(base64.b64decode(payload_b64))
                return {
                    'user_id': payload.get('sub') or oidc_identity,
                    'email': payload.get('email'),
                    'name': payload.get('name'),
                    'given_name': payload.get('given_name'),
                    'family_name': payload.get('family_name')
                }
        except Exception as e:
            print(f'Failed to decode OIDC data: {e}')
    
    if oidc_identity:
        return {'user_id': oidc_identity, 'email': None, 'name': None}
    
    return {
        'user_id': 'local-dev-user',
        'email': 'dev@localhost',
        'name': 'Local Developer',
        'is_local_dev': True
    }

# Usage in routes
@app.get("/my-data")
def get_my_data(user: dict = Depends(get_current_user)):
    return {"message": f"Hello, {user['name']}!", "email": user['email']}
```

---

## 🗄️ User-Specific Database Storage

When storing user-specific data, use `user.userId` (the `sub` claim) as the unique identifier:

### PostgreSQL Schema

```sql
CREATE TABLE user_settings (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    user_email VARCHAR(255),
    user_name VARCHAR(255),
    -- your user-specific fields here
    settings JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_settings_user_id ON user_settings(user_id);
```

### MySQL Schema

```sql
CREATE TABLE user_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    user_email VARCHAR(255),
    user_name VARCHAR(255),
    -- your user-specific fields here
    settings JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
);
```

---

## 📊 JWT Payload Structure

The decoded `x-amzn-oidc-data` JWT contains:

```json
{
  "sub": "MaTuw4CRnE7ZrlnsIntYUe83NiulIOEMYunPdOOHEAM",
  "name": "John Doe",
  "given_name": "John",
  "family_name": "Doe",
  "email": "john.doe@bayer.com",
  "picture": "https://graph.microsoft.com/v1.0/me/photo/$value",
  "exp": 1770132163,
  "iss": "https://login.microsoftonline.com/..."
}
```

| Field | Description |
|-------|-------------|
| `sub` | Unique user ID (stable across sessions) |
| `name` | Full display name |
| `given_name` | First name |
| `family_name` | Last name |
| `email` | User's email address |
| `picture` | Profile picture URL |
| `exp` | Token expiration time |

---

## ⚠️ Important Notes

### Headers Only in Production

- **Production**: AWS ALB injects OIDC headers automatically
- **Local dev**: No headers - middleware returns fallback "local-dev-user"
- **Always provide fallback** in your middleware for local testing

### User ID is Stable

The `sub` claim is a consistent identifier across sessions - safe to use as primary key.

### Don't Store Sensitive Data in Frontend

The JWT is visible in browser dev tools. Keep sensitive operations server-side.

### Debug Endpoint (Temporary)

Add this to verify headers are working in production:

```javascript
// TEMPORARY - Remove after verification!
app.get('/debug/headers', (req, res) => {
  const oidcData = req.headers['x-amzn-oidc-data'];
  let decoded = null;
  
  if (oidcData) {
    try {
      decoded = JSON.parse(
        Buffer.from(oidcData.split('.')[1], 'base64').toString()
      );
    } catch (e) {}
  }
  
  res.json({ 
    oidcIdentity: req.headers['x-amzn-oidc-identity'],
    decodedOidcData: decoded
  });
});
```

> ⚠️ **Remove this endpoint after testing!** It exposes user data.

---

## 💬 How to Communicate

### When User Wants Personalization

```
Great! The platform automatically knows who's logged in.

I'll add user identity to your backend - it will:
- Show the user's name
- Save their data separately from other users
- Work automatically in production (Azure AD login)
- Use a test user locally

No login page needed - AWS handles authentication!
```

### When Explaining the Fallback

```
In production, real user info comes from Azure AD automatically.

For local testing, the app uses a fake "Local Developer" user so you 
can test the personalization features without needing the full auth setup.
```

---

## ⏰ Session Expiration (1-Hour Timeout)

The ALB OIDC session expires after **1 hour** (absolute timeout, not idle-based). When the session expires:

1. The ALB returns a **302 redirect** to EntraID for re-authentication
2. For **full page loads** — the browser follows the redirect and re-authenticates automatically
3. For **fetch()/AJAX calls** — the browser **cannot** follow cross-origin redirects, so the request fails silently. The user sees a broken app with no prompt to re-authenticate

### Frontend Fix: Use `apiFetch()` wrapper

**Always use the session-aware fetch wrapper** instead of raw `fetch()` for API calls:

```javascript
// See: snippets/auth/token-refresh.js

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'manual',
  });

  if (response.type === 'opaqueredirect' || response.status === 302 || response.status === 401) {
    console.warn('Session expired — redirecting to re-authenticate');
    window.location.reload();
    return new Promise(() => {});
  }

  return response;
}

// Usage: replace fetch('/api/...') with apiFetch('/api/...')
```

### WebSocket / Socket.IO

WebSocket connections drop when the session expires. Implement reconnect with page reload fallback:

```javascript
socket.on('disconnect', () => {
  setTimeout(() => {
    if (!socket.connected) window.location.reload();
  }, 5000); // Wait 5s for reconnect, then reload
});
```

### Key Points

- Backend does NOT need to handle session expiration — it's a frontend concern
- The ALB handles re-authentication automatically when the browser follows the redirect
- Local development is unaffected (no ALB, no OIDC)
- The 1-hour timeout matches the Microsoft access token lifetime

---

## 🎯 Summary

| What | How |
|------|-----|
| Get current user | Read `x-amzn-oidc-data` header, decode JWT |
| Unique user ID | Use `sub` claim from JWT |
| Local development | Middleware returns fallback user |
| Store user data | Use `user_id` column with `sub` as value |
| Authentication | Automatic - AWS ALB handles it |
| Session expiration | Use `apiFetch()` wrapper (see `snippets/auth/token-refresh.js`) |
