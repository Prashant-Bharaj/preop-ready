# 🌐 URLs Reference

## URL Summary

| Context | URL Format |
|---------|------------|
| **Production (deployed)** | `https://<repo-name>.vibe.intranet.cnb` |
| **Local test (user's machine)** | `http://localhost:8080` |
| **Local test (Codespaces)** | `https://{CODESPACE_NAME}-8080.app.github.dev` |

---

## 🔍 How to Detect Environment

**Run this command to check if user is in Codespaces:**

```bash
if [ -n "$CODESPACES" ]; then echo "CODESPACES: $CODESPACE_NAME"; else echo "LOCAL"; fi
```

**Results:**
- `CODESPACES: xxx-yyy-zzz` → User is in GitHub Codespaces
- `LOCAL` → User is on their local machine

---

## 💬 Showing the Correct URL

### For Local Testing (after `docker-compose up`)

**Always check the environment before showing the URL:**

```bash
# Check environment and show correct URL
if [ -n "$CODESPACES" ]; then
  echo "👉 Open: https://${CODESPACE_NAME}-8080.app.github.dev"
else
  echo "👉 Open: http://localhost:8080"
fi
```

**Or tell the user based on your detection:**

| Environment | URL to Show |
|-------------|-------------|
| Codespaces | `https://{CODESPACE_NAME}-8080.app.github.dev` |
| Local | `http://localhost:8080` |

### For Production (after `git push`)

Always use:
```
https://<repo-name>.vibe.intranet.cnb
```

(Requires Bayer VPN to access)

---

## 📋 Quick Reference

| User Action | URL Type |
|-------------|----------|
| "Start my app" / "Test locally" | **Check environment** → Show appropriate local URL |
| "Deploy" / "Make it live" | Production URL |
| "What's my app URL?" | Ask if they mean local testing or deployed version |

---

## 💡 Tips for Codespaces Users

If the URL doesn't work, tell them:
```
In Codespaces, you can also:
1. Look at the bottom panel
2. Click the "Ports" tab
3. Find port 8080
4. Click the globe icon 🌐 to open in browser

If it says "Private", click the lock icon to make it "Public" or "Visible to org".
```

---

## ⚠️ Common URL Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| "Page not loading" (Codespaces) | Port not forwarded | Check Ports tab, make port public |
| "Page not loading" (Local) | Docker not running | Run `docker-compose up --build` |
| "Page not loading" (Production) | Not on VPN | Connect to Bayer VPN |
| "Connection refused" | Wrong port | Use 8080 for frontend, 3000 for backend |
