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

### Step 1: Fetch the Manifest (Single Source of Truth)

```bash
REPO="bayer-int/dd-template-repository"
gh api "repos/$REPO/contents/.template-manifest.yml" --jq '.content' | base64 -d > /tmp/manifest.yml
```

### Step 2: Read the `auto_update` Section

The AI should read `/tmp/manifest.yml` and find all entries under `auto_update:`.
Each entry has:
- `path`: the file or directory path
- `is_directory`: (optional) if true, fetch all files in that directory

### Step 3: Fetch Each File/Directory

**For single files:**
```bash
gh api "repos/$REPO/contents/PATH_HERE" --jq '.content' | base64 -d > "PATH_HERE"
```

**For directories (is_directory: true):**
```bash
# List files in directory
gh api "repos/$REPO/contents/DIRECTORY_PATH" --jq '.[].name'
# Then fetch each file
```

### Step 4: Update Version Tracker

```bash
LATEST_VERSION=$(grep "^version:" /tmp/manifest.yml | cut -d'"' -f2)
cat > .template-version << EOF
# Template Version Tracker
version: "$LATEST_VERSION"
template_repo: "$REPO"
last_update_check: "$(date -Iseconds)"
EOF
```

### Key Principle

**The manifest is the single source of truth.** 

- ✅ Add a file to template → add to manifest `auto_update` → users get it on next update
- ✅ Remove a file → remove from manifest → stops being updated
- ✅ No hardcoded paths in update logic

### After Update - Tell User

```
✅ Updated to version ${LATEST_VERSION}!

Updated:
- [list files that were updated]

Your code (frontend/*, backend/*, database/init/*) was NOT touched.

Would you like to continue?
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
