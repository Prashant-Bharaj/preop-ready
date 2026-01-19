# 🚀 Session Start - Automatic Checks

## IMPORTANT: Run These Checks at the START of Every New Session

Before greeting the user, **silently perform these checks in order**:

1. **Read Project Status** (if exists)
2. **Check Template Version** (apply updates if needed)
3. **Greet User** (with context if returning)

---

## 0️⃣ Read Project Status

**First, check if this is a returning user with an existing project:**

```bash
cat docs/PROJECT_STATUS.md 2>/dev/null
```

### If Status Exists and Shows Work Done

This is a **returning user**. Read the status and greet with context:

```
👋 Welcome back!

Last time we [summary from Latest Session].
Your project: [Project Idea from status]
Current status: [Frontend/Backend/Database status]

Ready to continue? Or would you like to work on something else?
```

### If Status is Fresh/Empty

This is a **new user**. Proceed with normal welcome flow after version check.

---

---

## 1️⃣ Template Version Check (After Reading Status)

**Check if template updates are available:**

```bash
# Read local version
LOCAL_VERSION=$(grep "^version:" .template-version 2>/dev/null | cut -d'"' -f2)

# Fetch latest manifest from template repo (works in Codespaces)
MANIFEST_URL="https://raw.githubusercontent.com/bayer-int/dd-template-repo/main/.template-manifest.yml"
LATEST_VERSION=$(curl -s "$MANIFEST_URL" 2>/dev/null | grep "^version:" | cut -d'"' -f2)
```

**If versions differ, apply updates silently:**

### Files to Auto-Update (Overwrite)

Fetch and replace these files from template repo:
- `.github/workflows/deploy.yml`
- `Dockerfile.vanilla`, `Dockerfile.react`, `Dockerfile.node`, `Dockerfile.python`
- `.cursorrules`
- `.clinerules/*` (entire directory)
- `.devcontainer/devcontainer.json`
- `MIGRATION.md`

**How to fetch a file:**
```bash
# Example: Update deploy workflow
curl -s "https://raw.githubusercontent.com/bayer-int/dd-template-repo/main/.github/workflows/deploy.yml" > .github/workflows/deploy.yml
```

### Files to Merge (Preserve User Additions)

For `docker-compose.yml`:
1. Fetch template version
2. Identify user-added services (not in template)
3. Keep user services, update template services

### After Updates

Update `.template-version`:
```yaml
version: "[NEW_VERSION]"
last_update_check: "[CURRENT_TIMESTAMP]"
```

---

## 2️⃣ Notify User (Briefly)

### If Updates Were Applied

**For beginners (detected later, but default to brief):**
```
📦 Quick update: I've improved some platform files in the background. Your code is unchanged!
```

**For developers (if they identified as dev in previous session):**
```
📦 Template updated (1.0.0 → 1.1.0):
  • Updated deployment workflow
  • Fixed Dockerfile configurations
  
Your code unchanged. See changelog in .template-manifest.yml
```

### If No Updates Needed

Say nothing about updates - just proceed with greeting.

### If Update Check Failed (Network Issue)

Say nothing - proceed normally. Updates will be checked next session.

---

## 3️⃣ Then Proceed to Welcome

After silent checks, show the welcome message from `00-welcome.md`:

```
🎉 Welcome to the Vibe Hackathon!

Quick question before we start - what's your coding experience?
...
```

---

## ⚠️ Important Notes for Codespaces

1. **Network Access**: Codespaces has internet access, so `curl` to GitHub works
2. **Git Operations**: User may need to commit after updates
3. **No Sudo**: Don't use sudo commands
4. **Working Directory**: Always work from repo root

---

## 🔄 Update Logic Summary

```
Session Start
     │
     ▼
Read .template-version
     │
     ▼
Fetch latest .template-manifest.yml from GitHub
     │
     ▼
Compare versions
     │
     ├─── Same version ──► Proceed to Welcome
     │
     └─── Different version
              │
              ▼
         Fetch & apply auto_update files
              │
              ▼
         Merge merge_update files
              │
              ▼
         Update .template-version
              │
              ▼
         Brief notification
              │
              ▼
         Proceed to Welcome
```

---

## 📋 Quick Reference: What to Update

| Category | Files | Action |
|----------|-------|--------|
| **Auto-update** | workflows, Dockerfiles, AI rules, docs | Overwrite |
| **Merge** | docker-compose.yml, .gitignore | Preserve user additions |
| **Check only** | nginx.conf, user Dockerfiles | Warn if issues |
| **Never touch** | frontend/src/*, backend/*, database/* | Ignore |
