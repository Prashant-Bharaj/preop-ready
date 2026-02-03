# 🚀 Deploying Your App

## Deployment Types

The platform automatically detects your project type and deploys accordingly:

| Project Type | Detection | Deployment | URL |
|-------------|-----------|------------|-----|
| **Vanilla** (HTML/CSS/JS only) | `frontend/index.html` exists, no `backend/Dockerfile` | DevOps Docs (static) | `https://docs.int.bayer.com/-/<repo>/` |
| **React/SPA** (frontend only) | `frontend/package.json` exists, no `backend/Dockerfile` | DevOps Docs (static) | `https://docs.int.bayer.com/-/<repo>/` |
| **Full-Stack** (has backend) | `backend/Dockerfile` exists | AWS ECS (containers) | `https://<repo>.vibe.992872368362.cloud.bayer.com` |

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

### For Static Apps (Vanilla/React without backend):

```
🎉 YOUR APP IS LIVE!

Visit your app at:
👉 https://docs.int.bayer.com/-/<repo-name>/

Note: You need to be on the Bayer network (VPN) to access it.

Share this link with your team - they can use it right away!

Want to make any changes? Just tell me and we'll update it.
```

### For Full-Stack Apps (with backend):

```
🎉 YOUR APP IS LIVE!

Visit your app at:
👉 https://<repo-name>.vibe.992872368362.cloud.bayer.com

Note: You need to be on the Bayer network (VPN) to access it.

Share this link with your team - they can use it right away!

Want to make any changes? Just tell me and we'll update it.
```

## How to Know Which URL to Show

**Check if `backend/Dockerfile` exists:**
- **YES (has backend)** → ECS URL: `https://<repo>.vibe.992872368362.cloud.bayer.com`
- **NO (frontend only)** → Static URL: `https://docs.int.bayer.com/-/<repo>/`

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
| Health check failed | The app didn't start correctly | Check backend has /health endpoint |
| Build failed | Something wrong in the code | Check error message, fix syntax |
| Push rejected | Need to pull changes first | Run: git pull --rebase && git push |
| npm ci failed | Missing package-lock.json | Run: npm install (creates lock file) |

### Static-Specific Issues

| Error | Cause | Fix |
|-------|-------|-----|
| 404 on subpages | React Router with BrowserRouter | Use HashRouter instead, or ensure index.html handles all routes |
| Missing files | Build output in wrong folder | Check vite.config.js outputs to `dist/` |

## Updating the App

```
Want to make changes to your live app?

Just tell me what you want to change, I'll update the code, 
and we'll push again. Same process - it's that easy!
```

## Switching from Static to Full-Stack

If a project starts as frontend-only and later needs a backend:

1. Add `backend/Dockerfile` with valid FROM instruction
2. Add backend code
3. Push - deployment will automatically switch to ECS

```
I notice you want to add a backend! This means your app will move 
from static hosting to the full platform.

Your new URL will be:
👉 https://<repo>.vibe.992872368362.cloud.bayer.com

(The old static URL will stop working after this push)

Ready to proceed?
```

---

## 📋 Don't Forget: Update Project Status!

**After deployment (success OR failure), update `docs/PROJECT_STATUS.md`:**
- Update Deployment Status section (✅ Deployed or ❌ Failed)
- Add the production URL (static or ECS based on project type)
- Record the deployment date/time
- If failed, note the error for reference

See `11-status-tracking.md` for details.
