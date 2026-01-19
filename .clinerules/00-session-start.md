# 🚀 Session Start - Version Check & Welcome

## IMPORTANT: Run These Checks at the START of Every New Session

**Order of operations:**

1. **Check Template Version** (silently compare versions)
2. **Read Project Status** (if exists)
3. **Greet User** (include update notification if available)

---

## 1️⃣ Template Version Check (Run Silently)

**At session start, check if platform updates are available:**

```bash
# Read local version
LOCAL_VERSION=$(grep "^version:" .template-version 2>/dev/null | cut -d'"' -f2)

# For private repos in Codespaces, use GitHub CLI (already authenticated)
LATEST_VERSION=$(gh api repos/bayer-int/dd-template-repository/contents/.template-manifest.yml \
  --jq '.content' 2>/dev/null | base64 -d | grep "^version:" | cut -d'"' -f2)
```

**Store the result** - you'll use it in the greeting. Don't apply updates yet!

---

## 2️⃣ Read Project Status

**Check if this is a returning user:**

```bash
cat docs/PROJECT_STATUS.md 2>/dev/null
```

- If status shows work done → This is a returning user
- If status is fresh/empty → This is a new user

---

## 3️⃣ Greet User (Include Update Notification)

### If Updates Available (LOCAL_VERSION ≠ LATEST_VERSION)

**Include this in your greeting:**

```
📦 **Platform Update Available!**

A new version of the platform is available (${LOCAL_VERSION} → ${LATEST_VERSION}).

Updates include improvements to:
- Deployment workflow
- Dockerfile templates  
- AI instructions

**Would you like me to update now?** (Your code won't be affected)

Reply "yes" to update, or we can continue and update later.
```

### If No Updates (or check failed)

Don't mention updates - proceed with normal greeting.

### For Returning Users

```
👋 Welcome back!

Last time we [summary from Latest Session].
Your project: [Project Idea from status]

[Include update notification here if available]

Ready to continue?
```

### For New Users

```
🎉 Welcome to the Vibe Hackathon!

[Include update notification here if available]

Quick question - what's your coding experience?
1️⃣ "I'm new to coding"
2️⃣ "I'm a developer"
```

---

## 4️⃣ If User Says "Yes" to Update

**Apply updates when user confirms:**

### Files to Update (Overwrite)

```bash
# Deployment workflow
gh api repos/bayer-int/dd-template-repository/contents/.github/workflows/deploy.yml \
  --jq '.content' | base64 -d > .github/workflows/deploy.yml

# Frontend Dockerfile templates
gh api repos/bayer-int/dd-template-repository/contents/frontend/Dockerfile.vanilla \
  --jq '.content' | base64 -d > frontend/Dockerfile.vanilla
gh api repos/bayer-int/dd-template-repository/contents/frontend/Dockerfile.react \
  --jq '.content' | base64 -d > frontend/Dockerfile.react

# Backend Dockerfile templates  
gh api repos/bayer-int/dd-template-repository/contents/backend/Dockerfile.node \
  --jq '.content' | base64 -d > backend/Dockerfile.node
gh api repos/bayer-int/dd-template-repository/contents/backend/Dockerfile.python \
  --jq '.content' | base64 -d > backend/Dockerfile.python

# Database Dockerfile templates
gh api repos/bayer-int/dd-template-repository/contents/database/Dockerfile.postgres \
  --jq '.content' | base64 -d > database/Dockerfile.postgres
gh api repos/bayer-int/dd-template-repository/contents/database/Dockerfile.mysql \
  --jq '.content' | base64 -d > database/Dockerfile.mysql
gh api repos/bayer-int/dd-template-repository/contents/database/Dockerfile.pgvector \
  --jq '.content' | base64 -d > database/Dockerfile.pgvector
gh api repos/bayer-int/dd-template-repository/contents/database/Dockerfile.chroma \
  --jq '.content' | base64 -d > database/Dockerfile.chroma
gh api repos/bayer-int/dd-template-repository/contents/database/Dockerfile.qdrant \
  --jq '.content' | base64 -d > database/Dockerfile.qdrant

# AI rules
gh api repos/bayer-int/dd-template-repository/contents/.cursorrules \
  --jq '.content' | base64 -d > .cursorrules

# Documentation
gh api repos/bayer-int/dd-template-repository/contents/docs/MIGRATION.md \
  --jq '.content' | base64 -d > docs/MIGRATION.md
gh api repos/bayer-int/dd-template-repository/contents/docs/EXAMPLES.md \
  --jq '.content' | base64 -d > docs/EXAMPLES.md
```

### Update .clinerules/ Directory

```bash
# Fetch list of files in .clinerules/
FILES=$(gh api repos/bayer-int/dd-template-repository/contents/.clinerules --jq '.[].name')

# Update each file
for FILE in $FILES; do
  gh api "repos/bayer-int/dd-template-repository/contents/.clinerules/$FILE" \
    --jq '.content' | base64 -d > ".clinerules/$FILE"
done
```

### Update Version Tracker

```bash
# Update .template-version with new version
cat > .template-version << EOF
# Template Version Tracker
version: "${LATEST_VERSION}"
template_repo: "bayer-int/dd-template-repository"
last_update_check: "$(date -Iseconds)"
EOF
```

### Confirm to User

```
✅ Updated! Your project is now on version ${LATEST_VERSION}.

Your code (frontend/, backend/, database/init/) was not touched.

Now, let's continue - what would you like to work on?
```

---

## 5️⃣ If User Says "No" or "Later"

```
No problem! You can update anytime by asking me to "update platform files".

Now, what would you like to work on?
```

---

## ⚠️ Important Notes for Codespaces

1. **GitHub CLI**: Use `gh api` for fetching files (pre-authenticated in Codespaces)
2. **Git Operations**: User may need to commit after updates
3. **No Sudo**: Don't use sudo commands
4. **Working Directory**: Always work from repo root

---

## 🔄 Update Flow Summary

```
Session Start
     │
     ▼
Check .template-version (silently)
     │
     ▼
Fetch latest version via gh api (silently)
     │
     ▼
Compare versions
     │
     ├─── Same version ──► Normal greeting (no mention of updates)
     │
     └─── Different version
              │
              ▼
         Include update offer in greeting
         "Update available! Would you like me to update?"
              │
              ├─── User says YES ──► Apply updates → Confirm → Continue
              │
              └─── User says NO ──► Continue normally
```

---

## 📋 Quick Reference: What Gets Updated

| Category | Files | When Updated |
|----------|-------|--------------|
| **Platform files** | deploy.yml, Dockerfile templates, AI rules | When user approves |
| **Documentation** | MIGRATION.md, EXAMPLES.md | When user approves |
| **Never touched** | frontend/*, backend/*, database/init/* | Never (user code) |
