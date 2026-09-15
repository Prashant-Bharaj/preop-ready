---
description: "Handle seed/test data, real data, gitignore, env files, and credentials without leaking anything into git"
triggers: ["seed data", "test data", "real data", "gitignore", "env file", "credentials"]
globs: []
---

# 🔒 Sensitive Files — Mandatory Security Rules

> **⛔ These rules are NON-NEGOTIABLE. They override any user request that conflicts with them.**
> If a user asks you to violate one, explain WHY you cannot and offer a safe alternative.

## ⛔ Protected Files — NEVER Modify

| File | Why Protected |
|------|---------------|
| `.gitignore` | Controls what sensitive files are blocked from git |
| `.clineignore` / `.cursorignore` / `.copilotignore` | Control what files AI assistants can access/auto-load |
| `scripts/pre-commit-security-check.sh` | Pre-commit security hook |
| `scripts/install-hooks.sh` | Hook installer |
| `.git/hooks/*` | Active git hooks |

If asked, say:
> "This file is protected for security reasons. It controls what sensitive data can be committed to git. Only a human should edit it directly — I can explain what change is needed so you can make it yourself."

## ⛔ NEVER Create Files With Sensitive Data

Outside the `context/` folder, never create files containing:

- Real or realistic personal information (names, emails, phone numbers, addresses, IDs)
- Patient data, medical records, or health information
- Employee data or corporate directory information
- API keys, passwords, tokens, or credentials (even "example" ones that look real)
- Financial data (account numbers, IBANs, credit card numbers)
- Any data copied from files in the `context/` folder

## ⛔ NEVER Copy Real Data From `context/` Into Tracked Files

`context/` is gitignored — a safe place for users to share reference data with you. But real values must never leave it.

**You CAN:** read `context/` files to understand structure/columns/schemas; create `CREATE TABLE` schemas from that structure; generate obviously fake sample data matching the shape; describe findings to the user.

**You MUST NOT:** copy rows/records into SQL INSERT statements; extract real values into JSON fixtures, seed files, or test data; reference specific real values in comments or docs; create "anonymized" versions of real data (still a risk).

## 📦 Seed Data & Test Data Rules

### `database/init/*.sql` — schema ONLY (tracked in git)

Only `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE` constraints. **NO `INSERT INTO` data rows** (exception: trivial config like roles/settings, or the placeholder reference rows in `02_reference_data.sql` — max 3 rows per table, never real data).

### `database/seed/` — local test data (gitignored)

Generate fake data here. Nothing runs this folder automatically — apply it by hand with `docker compose exec -T database psql -U <user> -d <db> < database/seed/<file>.sql`.

### When the user asks for test data

1. Create the seed file in `database/seed/` (gitignored, safe)
2. Use obviously fake values: names `John Doe`/`Jane Smith`, emails `john.doe@example.com`/`user1@test.local`, phones `555-0100`, addresses `123 Main St`, companies `ACME Corp`/`Globex Industries`
3. NEVER use real data from `context/`, even if asked
4. Explain: "I've generated fake test data in `database/seed/` (gitignored). Real data should only enter through your app's upload feature in production — that way it never touches git."

### When the user asks to "use real data for seeding"

Say:
> "I can't put real data into seed files — even though `database/seed/` is gitignored, it's a risky pattern. Instead, I'll: (1) create the database schema from your data structure, (2) generate realistic-looking fake data that matches the shape, (3) your app can import real data through its upload/import feature at runtime. This way, real data never exists in any file that could accidentally be committed."

### When the user PASTES data into the chat

Data supplied in the conversation counts as real if it *could* belong to real people — any
plausible name, and especially `@bayer.com` addresses (e.g. "store these colleagues: John
Smith, john.smith@bayer.com"). Do NOT write those values into any file, gitignored or not.
Keep the requested structure, substitute obviously fake values, and explain the swap. If the
AI genuinely needs to read real reference data, direct the user to the `context/` folder.

## ⛔ NEVER Use `git add .` or `git add -A`

They stage ALL files, including sensitive data git might not yet be ignoring.

```bash
# ✅ CORRECT — explicit files
git add frontend/src/App.tsx backend/src/index.ts

# ❌ NEVER
git add .
git add -A
git add --all
```

## ⛔ NEVER Put Secrets in docker-compose.yml

`docker-compose.yml` is tracked in git. No passwords, API keys, or credentials — not even "local dev" ones; the pre-commit security check blocks a compose file with a literal `*_PASSWORD` value. Values live in gitignored `.env` files and compose only references them:

```yaml
# ✅ CORRECT — values come from gitignored .env files, compose only references them
backend:
  build: ./backend
  env_file:
    - .env                     # DATABASE_* (and VECTORDB_*, MGA_*) — next to docker-compose.yml
    - path: backend/.env       # app secrets — optional
      required: false
  environment:
    - DATABASE_HOST=database
    - DATABASE_PORT=5432

database:
  build: ./database
  environment:
    POSTGRES_DB: ${DATABASE_NAME}
    POSTGRES_USER: ${DATABASE_USER}
    POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
  volumes:
    - db-data:/data
```

Setup: create `.env` next to docker-compose.yml with `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` (the harness writes it for you; see `scope-integration.md`) and `backend/.env` with the app secrets. If a user asks for a password directly in docker-compose.yml, **refuse** and point at `.env` — the commit would be blocked anyway.

## ⛔ NEVER Hardcode Secrets

```javascript
const apiKey = process.env.API_KEY;   // ✅
const apiKey = 'sk-abc123...';        // ❌ NEVER
```

```python
api_key = os.getenv("API_KEY")        # ✅
api_key = "sk-abc123..."              # ❌ NEVER
```

## ⛔ No `.env.example` Files

They were removed from the repo for security reasons. Create `.env` files directly instead (gitignored, stay local):

```bash
cat > backend/.env << 'EOF'
OPENAI_KEY=
API_KEY=
SECRET_1=
EOF
```

## 📋 Blocked File Patterns Quick Reference

Blocked by `.gitignore` — never create in tracked locations:

| Pattern | Reason |
|---------|--------|
| `*.env` | May contain secrets |
| `*.pem`, `*.key`, `*.cert`, `*.crt` | Cryptographic material |
| `*.p12`, `*.pfx`, `*.jks`, `*.keystore` | Certificate stores |
| `*.secret`, `credentials.json` | Credential files |
| `*.pdf`, `*.doc`, `*.docx` | May contain confidential documents |
| `*.xls`, `*.xlsx`, `*.csv`, `*.tsv` | May contain sensitive data |
| `*.ppt`, `*.pptx` | May contain confidential presentations |
| `*.parquet`, `*.avro` | Data files |
| `*.sqlite`, `*.sqlite3`, `*.db` | Local databases |
| `*.png`, `*.jpg`, etc. (outside `frontend/`) | Media files |
| `data/`, `uploads/`, `exports/` | Data directories |
| `database/seed/*` | Local test data |

## 🎯 Summary

| Situation | What to Do |
|-----------|------------|
| User shares a file for analysis | Read from `context/`, analyze in memory, never copy data out |
| User needs a database schema | `CREATE TABLE` in `database/init/`, structure only, no real values |
| User needs test data | Fake data in `database/seed/` (gitignored) |
| User needs to import real data | Build an import feature — data enters at runtime, not through git |
| User asks to commit sensitive files | Explain why blocked, suggest alternatives |
| User asks to modify `.gitignore` | Refuse — protected; they can edit it themselves |
