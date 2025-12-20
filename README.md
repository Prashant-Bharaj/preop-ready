# Vibe Coded Project Template

Template for deploying vibe coded projects to the Bayer Hackathons Platform.

## Supported Stacks

| Layer | Options |
|-------|---------|
| Frontend | Vanilla (HTML/CSS/JS) or React |
| Backend | Node.js or Python |
| Database | MySQL or PostgreSQL |

---

## Quick Start

### 1. Create Your Repository
Click **"Use this template"** on GitHub.

### 2. Open in VS Code with Cline

### 3. Tell AI What You Want to Build

The AI will ask you:
1. **Project name and email** (for `demo.config.yml`)
2. **What do you want to build?** - Describe your app

Based on your description, AI will:
- Recommend the right stack (React vs Vanilla, Node vs Python, MySQL vs PostgreSQL)
- Generate all the code
- Set up Dockerfiles
- **Configure linting** (ESLint for Node.js, Ruff for Python)

### 4. Deploy

```bash
git add .
git commit -m "feat: my vibe project"
git push origin main
```

Wait ~5-10 minutes. Visit: `https://<project-name>.vibe.int.bayer.com`

---

## Template Structure

```
├── demo.config.yml              # Your config (name + email)
├── docker-compose.yml           # For local testing
├── frontend/
│   ├── Dockerfile.vanilla       # For HTML/CSS/JS
│   └── Dockerfile.react         # For React
├── backend/
│   ├── Dockerfile.node          # For Node.js
│   └── Dockerfile.python        # For Python
├── examples/
│   ├── eslint.config.js         # Linting for Node.js
│   └── ruff.toml                # Linting for Python
└── .github/workflows/deploy.yml # CI/CD
```

---

## What AI Generates

Based on your stack choice:

| Stack | Files Generated |
|-------|-----------------|
| Node.js backend | `Dockerfile`, `package.json`, `src/index.js`, **`eslint.config.js`** |
| Python backend | `Dockerfile`, `requirements.txt`, `main.py`, **`ruff.toml`** |
| Vanilla frontend | `Dockerfile`, `index.html`, `style.css`, `script.js` |
| React frontend | `Dockerfile`, `package.json`, `vite.config.js`, `src/*` |

---

## Example Conversation

**You:** "I want to build a task management app where users can create, edit, and delete tasks. It should have a nice dashboard."

**AI:** "Based on what you described, I recommend:
- **Frontend**: React - for the interactive dashboard
- **Backend**: Node.js - great for CRUD operations
- **Database**: MySQL - perfect for structured task data

Does this work for you?"

**You:** "Yes!"

**AI:** *generates all code including `eslint.config.js` for security linting*

---

## Security

- **Linting**: ESLint (Node.js) or Ruff (Python) catches security issues
- **GitHub CodeQL**: Scans every push
- **Deployment blocked** if vulnerabilities found
- **Email sent** with details

---

## Local Testing (Optional)

If you have Docker installed:
```bash
docker compose up --build
```
- Frontend: http://localhost:3000
- Backend: http://localhost:3001
