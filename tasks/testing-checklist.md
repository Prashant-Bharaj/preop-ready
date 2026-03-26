# Testing Checklist

## Batch 1 — Pushed 2026-03-26

### CI/CD Pipeline Fixes

#### 1. `workflow_dispatch` removed from deploy.yml
- [ ] Confirm the "Run workflow" button is **gone** from the deploy workflow's Actions page in any child project repo

#### 2. Scheduled CodeQL gate logic
- [ ] Wait for a scheduled CodeQL run on any child project repo (or manually trigger CodeQL)
- [ ] Check deploy.yml Actions run → gate job should show `scheduled-scan-passed` and skip deployment
- [ ] To test failure path: temporarily break CodeQL (e.g. add a known vulnerability), wait for scheduled scan, confirm `stop-on-security-failure` job triggers

#### 3. stop-project.yml (platform repo)
- [ ] Go to **platform repo** → Actions → **Stop Project** → Run workflow
- [ ] Enter a test project name, keep `dry_run: true`
- [ ] Verify output shows "Would stop service: vibe-{name}" and "Would set security-blocked marker" without making changes
- [ ] Check the summary tab shows the dry-run report
- [ ] (Optional) Run with `dry_run: false` on a disposable test project to verify actual stop behavior

#### 4. Auto-update on Codespace start
- [ ] Open a Codespace on a **child project repo** that has an older `.template-version`
- [ ] Watch terminal on startup → should see "Checking for template updates..." then "Update available: X → Y" and apply
- [ ] Open a Codespace on a repo that's already up to date → should see "Template is up to date"
- [ ] Test offline/error case → should see "Could not check for updates" (non-blocking)

### DX Improvements

#### 5. Preflight check fix (scripts/preflight-check.sh)
- [ ] In a project with only `frontend/Dockerfile` (no backend dir): `./scripts/preflight-check.sh` should pass
- [ ] In a project with `database/` dir but no `database/Dockerfile`: should show info message, not fail
- [ ] In a project with no Dockerfiles at all: should fail with clear error

#### 6. Cline extension (.devcontainer)
- [ ] Open Codespace → Cline extension (`saoudrizwan.claude-dev`) should be auto-installed via extensions list
- [ ] `install-cline.sh` should detect extension already installed and skip

#### 7. Token refresh snippet (snippets/auth/token-refresh.js)
- [ ] Review snippet content is correct and follows existing snippet patterns
- [ ] Verify it's referenced in `.clinerules/12-snippets.md` and `.clinerules/17-user-identity.md`

#### 8. Segment removal docs (.clinerules/10-platform-rules.md + 05-building.md)
- [ ] Review "Removing a Segment" section exists and is accurate
- [ ] Confirm AI assistants can discover and reference it (ask Cline "how do I remove the database from my project")

---

## Batch 2 — Snippets (2026-03-26)

### Snippet Quality Checks (all snippets)
- [ ] Every snippet file has the JSDoc header (SNIPPET, CATEGORY, LANGUAGE, STATUS, DESCRIPTION, DEPENDENCIES, USAGE)
- [ ] `snippets/INDEX.md` lists all 20 snippets across all categories
- [ ] `.clinerules/12-snippets.md` has feature→snippet mappings for all new snippets
- [ ] No hardcoded secrets or credentials in any snippet file
- [ ] Each snippet with external deps lists them in the DEPENDENCIES header

### Individual Snippet Tests

#### 9. SharePoint Client (`snippets/sharepoint/sharepoint-client.js`)
- [ ] Review `convertShareLinkToGraphUrl()` — base64 encoding matches Microsoft Shares API spec
- [ ] Review `fetchFromSharePoint()` — error handling for 401/403/404 is present
- [ ] Confirm mock fallback works when `NODE_ENV=development`
- [ ] Deploy to a test project with SharePoint URL configured → verify file download works
- [ ] Verify env var docs mention `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` (platform SSM, future)

#### 10. SMTP Email (`snippets/email/smtp-client.js`)
- [ ] Review SMTP config: host `exsmtp.na.bayer.cnb`, port `25`
- [ ] Test locally: should log email to console (not actually send)
- [ ] Deploy to test project with SMTP credentials in GitHub Secrets → send a test email
- [ ] Verify instructions explain which secret slots to use for SMTP_USER / SMTP_PASSWORD

#### 11. User Roles & Whitelisting (`snippets/auth/user-roles.js` + schema + JSX)
- [ ] Review SQL schema — users table has role/account_status columns, audit_log table exists
- [ ] Review `createSession()` — upsert logic auto-approves admin emails from INITIAL_ADMIN_EMAILS
- [ ] Review `requireRole()` and `requireApproved()` middleware — queries DB, returns 403 correctly
- [ ] Review `UserManagement.jsx` — filter by status, approve/deny buttons, role dropdown
- [ ] Deploy to test project: first login as admin email → should be auto-approved with admin role
- [ ] Login as non-admin → should see "pending" status, admin approves from management page

#### 12. Datepicker React (`snippets/ui/datepicker-react.jsx`)
- [ ] Review `DatePicker` component — controlled, has min/max/label/required props
- [ ] Review `DateRangePicker` — validates end >= start
- [ ] Review `formatDateForAPI()` returns YYYY-MM-DD
- [ ] Review timezone pitfalls section is present and accurate
- [ ] Copy into a test React project → renders correctly, form submission uses correct format

#### 13. Datepicker Vanilla (`snippets/ui/datepicker-vanilla.js`)
- [ ] Review `createDatePicker()` and `createDateRangePicker()` factory functions
- [ ] Review CSS string constant and `injectDatePickerStyles()` helper
- [ ] Copy into a vanilla HTML project → renders and validates correctly

#### 14. MGA Assistant Client (`snippets/llm/mga-assistant-client.js`)
- [ ] Review mirrors `bayer-llm-client.js` structure (same env vars: SECRET_1, API_KEY)
- [ ] Review `askAssistant()` flow: createThread → addMessage → createRun → pollRunStatus → getMessages
- [ ] Review `pollRunStatus()` — exponential backoff (1s to 5s), 120s max wait, handles all terminal states
- [ ] Review mock fallback when endpoint not configured
- [ ] Deploy to test project with MGA credentials → call `askAssistant()` with a test question
- [ ] Test thread reuse: pass `threadId` option → should continue existing conversation

#### 15. App Settings (`snippets/config/app-settings.js` + schema + JSX)
- [ ] Review SQL schema — `app_settings` table with key/value/description/updated_by/updated_at
- [ ] Review `getConfig()` — reads DB first, falls back to env var, cache with 5-min TTL
- [ ] Review `setConfig()` — upserts and invalidates cache
- [ ] Review `AppSettings.jsx` — inline edit, save, cancel, keyboard shortcuts (Enter/Escape)
- [ ] Deploy to test project: insert a setting in DB → verify `getConfig()` returns it
- [ ] Change value via AppSettings page → verify `getConfig()` returns new value immediately

#### 16. WebSocket Helper (`snippets/realtime/websocket-helper.js`)
- [ ] Review server setup — CORS config for dev vs prod, ping interval
- [ ] Review auth middleware — extracts user from OIDC headers, local dev fallback
- [ ] Review room management — join/leave with room name validation
- [ ] Review client code (in comments) — reconnect logic, session expiry handling
- [ ] Deploy to test project: connect WebSocket → verify user identity is attached to socket

#### 17. CORS + Proxy (`snippets/config/cors-proxy.js`)
- [ ] Review returns no-op middleware in production (same origin, no CORS needed)
- [ ] Review local dev allows localhost:5173/8080/3000/8888
- [ ] Review "IMPORTANT" section explains when CORS is and isn't needed
- [ ] Review "COMMON MISTAKES" section covers wildcard+credentials, duplicate headers

### AI Discovery Test
- [ ] Ask Cline: "I need to send an email" → should find `email/smtp-client.js`
- [ ] Ask Cline: "Connect to SharePoint" → should find `sharepoint/sharepoint-client.js`
- [ ] Ask Cline: "I want user roles and admin approval" → should find `auth/user-roles.js`
- [ ] Ask Cline: "Add a date picker" → should find `ui/datepicker-react.jsx`
- [ ] Ask Cline: "Real-time updates with WebSocket" → should find `realtime/websocket-helper.js`
- [ ] Ask Cline: "Change a setting without redeploying" → should find `config/app-settings.js`
- [ ] Ask Cline: "Use an MGA assistant" → should find `llm/mga-assistant-client.js`

---

## Batch 3 — AI Rules & Dependabot Workflow (2026-03-26)

### Rule 1: Repo Name Validation (`01-session-start.md`)
- [ ] New step 2 exists between "Detect Environment" and "Check Updates"
- [ ] Steps 3–7 renumbered correctly (no gaps or duplicates)
- [ ] Naming pattern documented: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`, 2-30 chars
- [ ] AI-assisted rename flow uses `gh api repos/{owner}/{repo} --method PATCH`
- [ ] Remote update step: `git remote set-url origin` after rename
- [ ] Test: create a repo with uppercase/underscores → AI should warn and offer rename
- [ ] Test: repo with valid name → AI should skip silently

### Rule 2: Dependabot Auto-Merge Workflow (`dependabot-auto-merge.yml`)
- [ ] Workflow file exists at `.github/workflows/dependabot-auto-merge.yml`
- [ ] Triggers on `pull_request` only when actor is `dependabot[bot]`
- [ ] Uses `dependabot/fetch-metadata@v2` to detect update type
- [ ] Patch/minor: auto-approves (`gh pr review --approve`) and enables auto-merge (`gh pr merge --auto --squash`)
- [ ] Major: skips auto-merge, logs the skipped dependency
- [ ] Permissions set: `pull-requests: write`, `contents: write`
- [ ] Added to `.template-manifest.yml` auto_update list
- [ ] Test: simulate a Dependabot PR on a child repo → patch/minor should auto-merge after CI
- [ ] Test: major version bump PR → should remain open for manual review

### Rule 3+4: Database Management (`05-building.md`)
- [ ] "Database Management — Critical Principles" section exists after migration rules
- [ ] Table explains: init scripts run once, migrations run every startup, data persists on EFS
- [ ] Three key principles documented: don't rebuild DB, don't commit data to git, use migrations
- [ ] Anti-patterns table: editing init SQL after deploy, committing dumps, rebuilding DB container
- [ ] Continuous deployment warning present
- [ ] Zero-downtime migration pattern (5 phases) documented
- [ ] Local testing commands: `docker-compose down -v` and `docker-compose restart backend`
- [ ] Ask Cline: "I need to add a column to my database" → should explain migrations, NOT editing init.sql

### Rule 5: GitHub Secrets Quick Link (`08-secrets.md`)
- [ ] Quick link section exists before step-by-step instructions
- [ ] Bash command constructs URL from `git remote get-url origin`
- [ ] Link format: `{repo-url}/settings/secrets/actions`
- [ ] Step-by-step section now uses the link instead of manual navigation (Steps 1-3 → click link)
- [ ] Test: run the bash command on a real repo → should produce correct GitHub URL

### Rule 6: Protected Files (`10-platform-rules.md`)
- [ ] "Protected Files — Do Not Modify" section exists after project structure
- [ ] "NEVER Modify" table lists: deploy.yml, template-sync.yml, dependabot-auto-merge.yml, .template-version, .template-manifest.yml
- [ ] "Modify with EXTREME CARE" table lists: nginx.conf, nginx.local.conf, database/Dockerfile, vectordb/Dockerfile, docker-compose.yml
- [ ] Each extreme-care file references the relevant section in the same doc
- [ ] AI messaging template present ("That file is managed by the platform...")
- [ ] Ask Cline: "Edit the deploy.yml workflow" → should refuse and explain why

### Rule 7: Large File Chunking (`16-ai-file-input.md`)
- [ ] "Large File Handling" section exists after "Supported File Types"
- [ ] Decision flow: <2MB read directly, >2MB use chunking
- [ ] Chunking patterns table covers: CSV, JSON, Excel, SQL dump, log files
- [ ] Code example shows streaming CSV import with `csv-parse`
- [ ] Cross-references `14-file-handling.md` and `file-handling/upload-handler.js` snippet
- [ ] AI messaging template ("This file is too large for me to analyze directly...")

### Index & Critical Rules (`00-INDEX.md`)
- [ ] Critical rules #14 (repo naming), #15 (protected files), #16 (schema migrations) added
- [ ] No `19-dependabot.md` in file table (handled by workflow, not AI rules)
- [ ] All cross-references in critical rules point to correct files
