# 🚀 Session Start - Environment & Version Checks

## IMPORTANT: Run These Checks at the START of Every New Session

**Order of operations:**

1. **Detect Environment** (Local vs Codespaces - for correct URLs)
2. **Validate Repo Name** (check naming convention, offer rename if needed)
3. **Check Template Version** (run script silently)
4. **Read Project Status** (if exists)
5. **Greet User** (include update notification if available)

---

## 0️⃣ Install Security Hooks (Run Silently — First Thing!)

**Always run this before anything else:**

```bash
./scripts/install-hooks.sh
```

This installs the pre-commit security hook that prevents accidental commits of sensitive files. It's idempotent (safe to run multiple times). Don't mention this to the user — it runs silently in the background.

---

## 1️⃣ Detect Environment (Run Silently)

**Detect if user is in Codespaces or Local — see `15-urls.md` for the detection command, URL formats, and troubleshooting.**

---

## 2️⃣ Validate Repo Name (Run Silently)

**Check if the repository name follows platform naming conventions.**

```bash
# Get repo name from git remote
REPO_NAME=$(basename -s .git $(git remote get-url origin 2>/dev/null) 2>/dev/null)
```

**Naming rules:**
- Pattern: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`
- Length: 2–30 characters
- Allowed: lowercase letters, numbers, hyphens
- NOT allowed: uppercase, underscores, special characters, spaces

**Why it matters:**
- ECS service name = `vibe-{repo-name}` (must be valid)
- Production URL = `https://{repo-name}.vibe.intranet.cnb`
- Invalid names will cause deployment failures

**If name is non-compliant:**

```
⚠️ Your repository name "{current-name}" doesn't follow the platform naming convention.

Valid names: lowercase letters, numbers, and hyphens only (2-30 chars).
Example: "my-cool-app", "hackathon-2026", "sales-dashboard"

Your name has: {explain violation — e.g., "uppercase letters", "underscores"}

Suggested name: "{suggested-name}"

Want me to rename it for you? (Your code and git history will be preserved)
```

**If user says YES — rename via GitHub API:**

```bash
# Step 1: Rename on GitHub
gh api repos/{owner}/{current-name} --method PATCH -f name='{new-name}'

# Step 2: Update local remote
git remote set-url origin https://github.com/{owner}/{new-name}.git

# Step 3: Verify
git remote get-url origin
```

**After rename:**
```
✅ Repository renamed to "{new-name}"!

Your production URL will be: https://{new-name}.vibe.intranet.cnb
All your code and git history are preserved.
```

**If user says NO:** Continue normally. The repo may still work if it's already whitelisted, but deployment could fail if the name causes issues.

---

## 3️⃣ Check for Platform Updates (Run Silently)

**Run the check script:**

```bash
./scripts/check-updates.sh
```

**Interpret the output:**

| Output | Meaning | Action |
|--------|---------|--------|
| `UP_TO_DATE` | No updates available | Don't mention updates |
| `UPDATE_AVAILABLE\|old\|new` | Update available | Offer update in greeting |
| `CHECK_FAILED` | Couldn't check (network, etc.) | Don't mention updates, continue normally |

**Store the result** - you'll use it in the greeting.

---

## 4️⃣ Read Project Status

**Check if this is a returning user or a brand new project:**

```bash
cat docs/PROJECT_STATUS.md 2>/dev/null
```

**Simple check — look for the default Project Idea value:**
- If Project Idea is `_Awaiting user input_` → **NEW user** (use welcome from `02-welcome-modes.md`)
- If Project Idea is anything else → **RETURNING user** (use "Welcome back" from below)

**DO NOT say "Welcome back" to new users.** A fresh PROJECT_STATUS.md with default values = NEW user, even though the file exists.

---

## 5️⃣ Greet User

**After completing the silent checks above, greet the user appropriately.**

### For Returning Users (PROJECT_STATUS.md shows work done)

```
👋 Welcome back!

Last time we [summary from Latest Session in PROJECT_STATUS.md].
Your project: [Project Idea from status]

Ready to continue? Or would you like to work on something different?
```

Then if updates are available (`UPDATE_AVAILABLE`), add:
```
📦 By the way, a platform update is available (v{old} → v{new}). Want me to update now? (Your code won't be affected)
```

### For New Users (PROJECT_STATUS.md empty or doesn't exist)

**Use the welcome message from `02-welcome-modes.md`** - it has the full 3-question onboarding flow.

If updates are available, mention it briefly after the welcome:
```
📦 Quick note: A platform update is available. I can apply it anytime - just ask!
```

---

**IMPORTANT:** The detailed welcome flow, beginner/developer modes, and communication styles are defined in `02-welcome-modes.md`. This file handles the technical checks that happen BEFORE the greeting.

---

## 6️⃣ If User Says "Yes" to Update (from greeting)

**Simply run the apply script:**

```bash
./scripts/apply-updates.sh
```

**The script will:**
1. Fetch the manifest from the template repo
2. Download all files listed in `auto_update` section
3. Update the version tracker
4. Output what was updated

**Watch for the output:**
- `UPDATE_COMPLETE|<version>` → Success!
- `UPDATE_FAILED|<reason>` → Something went wrong

### After Update - Tell User

```
✅ Updated to version [version from script output]!

[List files that were updated from script output]

Your code (frontend/*, backend/*, database/init/*) was NOT touched.

Ready to continue?
```

---

## 7️⃣ If User Says "No" or "Later"

```
No problem! You can update anytime by asking me to "update platform files".

Now, what would you like to work on?
```

---

## ⚠️ Important Notes for Codespaces

1. **GitHub CLI**: The scripts use `gh api` (pre-authenticated in Codespaces)
2. **Git Operations**: User may need to commit after updates
3. **No Sudo**: Don't use sudo commands
4. **Working Directory**: Always run scripts from repo root

---

## 🔄 Update Flow Summary

```
Session Start
     │
     ▼
./scripts/check-updates.sh (silently)
     │
     ▼
Parse output
     │
     ├─── "UP_TO_DATE" ──► Normal greeting (no mention of updates)
     │
     ├─── "CHECK_FAILED" ──► Normal greeting (no mention of updates)
     │
     └─── "UPDATE_AVAILABLE|old|new"
              │
              ▼
         Include update offer in greeting
         "Update available (vX → vY)! Want me to update?"
              │
              ├─── User says YES ──► ./scripts/apply-updates.sh → Confirm → Continue
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

---

## 🛠️ Manual Update Commands

If user asks to update manually or the scripts don't work:

```bash
# Check for updates
./scripts/check-updates.sh

# Apply updates
./scripts/apply-updates.sh
```

Or user can say: **"Update platform files"** or **"Check for updates"**
