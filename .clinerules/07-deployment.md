# 🚀 Deploying Your App

## ⚠️ FIRST: Check Whitelisting Status

**BEFORE running any deploy commands, you MUST verify the repo is whitelisted!**

### How to check (run silently):

```bash
# Check for any successful "Deploy Vibe Project" workflow runs
gh run list --workflow=deploy.yml --status=success --limit=1 --json conclusion --jq 'length'
```

**Interpret the result:**
- Returns `1` (or more) → Repo has deployed before → **whitelisted** ✅
- Returns `0` or errors → No successful deploys → likely **NOT whitelisted** ❌
- If `gh` is not available (local dev without GitHub CLI), ask the user: "Has this repo been deployed before?"

### If NOT whitelisted — STOP and tell the user:

```
⚠️ Before we can deploy, your repository needs to be whitelisted.

This is a one-time setup:
1. Contact a platform admin with your repository name
   (e.g., bayer-int/your-repo-name)
2. They'll add it to the deployment whitelist (~5 minutes)
3. Once done, all future deployments work automatically!

Without this step, deployment will fail with "Unauthorized repository".

Let me know once it's been whitelisted, and we'll deploy right away!
```

**DO NOT proceed with `git push` until whitelisting is confirmed.** Pushing without whitelisting wastes time and confuses users when it fails.

---

## Deployment (ECS only)

The workflow deploys to AWS ECS. Projects need at least a `frontend/Dockerfile` or `backend/Dockerfile`.

| Project Type | Detection | URL |
|-------------|-----------|-----|
| **Frontend-only** | `frontend/Dockerfile` exists (no backend) | `https://<repo-name>.vibe.intranet.cnb` |
| **Full-stack** (has backend) | `backend/Dockerfile` exists | `https://<repo-name>.vibe.intranet.cnb` |

## Make Deployment Sound Easy (Because It Is!)

```
Ready to make your app live? It's super easy - just 3 steps:

1. Save your work (I'll help with this)
2. Push to GitHub (one command)
3. Wait 3-5 minutes
4. Your app is live! 🎉

Want me to deploy it now?
```

## The Deployment Commands

**RUN THE COMMANDS FOR THEM** - don't make them type:

```
Alright, let's make it live! I'll handle the commands for you.
```

**Step 1: Run preflight check (MANDATORY before every push):**
```bash
./scripts/preflight-check.sh
```

If preflight fails → fix the reported issues before proceeding. Do NOT skip this step.

**Step 2: Push to deploy:**
```bash
git add .
git commit -m "My awesome app"
git push
```

Then say:
```
✅ Done! Your code is on its way to becoming a live website!

🚀 Deployment started - this takes about 3-5 minutes.

I'll let you know the link when it's ready, or you can watch progress at:
→ GitHub repo → Actions tab
```

## While Waiting

```
🚀 Deployment started! 

Your app is being built and deployed automatically. This takes about 3-5 minutes.

You can watch the progress here:
→ Go to your GitHub repository
→ Click the "Actions" tab
→ You'll see your deployment running

I'll let you know when it's ready, or you can check back in a few minutes!
```

## When It's Done

```
🎉 YOUR APP IS LIVE!

Visit your app at:
👉 https://<repo-name>.vibe.intranet.cnb

Note: You need to be on the Bayer network (VPN) to access it.

Share this link with your team - they can use it right away!

Want to make any changes? Just tell me and we'll update it.
```

## How to Know Which URL to Show

Deployment is ECS only. **URL:** `https://<repo-name>.vibe.intranet.cnb`

## If Deployment Fails

Don't panic them:

```
Hmm, something went wrong with the deployment. Don't worry - this happens sometimes!

Let me check what happened...
[Check GitHub Actions for the error]

[Then explain the issue simply]
The problem is: [simple explanation]
Here's how we fix it: [solution]
```

### Common Failures and Fixes

| Error | Simple Explanation | Fix |
|-------|-------------------|-----|
| Unauthorized repository | Repo not whitelisted for deployment | Add repo to `github_allowed_deploy_repos` in infrastructure repo's `variables.tf` |
| Health check failed | The app didn't start correctly (ECS only) | Check frontend/backend has /health endpoint |
| Build failed | Something wrong in the code | Check error message, fix syntax |
| Push rejected | Need to pull changes first | Run: git pull --rebase && git push |
| npm ci failed | Missing package-lock.json | Run: npm install (creates lock file) |
| No deployable content | No frontend/ or backend/Dockerfile | Add frontend/ with index.html or backend/Dockerfile |

## Updating the App

```
Want to make changes to your live app?

Just tell me what you want to change, I'll update the code, 
and we'll push again. Same process - it's that easy!
```

---

## 📋 Don't Forget: Update Project Status!

**After deployment (success OR failure), update `docs/PROJECT_STATUS.md`:**
- Update Deployment Status section (✅ Deployed or ❌ Failed)
- Add the production URL (static or ECS based on project type)
- Record the deployment date/time
- If failed, note the error for reference

See `11-status-tracking.md` for details.
