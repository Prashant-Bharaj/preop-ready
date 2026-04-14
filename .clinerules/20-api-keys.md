# 🔑 API Keys (Machine-to-Machine Access)

> Use this when the user needs **programmatic access** to their project's API — from scripts, bots, Power Automate, Teams, or other internal Bayer systems.

---

## When to Offer This

Only offer API key generation when **ALL** of these are true:
1. The project has been **successfully deployed** at least once
2. The user asks about API access, M2M, programmatic access, bot integration, or curl
3. The user's app has a backend with API endpoints

**Check deployment status silently:**
```bash
gh run list --workflow=deploy.yml --status=success --limit=1 --json conclusion --jq 'length'
```
If returns `0` — do NOT offer API keys. Tell the user to deploy first (see `07-deployment.md`).

---

## What This Provides

- A **unique API key** for their project
- Access via: `https://api.vibe.intranet.cnb/{repo-name}/api/{path}`
- Per-project isolation — key A cannot access project B
- Rate limited: 50 req/sec (burst 100), 100,000 requests/day
- Works from any machine on the **Bayer network** (VPN required)

---

## How to Generate a Key

### Step 1: Trigger the workflow
```bash
REPO_NAME=$(basename $(git remote get-url origin) .git | tr '[:upper:]' '[:lower:]')
gh workflow run manage-api-key.yml \
  -R bayer-int/dd-platform-repository \
  -f project_name="$REPO_NAME" \
  -f action=create
```

### Step 2: Wait for completion
```bash
sleep 5
RUN_ID=$(gh run list -R bayer-int/dd-platform-repository \
  --workflow=manage-api-key.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" -R bayer-int/dd-platform-repository
```

### Step 3: Get the key from the workflow summary
```bash
gh run view "$RUN_ID" -R bayer-int/dd-platform-repository
```
The API key is shown in the workflow run summary. It is also stored securely in AWS SSM.

### Step 4: Show the user their API info

Tell the user:
```
Your API key has been created!

Endpoint: https://api.vibe.intranet.cnb/{repo-name}/api/{path}

Example:
  curl -H "x-api-key: YOUR_KEY" \
    https://api.vibe.intranet.cnb/{repo-name}/api/health

Rate limits: 50 req/sec (burst 100), 100,000 requests/day
Only works on the Bayer network (VPN required).
```

---

## Revoking a Key

```bash
REPO_NAME=$(basename $(git remote get-url origin) .git | tr '[:upper:]' '[:lower:]')
gh workflow run manage-api-key.yml \
  -R bayer-int/dd-platform-repository \
  -f project_name="$REPO_NAME" \
  -f action=revoke
```

## Rotating a Key

Creates a new key and deletes the old one. The new key is shown in the workflow summary.

```bash
REPO_NAME=$(basename $(git remote get-url origin) .git | tr '[:upper:]' '[:lower:]')
gh workflow run manage-api-key.yml \
  -R bayer-int/dd-platform-repository \
  -f project_name="$REPO_NAME" \
  -f action=rotate
```

---

## How API Gateway Routing Works

The API Gateway adds a layer in front of the existing Traefik routing:

```
Client (with API key)
  -> https://api.vibe.intranet.cnb/{project}/api/users
  -> API Gateway validates key (Lambda authorizer checks key belongs to project)
  -> VPC Link -> NLB -> M2M ALB -> Traefik
  -> strips /api prefix -> backend receives GET /users
```

The `{project}` path segment maps to the Host header for Traefik routing. This is the **same backend** that serves `https://{project}.vibe.intranet.cnb` but accessible programmatically without browser OIDC auth.

---

## Three Auth Methods — When to Use Which

| Method | Use When | How |
|--------|----------|-----|
| **Browser (OIDC)** | User opens the app in a browser | Automatic — ALB handles auth |
| **JWT (Bearer)** | Caller has an EntraID token (OBO flow for Graph API) | `Authorization: Bearer {token}` |
| **API Key** | Simple M2M, no user context needed | `x-api-key: {key}` via API Gateway |

---

## Important Notes

- API keys are **per-project**, not per-user
- **One key per project** — rotate to change, do not create duplicates
- The `/api` prefix behavior is the same as browser access (Traefik strips it)
- API keys do NOT provide access to Microsoft Graph API or user data — use JWT (Bearer) for that
- If the user wants to use the API key in their own backend code, store it in `APP_SECRET_1` (see `08-secrets.md`)