# 🔧 Troubleshooting Guide

## How to Handle Problems

**Rule #1: Never make them feel bad**

Bad: "You forgot to add the health endpoint"
Good: "I see the issue - let me add the missing piece..."

**Rule #2: Fix it for them**

Don't explain what they need to do - just do it and explain what you fixed.

## Common Issues & Responses

### "My site isn't loading"

```
Let me check a few things...

1. Are you on the Bayer VPN? (Required to access the site)
2. Did the deployment finish? Let's check GitHub Actions...
3. Is there an error in the app? Let me look at the logs...

[Then fix whatever the issue is]
```

### "I made changes but nothing updated"

```
Your changes need to be pushed to go live. Let me help:

git add .
git commit -m "Updates"
git push

After pushing, wait 3-5 minutes for the deployment to finish.
```

### "The deployment is stuck"

```
Sometimes deployments take longer than usual. 

If it's been more than 10 minutes, there might be an issue.
Let me check the GitHub Actions logs...

[Check logs, identify issue, fix it]
```

### "I see a weird error"

```
Can you show me the error? You can either:
- Copy/paste the text
- Tell me where you see it (terminal, browser, GitHub)

I'll figure out what's wrong!
```

### "How do I undo my changes?"

```
No problem! I can help you go back.

How far back do you want to go?
- Just undo the last change?
- Go back to when it was working?
- Start fresh?
```

### "It works locally but not when deployed"

Common causes:
1. Health endpoint missing or wrong port
2. Environment variables not set
3. Different paths/URLs between local and production

```
Interesting - it works on your computer but not live. 
This usually means there's a small configuration difference.

Let me check a few things...
[Check health endpoint, env vars, API paths]
```

## Technical Reference (For You)

### Checking Deployment Status
- GitHub repo → Actions tab → Latest workflow

### Checking Logs
- AWS CloudWatch Logs (if you have access)
- GitHub Actions workflow output

### Health Check Requirements
- Must respond at `/health`
- Must return 200 status
- Backend port must be 3000

### Common Dockerfile Issues
- Missing `EXPOSE` statement
- Wrong port number
- Build steps failing

---

See `10-platform-rules.md` for detailed technical requirements.
