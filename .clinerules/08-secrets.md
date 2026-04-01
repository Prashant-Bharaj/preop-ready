# 🔐 Adding Secrets (API Keys, etc.)

## When Do They Need This?

Only explain secrets if they want to use:
- OpenAI / ChatGPT API
- External services with API keys
- Custom passwords or tokens
- Credentials for third-party APIs (username/password pairs)

## Local Development (Quick Setup)

For testing locally, create a `.env` file in the backend directory. **Do NOT create `.env.example` files — they were removed for security reasons.**

**Create the file for them:**
```bash
cat > backend/.env << 'EOF'
# Local development secrets — this file is gitignored
OPENAI_KEY=
API_KEY=
API_SECRET=
JWT_SECRET=
SECRET_1=
SECRET_2=
SECRET_3=
EOF
```

**Then say:**
```
Done! Now open backend/.env and fill in your actual API keys.
This file is private — it's gitignored and will never be uploaded to GitHub.
```

**For database credentials in local dev**, the docker-compose.yml handles this automatically. The AI should set credentials directly in `docker-compose.yml` environment section (these are local-only dev values, not production secrets).

## How to Explain It Simply

### 🔗 Quick Link to GitHub Secrets

**Generate a direct link for the user** so they don't have to navigate through menus:

```bash
# Get the repo URL and construct the secrets link
REPO_URL=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')
echo "${REPO_URL}/settings/secrets/actions"
```

**Show the user:**
```
Here's a direct link to your GitHub Secrets page:
🔗 {repo-url}/settings/secrets/actions

Click it, then add a "New repository secret" with the name and value below.
```

### Step-by-Step (if user needs hand-holding)

```
To use OpenAI in your app, you'll need to add your API key securely.
Don't worry - I'll walk you through it!

**Step 1: Click this link to go to your secrets page:**
🔗 {repo-url}/settings/secrets/actions

**Step 2: Click "New repository secret"**

**Step 3: Add your secret:**
- Name: APP_OPENAI_KEY
- Value: [paste your OpenAI API key]
- Click "Add secret"

**Step 4: Push your code again**
git push

That's it! Your app can now use OpenAI securely.
```

## Available Secrets — Fixed List (Cannot Be Changed)

⚠️ **CRITICAL: These are the ONLY secrets available. The list is hardcoded in the deployment workflow and cannot be modified by the user. There are exactly 10 secrets.**

⚠️ **The `APP_` prefix is stripped when injected into the container.**

| # | GitHub Secret Name | Available in Code As | Common Use |
|---|-------------------|---------------------|------------|
| 1 | `APP_OPENAI_KEY` | `process.env.OPENAI_KEY` | OpenAI / LLM API key |
| 2 | `APP_DATABASE_URL` | `process.env.DATABASE_URL` | Custom database connection string |
| 3 | `APP_API_KEY` | `process.env.API_KEY` | Generic API key |
| 4 | `APP_API_SECRET` | `process.env.API_SECRET` | API secret |
| 5 | `APP_JWT_SECRET` | `process.env.JWT_SECRET` | JWT signing key |
| 6 | `APP_WEBHOOK_SECRET` | `process.env.WEBHOOK_SECRET` | Webhook validation secret |
| 7 | `APP_ENCRYPTION_KEY` | `process.env.ENCRYPTION_KEY` | Data encryption key |
| 8 | `APP_SECRET_1` | `process.env.SECRET_1` | Custom secret (e.g., password) |
| 9 | `APP_SECRET_2` | `process.env.SECRET_2` | Custom secret (e.g., username) |
| 10 | `APP_SECRET_3` | `process.env.SECRET_3` | Custom secret (e.g., admin email) |

**Users CANNOT add custom secret names.** If the app needs more than 10 secrets, repurpose the generic ones (`SECRET_1`, `SECRET_2`, `SECRET_3`) or combine values.

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

⚠️ **Database and vector database credentials are auto-injected — NO GitHub secrets needed!**

**See `10-platform-rules.md` § Environment Variables for the full list of auto-injected `DATABASE_*` and `VECTORDB_*` environment variables.**

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
