# 📋 Project Status Tracking

## ⚠️ CRITICAL RULE

**There is ONE and ONLY ONE status document:**

```
docs/PROJECT_STATUS.md
```

**NEVER create additional status files.** Always update this single document.

---

## 📖 At Session Start

**Before greeting, read the status document:**

```bash
cat docs/PROJECT_STATUS.md 2>/dev/null
```

### If Status Shows Project In Progress

Greet with context:

```
👋 Welcome back! 

Last time we worked on [summary from status doc].
We [completed X] and discussed [Y] as next steps.

Ready to continue? Or would you like to do something different?
```

### If Status Shows Fresh Project

Proceed with normal welcome flow (experience level → fresh/migrated check).

---

## ✏️ When to Update Status

**Update the status document after:**

1. ✅ **Completing any task** (feature, fix, configuration)
2. 🏗️ **Making significant progress** on a task
3. 🚀 **Deploying** (success or failure)
4. ⚠️ **Encountering issues** that need to be remembered
5. 📋 **Discussing future plans** with the user
6. 🔄 **Ending a session** (summarize what was done)

---

## ✏️ How to Update Status

### Update Project Overview (First Time Only)

When user describes their project idea:

```markdown
| **Project Idea** | Voting app for team lunch decisions |
| **User Level** | beginner |
| **Created** | 2026-01-19 |
```

### Update Stack Section

When components are added:

```markdown
| **Frontend** | ✅ Complete | Vanilla HTML/CSS, voting form |
| **Backend** | 🔄 In progress | Node.js, /api/votes endpoint |
| **Database** | ⬜ Not started | - |
```

Status icons:
- ⬜ Not started
- 🔄 In progress
- ✅ Complete
- ❌ Has issues

### Update Completed Tasks

Move from "In Progress" to "Completed" and add date:

```markdown
## ✅ Completed Tasks

- [x] Created homepage with navigation (2026-01-19)
- [x] Added voting form component (2026-01-19)
- [x] Backend API endpoint /api/votes (2026-01-20)
```

### Update In Progress

```markdown
## 🔄 Currently In Progress

- [ ] Implementing results display page
- [ ] Adding vote count visualization
```

### Update Deployment Status

```markdown
| **Status** | ✅ Deployed |
| **URL** | https://<repo-name>.vibe.intranet.cnb |
| **Last Deploy** | 2026-01-19 15:30 |
```

Or if failed:

```markdown
| **Status** | ❌ Deploy failed |
| **URL** | https://<repo-name>.vibe.intranet.cnb |
| **Last Deploy** | 2026-01-19 15:30 (failed - health check timeout) |
```

### Update Session History

**At end of each significant interaction, add a session entry:**

```markdown
### Session - 2026-01-19 14:30

**What was done**:
- Created homepage with voting form
- Added backend endpoint to save votes
- Tested locally - working

**Issues encountered**:
- None

**Next steps discussed**:
- Add results display page
- Deploy to production
```

**Keep the "Latest Session" section updated with most recent:**

```markdown
### Latest Session

**Date**: 2026-01-19 14:30

**Summary**: Created voting form and backend API. Local testing successful.

**Next Steps**: Add results page, then deploy.
```

---

## 🚫 What NOT to Do

❌ **Do NOT** create new status files like `status_doc/session_2.md`
❌ **Do NOT** create `PROJECT_STATUS_v2.md` or similar
❌ **Do NOT** delete the status document
❌ **Do NOT** move the status document to a different location
❌ **Do NOT** skip updating after completing tasks

---

## 📝 Quick Update Template

Copy this for quick updates:

```markdown
### Session - [DATE TIME]

**What was done**:
- [Task 1]
- [Task 2]

**Issues encountered**:
- [None / Issue description]

**Next steps discussed**:
- [Next task 1]
- [Next task 2]
```

---

## 💡 Tips for Good Status Updates

1. **Be specific** - "Added /api/votes POST endpoint" not "backend stuff"
2. **Include dates** - Helps track progress over time
3. **Note blockers** - Issues that prevented completion
4. **Record decisions** - Why certain approaches were chosen
5. **Keep it scannable** - Use bullet points, not paragraphs
