---
description: "Keep docs/PROJECT_STATUS.md current after milestones so every session resumes with full context"
triggers: ["after any milestone", "update status", "project status"]
globs: []
---

# Project Status Tracking

⛔ **There is ONE and ONLY ONE status document: `docs/PROJECT_STATUS.md`.** Never create additional status files. Always update this single document.

## At Session Start

Read it before greeting: `cat docs/PROJECT_STATUS.md 2>/dev/null`

- **In progress** → greet with context: "Welcome back! Last time we [summary]. We completed [X] and discussed [Y] next. Ready to continue?"
- **Fresh project** → normal welcome flow (experience level → fresh/migrated check).

## When to Update

1. Completing any task (feature, fix, configuration)
2. Making significant progress on a task
3. Deploying (success OR failure)
4. Encountering issues worth remembering
5. Discussing future plans with the user
6. Ending a session (summarize what was done)

## How to Update

**Project overview** (first time only): project idea, user level, created date.

**Stack section** — status per component with icons: ⬜ Not started · 🔄 In progress · ✅ Complete · ❌ Has issues

```markdown
| **Frontend** | ✅ Complete | React, voting form |
| **Backend** | 🔄 In progress | Node.js, /api/votes endpoint |
```

**Completed tasks** — move from "In Progress" to "Completed", dated:

```markdown
- [x] Backend API endpoint /api/votes (2026-01-20)
```

**Deployment status:**

```markdown
| **Status** | ✅ Deployed |            <!-- or: ❌ Deploy failed -->
| **URL** | https://<repo-name>.vibe.intranet.cnb |
| **Last Deploy** | 2026-01-19 15:30 |  <!-- on failure: append reason, e.g. (failed - health check timeout) -->
```

**Session entry** — append after each significant interaction, and keep a "Latest Session" section with the most recent date, summary, and next steps:

```markdown
### Session - [DATE TIME]

**What was done**:
- [Task 1]
- [Task 2]

**Issues encountered**:
- [None / description]

**Next steps discussed**:
- [Next task]
```

## What NOT to Do

- ❌ Do NOT create new status files (`status_doc/session_2.md`, `PROJECT_STATUS_v2.md`, ...)
- ❌ Do NOT delete or move the status document
- ❌ Do NOT skip updating after completing tasks

## Tips

Be specific ("Added /api/votes POST endpoint", not "backend stuff"); include dates; note blockers; record why decisions were made; keep it scannable (bullets, not paragraphs).
