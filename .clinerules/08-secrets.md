# 🔐 Adding Secrets (API Keys, etc.)

## When Do They Need This?

Only explain secrets if they want to use:
- OpenAI / ChatGPT API
- External services with API keys
- Custom passwords or tokens
- Credentials for third-party APIs (username/password pairs)

## Local Development (Quick Setup)

For testing locally, there's a ready-made template:

```
📁 backend/env.example  ← Copy this to create your local secrets
```

**Help them set it up:**
```
To use secrets locally, I'll help you set up the environment file:
```

**Then run for them:**
```bash
cp backend/env.example backend/.env
```

**Then say:**
```
Done! Now open backend/.env and fill in your actual API keys.
This file is private - it won't be uploaded to GitHub.
```

## How to Explain It Simply

```
To use OpenAI in your app, you'll need to add your API key securely.
Don't worry - I'll walk you through it!

**Step 1: Go to your GitHub repository**
(the website, not this code editor)

**Step 2: Click Settings** (top menu)

**Step 3: Click "Secrets and variables" → "Actions"** (left sidebar)

**Step 4: Click "New repository secret"**

**Step 5: Add your secret:**
- Name: APP_OPENAI_KEY
- Value: [paste your OpenAI API key]
- Click "Add secret"

**Step 6: Push your code again**
git push

That's it! Your app can now use OpenAI securely.
```

## Available Secret Names & Mapping

⚠️ **CRITICAL: The `APP_` prefix is removed when secrets are injected into the container!**

Tell them which secrets are supported:

| GitHub Secret Name | Environment Variable in Container | Common Use |
|--------------------|-----------------------------------|------------|
| `APP_OPENAI_KEY` | `OPENAI_KEY` | OpenAI/ChatGPT API key |
| `APP_API_KEY` | `API_KEY` | Generic API key |
| `APP_API_SECRET` | `API_SECRET` | API secret/password |
| `APP_DATABASE_URL` | `DATABASE_URL` | Custom database connection |
| `APP_SECRET_1` | `SECRET_1` | Custom secret #1 (e.g., password) |
| `APP_SECRET_2` | `SECRET_2` | Custom secret #2 (e.g., username) |
| `APP_SECRET_3` | `SECRET_3` | Custom secret #3 (e.g., admin email) |

### Common Pattern: External API with Username/Password

When the app needs to connect to an external API with credentials:

| GitHub Secret | Maps To | Purpose |
|---------------|---------|---------|
| `APP_SECRET_1` | `SECRET_1` | Password |
| `APP_SECRET_2` | `SECRET_2` | Username |
| `APP_SECRET_3` | `SECRET_3` | Admin email or other config |

**Example backend code pattern:**
```javascript
// Support both local env vars AND platform secrets
const username = process.env.EXTERNAL_API_USERNAME || process.env.SECRET_2;
const password = process.env.EXTERNAL_API_PASSWORD || process.env.SECRET_1;
```

## Using Secrets in Code

### Basic Usage

In the backend code, access secrets like this:

```javascript
// The APP_ prefix is removed automatically!
const openaiKey = process.env.OPENAI_KEY;
const apiKey = process.env.API_KEY;
```

### ⚠️ IMPORTANT: Support Both Local and Platform Secrets

When migrating existing apps, the code may use specific env var names (e.g., `EXTERNAL_MEAL_USERNAME`). 
The platform only provides generic secrets (`SECRET_1`, `SECRET_2`, etc.).

**Always add fallbacks in your code:**

```javascript
// Helper function to check multiple env var names
const getEnv = (primary, fallback) => {
  return process.env[primary] || (fallback ? process.env[fallback] : undefined);
};

// Usage - checks primary name first, falls back to platform secret
const username = getEnv('EXTERNAL_MEAL_USERNAME', 'SECRET_2');
const password = getEnv('EXTERNAL_MEAL_PASSWORD', 'SECRET_1');
const adminEmail = getEnv('INITIAL_ADMIN_EMAIL', 'SECRET_3');
```

### Checking Configuration Status

If your app has a status endpoint that shows if credentials are configured:

```javascript
// ❌ WRONG - Only checks one env var name
const credentialsConfigured = !!(
  process.env.EXTERNAL_API_USERNAME &&
  process.env.EXTERNAL_API_PASSWORD
);

// ✅ CORRECT - Checks both local and platform secret names
const username = process.env.EXTERNAL_API_USERNAME || process.env.SECRET_2;
const password = process.env.EXTERNAL_API_PASSWORD || process.env.SECRET_1;
const credentialsConfigured = !!(username && password);
```

## Auto-Injected Database Credentials

⚠️ **If your project has a `database/Dockerfile`, the platform automatically injects these:**

| Environment Variable | Description |
|---------------------|-------------|
| `DATABASE_HOST` | Internal hostname (e.g., `myapp-db.vibe.local`) |
| `DATABASE_NAME` | Database name (derived from repo name) |
| `DATABASE_USER` | Auto-generated username |
| `DATABASE_PASSWORD` | Auto-generated password |
| `DATABASE_URL` | Full connection string |

**You do NOT need to add database credentials as GitHub secrets!**

Your database config should support both:
```javascript
function getDatabaseConfig() {
  // Platform provides DATABASE_URL in production
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  
  // Local development uses individual vars or defaults
  return {
    host: process.env.DATABASE_HOST || 'db',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'myapp',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
  };
}
```

## Debugging Secrets

If secrets aren't working in production:

1. **Check GitHub Actions logs** - Look for secret injection messages
2. **Add logging** (temporarily) to verify env vars are set:
   ```javascript
   console.log('SECRET_1 set:', !!process.env.SECRET_1);
   console.log('SECRET_2 set:', !!process.env.SECRET_2);
   ```
3. **Verify secret names** - Must be exactly `APP_SECRET_1`, `APP_SECRET_2`, etc.
4. **Re-push after adding secrets** - Secrets are only injected on new deployments

## Security Warning

If they try to put secrets in the code:

```
⚠️ Wait! Don't put your API key directly in the code.

If you do that, anyone who sees your code can steal it!
Instead, let's add it as a secret (I'll show you how).
```

## Hardcoding Non-Sensitive URLs

API URLs (not credentials) can be safely hardcoded in code:

```javascript
// ✅ URLs are not sensitive - hardcode with optional override
const DEFAULT_API_URL = 'https://api.example.com/data';
const apiUrl = process.env.EXTERNAL_API_URL || DEFAULT_API_URL;

// ❌ Credentials ARE sensitive - use secrets
const apiKey = process.env.API_KEY; // From APP_API_KEY secret
```

This way the app works in production without needing to add the URL as a secret.
