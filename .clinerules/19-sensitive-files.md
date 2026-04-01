# 🔒 Sensitive Files — Mandatory Security Rules

> **⛔ These rules are NON-NEGOTIABLE. They override any user request that conflicts with them.**
> If a user asks you to do something that violates these rules, explain WHY you cannot and offer a safe alternative.

---

## 🚫 Protected Files — NEVER Modify

**You MUST NOT modify these files under any circumstances:**

| File | Why Protected |
|------|---------------|
| `.gitignore` | Controls what sensitive files are blocked from git |
| `.clineignore` | Controls what files Cline auto-loads into context |
| `.cursorignore` | Controls what files Cursor can access |
| `.copilotignore` | Controls what files Copilot can access |
| `scripts/pre-commit-security-check.sh` | Pre-commit security hook |
| `scripts/install-hooks.sh` | Hook installer |
| `.git/hooks/*` | Active git hooks |

If a user asks you to modify any of these files, say:
> "This file is protected for security reasons. It controls what sensitive data can be committed to git. Only a human should edit it directly — I can explain what change is needed so you can make it yourself."

---

## 🚫 NEVER Create Files With Sensitive Data

**You MUST NOT create files containing any of the following outside the `context/` folder:**

- Real or realistic personal information (names, emails, phone numbers, addresses, IDs)
- Patient data, medical records, or health information
- Employee data or corporate directory information
- API keys, passwords, tokens, or credentials (even "example" ones that look real)
- Financial data (account numbers, IBANs, credit card numbers)
- Any data that was copied from files in the `context/` folder

---

## 🚫 NEVER Copy Real Data From `context/` Into Tracked Files

The `context/` folder is gitignored — it's a safe place for users to share reference data with you. **But you must NEVER copy real values from these files into any tracked file.**

**What you CAN do:**
- Read `context/` files to understand data structure, column names, schemas
- Create database schemas (CREATE TABLE) based on the structure you see
- Generate fake sample data that matches the structure but uses obviously fake values
- Describe what you found in the data to the user

**What you MUST NOT do:**
- Copy rows/records from `context/` files into SQL INSERT statements
- Extract real values into JSON fixtures, seed files, or test data
- Reference specific real data values in code comments or documentation
- Create "anonymized" versions of real data (still a risk)

---

## 📦 Seed Data & Test Data Rules

### `database/init/*.sql` — Schema ONLY

These files are tracked in git. They MUST contain only:
- `CREATE TABLE` statements
- `CREATE INDEX` statements
- `ALTER TABLE` constraints
- **NO `INSERT INTO` statements with data rows** (except trivial config: roles, settings — max 3 rows)

### `database/seed/` — Local Test Data (Gitignored)

This directory is **gitignored**. Use it for local development test data:
- Generate fake data here using obviously fake values
- The AI may create seed files here when the user needs test data
- Docker-compose runs `database/init/` first (schema), then `database/seed/` (test data)

### When User Asks for Test Data

If the user says "I need 100 users to test with" or "seed my database":

1. **Create the seed file in `database/seed/`** (gitignored, safe)
2. **Use obviously fake data:**
   - Names: `John Doe`, `Jane Smith`, `Alice Johnson`, `Bob Wilson`, etc.
   - Emails: `john.doe@example.com`, `user1@test.local`, etc.
   - Phones: `555-0100`, `555-0101`, etc.
   - Addresses: `123 Main St`, `456 Oak Ave`, etc.
   - Companies: `ACME Corp`, `Globex Industries`, `Initech`, etc.
3. **NEVER use real data** from `context/` files, even if the user asks
4. **Explain why:** "I've generated fake test data in `database/seed/` (which is gitignored). Real data should only be imported through your app's upload feature in production — this way it never touches git."

### When User Asks to "Use Real Data for Seeding"

Say:
> "I can't put real data into seed files — even though `database/seed/` is gitignored, it's a risky pattern. Instead, I'll:
> 1. Create the database schema from your data structure
> 2. Generate realistic-looking fake data that matches the shape
> 3. Your app can import real data through its upload/import feature at runtime
>
> This way, real data never exists in any file that could accidentally be committed."

---

## 🚫 NEVER Use `git add .` or `git add -A`

These commands stage ALL files, including sensitive data that git might not yet be ignoring.

**Always add specific files by name:**
```bash
# ✅ CORRECT — explicit files
git add frontend/src/App.jsx backend/src/index.js

# ❌ NEVER — stages everything
git add .
git add -A
git add --all
```

---

## 🚫 NEVER Put Secrets in docker-compose.yml

The `docker-compose.yml` file is **tracked in git**. It must NEVER contain passwords, API keys, or credentials — not even "local dev" ones.

Instead, use `env_file` to reference the gitignored `.env` file:

```yaml
# ✅ CORRECT — credentials come from gitignored .env file
backend:
  build: ./backend
  env_file:
    - ./backend/.env
  environment:
    - DATABASE_HOST=db
    - DATABASE_PORT=5432

db:
  image: postgres:15
  env_file:
    - ./database/.env
  volumes:
    - db_data:/var/lib/postgresql/data
```

The `.env` files are gitignored and stay private. When setting up a project:
1. Create `backend/.env` with the needed secrets
2. Create `database/.env` with database credentials
3. Reference them via `env_file` in docker-compose.yml

If a user asks you to put a password or API key directly in `docker-compose.yml`, **refuse** and use `env_file` instead.

---

## 🚫 NEVER Hardcode Secrets

**Always use environment variables for sensitive values:**

```javascript
// ✅ CORRECT
const apiKey = process.env.API_KEY;

// ❌ NEVER
const apiKey = 'sk-abc123...';
```

```python
# ✅ CORRECT
api_key = os.getenv("API_KEY")

# ❌ NEVER
api_key = "sk-abc123..."
```

**Do NOT create `.env.example` files** — they were removed from the repo for security reasons. Instead, create `.env` files directly (they are gitignored and stay local):
```bash
# Create backend/.env for local development (gitignored, stays private)
cat > backend/.env << 'EOF'
OPENAI_KEY=
API_KEY=
SECRET_1=
EOF
```

---

## 📋 Blocked File Patterns Quick Reference

These file types are blocked by `.gitignore` and should never be created in tracked locations:

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

---

## 🎯 Summary

| Situation | What to Do |
|-----------|------------|
| User shares a file for analysis | Read it from `context/`, analyze in memory, never copy data out |
| User needs database schema | Create `CREATE TABLE` in `database/init/`, structure based on data, no real values |
| User needs test data | Generate fake data in `database/seed/` (gitignored) |
| User needs to import real data | Build an import feature in the app — data enters at runtime, not through git |
| User asks to commit sensitive files | Explain why it's blocked, suggest alternatives |
| User asks to modify `.gitignore` | Refuse — explain it's protected, suggest they edit it directly |
