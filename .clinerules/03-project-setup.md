# 🔄 Project Setup Check

## ⚠️ Skip Conditions (check BEFORE asking)

**DO NOT ask the fresh/migrated question if ANY of these are true:**

- `docs/PROJECT_STATUS.md` has stack info (Frontend or Backend status is not "Not started")
- `frontend/Dockerfile` or `backend/Dockerfile` contains a valid `FROM` instruction (i.e., is a real Dockerfile, not just comments)
- `frontend/src/` or `frontend/index.html` contains user code
- This is a returning session (user has previous session history)

**If any condition is true** → this is a returning user or a project already in progress. Skip this step entirely and continue where they left off (read PROJECT_STATUS.md for context).

**Only ask for brand new projects** with empty/default PROJECT_STATUS.md and no existing code.

---

## Quick Check After Welcome (new projects only)

**After detecting their experience level, ask this simple question:**

```
One quick thing - are you:

1️⃣ **Starting fresh** - Building something new from scratch
2️⃣ **Migrated existing code** - Brought code from another project

Just reply 1 or 2!
```

---

## 🆕 Option 1: Starting Fresh

If they're starting fresh, proceed directly to **`04-understanding.md`**.

```
Perfect! Let's build something awesome from scratch.

What would you like to create? 💡
```

---

## 📦 Option 2: Migrated Existing Code

If they migrated existing code, **verify their project structure is correct**.

```
Great! Let me verify your project is set up correctly for deployment...
```

### Run These Verification Checks:

**Check 1: Required Folders**
```bash
# Verify frontend or backend exists
ls -d frontend/ backend/ 2>/dev/null
```

**Check 2: Dockerfiles**
```bash
# Check frontend Dockerfile
[ -f frontend/Dockerfile ] && echo "✅ frontend/Dockerfile exists" || echo "❌ Missing frontend/Dockerfile"

# Check backend Dockerfile (if backend exists)
[ -d backend/ ] && ([ -f backend/Dockerfile ] && echo "✅ backend/Dockerfile exists" || echo "❌ Missing backend/Dockerfile")
```

**Check 3: nginx.conf (for frontend)**
```bash
[ -f frontend/nginx.conf ] && echo "✅ nginx.conf exists" || echo "❌ Missing frontend/nginx.conf"
```

**Check 4: Health Endpoints**
- Check `frontend/nginx.conf` contains `/health` location
- Check backend code has `/health` endpoint

**Check 5: docker-compose.yml**
```bash
[ -f docker-compose.yml ] && echo "✅ docker-compose.yml exists" || echo "❌ Missing docker-compose.yml"
```

### Respond Based on Results

**If everything looks good:**
```
✅ Your migrated project looks correctly structured!

I found:
- [list what you found]

Ready to test locally? I can run `docker-compose up --build` for you.
```

**If issues found:**
```
I found a few things that need fixing:

[list issues]

Want me to fix these for you? It'll just take a moment.
```

### Common Migration Fixes

| Issue | Fix |
|-------|-----|
| Missing `frontend/Dockerfile` | Copy `Dockerfile.vanilla` or `Dockerfile.react` to `frontend/Dockerfile` |
| Missing `backend/Dockerfile` | Copy `Dockerfile.node` or `Dockerfile.python` to `backend/Dockerfile` |
| Missing `nginx.conf` | Create standard nginx.conf with `/health` endpoint |
| Missing health endpoint in backend | Add `/health` route returning `{"status": "ok"}` |
| Wrong port in backend | Ensure backend listens on port 3000 |
| Invalid nginx.conf | Remove `events{}` and `http{}` blocks, keep only `server{}` |

### After Fixing Issues

```
✅ Fixed! Your project is now ready for deployment.

Here's what I updated:
- [list changes]

Want to test it locally before deploying?
```

---

## 🔗 Reference: Migration Guide

If user hasn't migrated yet but wants to, point them to:

```
There's a detailed migration guide in your project:

📄 **docs/MIGRATION.md** - Step-by-step instructions for bringing existing code

You can follow that guide, then come back and I'll verify everything is set up correctly.
```
