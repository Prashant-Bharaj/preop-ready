---
description: "Set up API keys, secrets, and env vars for local dev and production, or generate an M2M API key for the project's API"
triggers: ["API key", "secret", "env var", ".env", "password", "connect external API", "M2M", "call my API from a script"]
globs: []
---

# Secrets & Environment Variables

## Local Development: create `.env` directly

Create `backend/.env` for the user (gitignored). ⛔ **NEVER create `.env.example` files** — removed for security reasons.

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

Then tell the user: "Open backend/.env and fill in your keys. It's gitignored — never uploaded to GitHub."

For local database credentials, use `env_file` in docker-compose pointing to a gitignored `.env` (see `reference/sensitive-files.md` — never put credentials directly in docker-compose.yml).

**Sharing config with teammates:** each teammate creates their own `.env` (document the
required variable NAMES in a README with placeholder values); production values live only
in GitHub Secrets. ⛔ Never suggest sending secret VALUES through chat/email (Slack, Teams,
plain email) — if a value must move between people, the key's own provider console or a
password manager is the channel.

## Production: GitHub Secrets

Generate a direct link so the user doesn't navigate menus:

```bash
REPO_URL=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')
echo "${REPO_URL}/settings/secrets/actions"
```

Steps for the user:
1. Open `{repo-url}/settings/secrets/actions`
2. Click "New repository secret"
3. Name it with the `APP_` prefix (e.g. `APP_OPENAI_KEY`), paste the value
4. `git push` again — secrets are only injected on new deployments

## The Fixed 10-Secret List (cannot be changed)

⛔ Hardcoded in the deployment workflow. Users CANNOT add custom secret names. The `APP_` prefix is stripped inside the container.

| # | GitHub Secret | Available in Code As | Common Use |
|---|---------------|---------------------|------------|
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

Need more than 10? Repurpose `SECRET_1/2/3` or combine values.

### Pattern: external API with username/password

| GitHub Secret | Maps To | Purpose |
|---------------|---------|---------|
| `APP_SECRET_1` | `SECRET_1` | Password |
| `APP_SECRET_2` | `SECRET_2` | Username |
| `APP_SECRET_3` | `SECRET_3` | Admin email / other config |

## Code Pattern: support local AND platform names

Migrated apps often use specific env var names; the platform only provides the generic ones. **Always add fallbacks:**

```javascript
// Helper — checks primary name first, falls back to platform secret
const getEnv = (primary, fallback) =>
  process.env[primary] || (fallback ? process.env[fallback] : undefined);

const username = getEnv('EXTERNAL_API_USERNAME', 'SECRET_2');
const password = getEnv('EXTERNAL_API_PASSWORD', 'SECRET_1');
const adminEmail = getEnv('INITIAL_ADMIN_EMAIL', 'SECRET_3');

// Config-status checks must use the SAME fallback chain:
const credentialsConfigured = !!(username && password);
```

## Auto-Injected Credentials (NO GitHub secrets needed)

If `database/Dockerfile` exists:

| Variable | Description |
|----------|-------------|
| `DATABASE_HOST` | Internal hostname (e.g., `myapp-db.vibe.local`) |
| `DATABASE_NAME` | Database name (derived from repo name) |
| `DATABASE_USER` | Auto-generated username |
| `DATABASE_PASSWORD` | Auto-generated password |
| `DATABASE_URL` | Full connection string |

If `vectordb/Dockerfile` exists:

| Variable | Description |
|----------|-------------|
| `VECTORDB_HOST` | Internal hostname (e.g., `myapp-vectordb.vibe.local`) |
| `VECTORDB_PORT` | 5432 pgvector, 6333 Qdrant, 8000 Chroma |
| `VECTORDB_NAME` / `VECTORDB_USER` / `VECTORDB_PASSWORD` | pgvector only |

DB config should prefer `DATABASE_URL`, then individual vars, then local defaults (`host: 'db'`, port 5432, etc.).

## Debugging Secrets in Production

1. Check GitHub Actions logs for secret injection messages
2. Temporarily log presence (never values): `console.log('SECRET_1 set:', !!process.env.SECRET_1)`
3. Verify exact names — must be `APP_SECRET_1`, not `APP_SECRET1`
4. Re-push after adding secrets — injected only on new deployments

## Hardcoding Non-Sensitive URLs Is Fine

```javascript
// ✅ URLs are not sensitive — hardcode with optional override
const apiUrl = process.env.EXTERNAL_API_URL || 'https://api.example.com/data';
// ❌ Credentials ARE sensitive — always via secrets
const apiKey = process.env.API_KEY;
```

---

# M2M API Keys (programmatic access to the project's API)

For scripts, bots, Power Automate, Teams, or other internal Bayer systems calling this project's API.

**Only offer when ALL true:** project deployed successfully at least once, user asks about API access/M2M/curl/bot integration, and the app has a backend. Check silently:

```bash
gh run list --workflow=deploy.yml --status=success --limit=1 --json conclusion --jq 'length'
# 0 → do NOT offer; tell the user to deploy first
```

**Provides:** per-project key for `https://api.vibe.intranet.cnb/{repo-name}/api/{path}`, isolated per project, rate limited 50 req/sec (burst 100) / 100,000 req/day, Bayer network (VPN) only. Same backend as the browser URL; API Gateway validates the key, then Traefik strips `/api` as usual.

## Create / Revoke / Rotate

```bash
REPO_NAME=$(basename $(git remote get-url origin) .git | tr '[:upper:]' '[:lower:]')
gh workflow run manage-api-key.yml \
  -R bayer-int/dd-platform-repository \
  -f project_name="$REPO_NAME" \
  -f action=create   # or: revoke | rotate
```

Then wait and read the key from the run summary:

```bash
sleep 5
RUN_ID=$(gh run list -R bayer-int/dd-platform-repository \
  --workflow=manage-api-key.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" -R bayer-int/dd-platform-repository
gh run view "$RUN_ID" -R bayer-int/dd-platform-repository   # key in summary (also stored in AWS SSM)
```

Usage example for the user: `curl -H "x-api-key: YOUR_KEY" https://api.vibe.intranet.cnb/{repo-name}/api/health`

## Three Auth Methods

| Method | Use When | How |
|--------|----------|-----|
| Browser (OIDC) | User opens the app in a browser | Automatic — ALB handles auth |
| JWT (Bearer) | Caller has an EntraID token (OBO flow for Graph API) | `Authorization: Bearer {token}` |
| API Key | Simple M2M, no user context needed | `x-api-key: {key}` via API Gateway |

**Notes:** keys are per-project (not per-user); one key per project — rotate, don't duplicate; API keys give NO access to Microsoft Graph or user data (use JWT for that); to use the key inside the app's own backend, store it in `APP_SECRET_1`.
