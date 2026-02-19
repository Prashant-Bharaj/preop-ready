# 🧪 Testing Locally

## ⚠️ BEFORE Testing: Verify Architecture Consistency

**EVERY TIME before running `docker-compose up`, verify these match the chosen architecture:**

| Check | Frontend-only | Has Backend | Full-stack |
|-------|--------------|-------------|------------|
| `docker-compose.yml` has backend service? | ❌ Must be removed | ✅ Present | ✅ Present |
| `docker-compose.yml` has db service? | ❌ Must be removed | ❌ Remove if unused | ✅ Present |
| `docker-compose.yml` frontend has `depends_on: backend`? | ❌ Must be removed | ✅ Present | ✅ Present |
| `nginx.local.conf` has `/api/` proxy block? | ❌ Must be removed | ✅ Present | ✅ Present |
| `nginx.local.conf` has `/socket.io/` proxy block? | ❌ Must be removed | ✅ If using WS | ✅ If using WS |
| `nginx.conf` has NO proxy_pass? | ✅ Must NOT have any | ✅ Must NOT have any | ✅ Must NOT have any |

**If any mismatch exists, fix it BEFORE running docker-compose.**
- A `proxy_pass` in `nginx.local.conf` pointing to a non-existent backend service will crash nginx on startup.
- A `proxy_pass` in `nginx.conf` (production) will crash nginx in production — Traefik handles API routing, not nginx. **NEVER add proxy_pass to nginx.conf.**

---

## How to Explain Testing

Don't say "spin up containers" - **run the command for them**:

```
Let's test your app before making it live! Want me to start it?
```

**If user agrees, first verify architecture consistency (table above), then RUN THE COMMAND:**
```bash
docker-compose up --build
```

Then tell them the correct URL **(see `15-urls.md` for detection)**:

**For Codespaces users:**
```
🚀 Starting your app now...

When it's ready (you'll see "ready" messages), open:
👉 https://{CODESPACE_NAME}-8080.app.github.dev

Try clicking around - does it work how you expected? Let me know!
```

**For local users:**
```
🚀 Starting your app now...

When it's ready (you'll see "ready" messages), open:
👉 http://localhost:8080

Try clicking around - does it work how you expected? Let me know!
```

## Common Testing Issues

### "Nothing happens when I run the command"
```
It's still loading! Docker is setting everything up. 
Wait for messages like "Server running on port 3000" or "nginx started".
This can take 1-2 minutes the first time.
```

### "I see an error"
```
No worries, let me check! Can you copy the error message you see?
Or just tell me what happened and I'll look at the code.
```

### "The page is blank/broken"
```
Let me check a few things...
[Check browser console, check if containers are running, check logs]
```

### "How do I stop it?"
```
Press Ctrl+C in the terminal (hold Control and press C).
Or just close the terminal window.
```

## Testing Checklist (For You)

Before deployment, verify:
- [ ] Frontend loads (use environment-appropriate URL)
- [ ] No JavaScript errors in browser console
- [ ] Backend health check works at /health endpoint
- [ ] Main features work as expected
- [ ] Mobile view looks okay (resize browser window)

## Quick Feedback Loop

Encourage iteration:

```
How does it look? 

If you want to change anything, just tell me! For example:
- "Make the button bigger"
- "Change the color to blue"
- "Add a back button"

I'll update it and you can refresh to see changes.
```

---

## 📋 Don't Forget: Update Project Status!

**After successful local testing, update `docs/PROJECT_STATUS.md`:**
- Mark "Local testing" as complete
- Note any issues encountered
- Update "Next steps" (usually: deploy!)

See `11-status-tracking.md` for details.
