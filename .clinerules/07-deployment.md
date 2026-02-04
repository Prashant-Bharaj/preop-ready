# 🚀 Deploying Your App

## Deployment (two paths — automatic)

The workflow detects your project and deploys accordingly. **Frontend-only** uses DevOps Docs (no AWS cost); **full-stack** uses AWS ECS.

| Project Type | Detection | URL |
|-------------|-----------|-----|
| **Frontend-only** (Vanilla or React, no backend) | No valid `backend/Dockerfile` | `https://docs.int.bayer.com/-/<repo-name>/` |
| **Full-stack** (has backend) | `backend/Dockerfile` exists | `https://<repo-name>.vibe.992872368362.cloud.bayer.com` |

You don’t need to configure anything: push triggers the right path. Frontend-only apps are published via the official DevOps Docs workflow (same as devops-docs-example) to save AWS budget.

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

**Run these commands in sequence:**
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

- **Frontend-only:** `https://docs.int.bayer.com/-/<repo-name>/`
- **Full-stack:** `https://<repo-name>.vibe.992872368362.cloud.bayer.com`

```
🎉 YOUR APP IS LIVE!

Visit your app at:
👉 [use the URL above based on project type]

Note: ECS URL needs Bayer network (VPN). DevOps Docs URL may have different access rules.

Share this link with your team - they can use it right away!

Want to make any changes? Just tell me and we'll update it.
```

## How to Know Which URL to Show

- **No backend** (only frontend/) → **URL:** `https://docs.int.bayer.com/-/<repo-name>/`
- **Has backend** (backend/Dockerfile) → **URL:** `https://<repo-name>.vibe.992872368362.cloud.bayer.com`

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
| Health check failed | The app didn't start correctly (ECS only) | Check backend has /health endpoint |
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
