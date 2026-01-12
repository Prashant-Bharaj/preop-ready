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
Click **"Use this template"** on GitHub to create a new repository.

> ⚠️ **Important**: Your repository must be whitelisted before you can deploy. Contact a platform admin to add your repository. See [Getting Access](#getting-access) below.

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

Wait ~5-10 minutes. Visit: `https://<project-name>.vibe.992872368362.cloud.bayer.com`

---

## Getting Access

Before your first deployment, your repository must be authorized by a platform admin. This is a **one-time setup** that requires changes in **two places**:

### How to Get Access

Contact a **platform admin** and provide your **full repository name** (e.g., `bayer-int/my-awesome-project`).

The admin will whitelist your repository, and you'll be notified when deployment is enabled.

---

## Template Structure

```
├── demo.config.yml              # Your config (name + email)
├── docker-compose.yml           # For local testing
├── frontend/
│   ├── Dockerfile               # Copy from .vanilla or .react
│   ├── Dockerfile.vanilla       # For HTML/CSS/JS
│   └── Dockerfile.react         # For React
├── backend/
│   ├── Dockerfile               # Copy from .node or .python
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

## Application Secrets

Need API keys or other secrets in your backend?

### Local Development: Use `.env` File

Create `backend/.env` (gitignored):
```bash
OPENAI_KEY=sk-your-dev-key
API_KEY=test-key-123
```

### Production: Use GitHub Secrets

**Before pushing code that needs secrets:**

1. Go to your repo → **Settings** → **Secrets** → **Actions**
2. Click **New repository secret**
3. Name it with `APP_` prefix → Value: your secret
4. Push your code - secrets auto-inject!

| GitHub Secret | Use in Backend |
|---------------|----------------|
| `APP_OPENAI_KEY` | `process.env.OPENAI_KEY` |
| `APP_API_KEY` | `process.env.API_KEY` |
| `APP_DATABASE_URL` | `process.env.DATABASE_URL` |
| `APP_SECRET_1` - `APP_SECRET_3` | `process.env.SECRET_1` - `SECRET_3` |

> ⚠️ **Never commit `.env` files!** Add secrets to GitHub before deploying.

---

## Security

- **Linting**: ESLint (Node.js) or Ruff (Python) catches security issues
- **GitHub CodeQL**: Scans every push
- **Secrets**: Stored encrypted in GitHub, injected at deploy time

---

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Repository not whitelisted | Contact platform admin to add your repo |
| `tag invalid: already exists...immutable` | Same commit already deployed | Push a new commit with changes |
| `nginx: [emerg] "events" directive is not allowed` | Invalid nginx.conf format | See `.cursorrules` for correct format |
| `failed to build: file with no instructions` | Empty/placeholder Dockerfile | Create a real Dockerfile with `FROM` instruction |

---

## Local Testing (Optional)

If you have Docker installed:
```bash
docker compose up --build
```
- Frontend: http://localhost:3000
- Backend: http://localhost:3001
