# !! IMPORTANT: No Real Data Allowed !!

> **NEVER PUT REAL COMPANY DATA IN YOUR PROJECT FILES.**
>
> Your app might work with sensitive information — employee lists, patient records, sales numbers, internal documents. **That data must never be saved in your project.** Not in spreadsheets, not in database files, not anywhere.

**What counts as "real data"?** Anything that came from a real Bayer system — names, emails, reports, documents, numbers from real people or real business.

| Safe | Not safe |
|------|----------|
| Make up test data: `John Doe`, `jane@example.com` | Use real names, real emails, or real documents |
| Share reference files with the AI via the `context/` folder (your AI can read these, but they stay private) | Put spreadsheets, PDFs, or data files directly in your project |
| Let the AI generate fake sample data for testing | Copy-paste real data into any file |
| Add passwords and API keys through GitHub Settings | Write passwords or API keys directly in your code |

**We have automated checks that will block your work if any data that even resembles real data is detected.** Your project will refuse to save if it finds spreadsheets, documents, passwords, or anything that looks like it could be real. Your AI assistant also follows these rules and will help you stay on the safe side.

> **This platform is approved for non-production, non-regulated, dummy or synthetic data only. Processing of Bayer Confidential, PII, PHI, or regulated datasets is explicitly prohibited without prior security review and ITLM approval for elevated data classification.**

> For the full details, see `.clinerules/19-sensitive-files.md`.

---

# Welcome to the Vibe Hackathon Platform!

> **No coding experience? No problem!** Your AI assistant will help you build and deploy your app.
>
> **Developer?** Skip to the [Developer Quick-Start](#-developer-quick-start) below.
>
> **Have existing code to migrate?** See the [Migration Guide](./docs/MIGRATION.md).
>
> **Not sure how to describe your idea?** See [Example Prompts](./docs/EXAMPLES.md).

---

## 🤔 What is this?

This is your **hackathon project workspace**. You're going to build a web application that will be live on the internet!

**What you'll create:**
- A website that real people can visit
- With features YOU design (forms, dashboards, AI integrations, etc.)
- Deployed automatically when you save your work

**What you DON'T need:**
- ❌ Coding experience
- ❌ Server setup knowledge
- ❌ DevOps skills

**Your AI assistant (Cline) will write all the code for you!**

---

## 👨‍💻 Developer Quick-Start

<details>
<summary><b>Click here if you're a developer</b> - skip the hand-holding</summary>

### Architecture
```
frontend/          → nginx (port 80) - static or React build
backend/           → Express/FastAPI/Actix-web (port 3000)
database/          → PostgreSQL/MySQL/pgvector/Chroma/Qdrant (optional)
```

### Deployment Types (Auto-Detected!)
| Project Type | Detection | URL |
|-------------|-----------|-----|
| **Frontend-only** (Vanilla/React) | No `backend/Dockerfile` | `https://docs.int.bayer.com/-/<repo>/` |
| **Full-Stack** (has backend) | Has `backend/Dockerfile` | `https://<repo>.vibe.intranet.cnb` |

### Routing (Full-Stack/ECS only)
```
https://[project].vibe.intranet.cnb      → frontend
https://[project].vibe.intranet.cnb/api  → backend (stripped)
```

### Required: Health Endpoint
```javascript
// backend/server.js - MUST exist at /health on port 3000
app.get('/health', (req, res) => res.json({ status: 'ok' }));
```

### Pre-flight Check (Before First Deploy)
```bash
./scripts/preflight-check.sh
# Validates: Dockerfiles, nginx.conf, health endpoints, etc.
```

### Local Development
```bash
docker-compose up -d --build    # Run in background
docker-compose logs -f          # Watch logs
docker-compose down             # Stop
# Frontend: http://localhost:8080
# Backend:  http://localhost:3000
```

### Deploy
```bash
# First time: Contact admin to whitelist your repo in variables.tf
git add . && git commit -m "feat: description" && git push
# → GitHub Actions builds & deploys (~3-5 min)

# URL depends on project type:
# Frontend-only: https://docs.int.bayer.com/-/[repo-name]/
# Full-stack:    https://[repo-name].vibe.intranet.cnb
```

### Secrets (GitHub → Settings → Secrets → Actions)
| Secret Name | Env Var in Code |
|-------------|-----------------|
| `APP_OPENAI_KEY` | `process.env.OPENAI_KEY` |
| `APP_API_KEY` | `process.env.API_KEY` |
| `APP_SECRET_1` | `process.env.SECRET_1` |

### Stack Options
- **Frontend:** Copy `Dockerfile.vanilla` or `Dockerfile.react` → `Dockerfile`
- **Backend:** Copy `Dockerfile.node`, `Dockerfile.python`, or `Dockerfile.rust` → `Dockerfile`
- **Database:** Copy one of these to `database/Dockerfile`:
  - `Dockerfile.postgres` - Standard SQL database (recommended)
  - `Dockerfile.mysql` - MySQL database
- **Vector DB:** Copy one of these to `vectordb/Dockerfile`:
  - `Dockerfile.pgvector` - PostgreSQL + vector search (AI apps)
  - `Dockerfile.chroma` - ChromaDB vector database
  - `Dockerfile.qdrant` - Qdrant vector database

### Tell the AI
When you open Cline, just say: **"I'm a developer"** - it'll skip the hand-holding.

</details>

---

## 🚀 How to Get Started

### Step 1: Talk to Your AI Assistant

Look for the **Cline** extension in the sidebar (robot icon 🤖).

Click on it and say something like:

```
Hi! I want to build [your idea here]
```

**Example ideas:**
- "A voting app for our team's lunch decisions"
- "A dashboard to track hackathon project ideas"
- "A form that collects feedback and shows results"
- "An AI chatbot that answers questions about our product"

### Step 2: Let AI Build It

The AI will:
1. Ask clarifying questions about your idea
2. Create all the code for you
3. Explain what it's building (if you want to know)

**Just describe what you want in plain English!**

### Step 3: Test Your App

When the AI finishes building, it will ask:

```
"Want me to start the app so you can see it?"
```

Say **yes** and the AI will run it for you! Then open: **http://localhost:8080**

### Step 4: Make It Live!

> ⚠️ **First time?** Your repo must be [whitelisted](#-first-time-only-get-whitelisted) before deploying.

Happy with your app? Just tell the AI:

```
"I'm happy with it, let's deploy!"
```

The AI will save your work and deploy it automatically!

**Wait 3-5 minutes**, then visit your live site:

**Your URL depends on your project type:**
| Project Type | URL |
|-------------|-----|
| Frontend-only (no backend) | `https://docs.int.bayer.com/-/YOUR-REPO-NAME/` |
| Full-stack (has backend) | `https://YOUR-REPO-NAME.vibe.intranet.cnb` |

*(Requires Bayer VPN)*

---

## 📁 Where is Everything?

```
📂 Your Project
│
├── 📁 frontend/          ← The website (what users see)
│   ├── index.html        ← Your main webpage
│   ├── style.css         ← Colors and styling
│   ├── script.js         ← Interactive features
│   └── Dockerfile        ← Copy from Dockerfile.vanilla or .react
│
├── 📁 backend/           ← The server (saves data, APIs)
│   ├── server.js         ← Server code
│   └── Dockerfile        ← Copy from Dockerfile.node, .python, or .rust
│
└── 📁 database/          ← Data storage (optional)
    ├── Dockerfile        ← Copy from Dockerfile.postgres/.mysql/.pgvector/.chroma/.qdrant
    └── init/init.sql     ← Database setup (for SQL databases)
```

**Don't worry about the other files** - the AI manages them for you!

---

## ❓ Why This Platform?

| Traditional Way | Vibe Platform |
|-----------------|---------------|
| Learn to code first | Just describe what you want |
| Set up servers | Automatic deployment |
| Configure databases | AI handles it |
| Debug errors alone | AI helps fix issues |
| Takes weeks | Takes hours |

**Focus on your IDEA, not the technology!**

---

## 🔄 How Deployment Works

### ⚠️ First Time Only: Get Whitelisted

Before your first deployment, your repository needs to be **whitelisted**:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  📧 Contact a Platform Admin                                    │
│                                                                 │
│  Send them your repository name:                                │
│  • e.g., bayer-int/my-awesome-app                              │
│                                                                 │
│  They'll add it to the whitelist (takes ~5 minutes)            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**This is a one-time step** - once whitelisted, all future deployments are automatic!

---

### 🚀 After You're Whitelisted

When you say **"Let's deploy!"**, here's what happens:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  YOU: "I'm happy with it, let's deploy!"                       │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────┐                       │
│  │  1️⃣  AI saves your code             │  ← Instant           │
│  │     (git add & commit)              │                       │
│  └─────────────────────────────────────┘                       │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────┐                       │
│  │  2️⃣  Code pushed to GitHub          │  ← Instant           │
│  │     (git push)                      │                       │
│  └─────────────────────────────────────┘                       │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────┐                       │
│  │  3️⃣  GitHub Actions detects type    │  ← Automatic!        │
│  │     • Frontend-only → Static deploy │    (3-5 mins)        │
│  │     • Has backend → ECS deploy      │                       │
│  └─────────────────────────────────────┘                       │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────┐                       │
│  │  4️⃣  YOUR APP IS LIVE! 🎉           │                       │
│  │     (URL depends on project type)   │                       │
│  └─────────────────────────────────────┘                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Watch the Progress

Want to see what's happening? 

1. Go to your **GitHub repository** (the website)
2. Click the **Actions** tab
3. Watch the deployment progress in real-time!

### After Deployment

- ✅ **Green checkmark** = Success! Your app is live
- ❌ **Red X** = Something went wrong - ask the AI to help fix it

---

## 💡 Tips for Success

### Be Specific with AI
```
❌ "Make it look nice"
✅ "Use a dark theme with blue accent colors and rounded buttons"
```

### Start Simple, Then Add
```
❌ "Build a complete project management system with AI"
✅ "Start with a page to add and view projects"
   (then add features one at a time)
```

### Ask Questions!
```
"What does this code do?"
"Why did you choose this approach?"
"Can you explain how this works?"
```

---

## 🔐 Using API Keys (Like OpenAI)

### For Local Testing

Tell the AI: **"I need to set up my API keys for local testing"**

It will create a private file for your keys. This file stays on your machine and is never uploaded to GitHub.

### For Production (Live Site)

Add secrets to GitHub (the AI will guide you):

1. Go to your **GitHub repository** (the website)
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add your key with `APP_` prefix:
   - Name: `APP_OPENAI_KEY`
   - Value: *your actual API key*
5. Deploy again

| GitHub Secret | Use in Code |
|---------------|-------------|
| `APP_OPENAI_KEY` | `process.env.OPENAI_KEY` |
| `APP_API_KEY` | `process.env.API_KEY` |
| `APP_SECRET_1` | `process.env.SECRET_1` |

---

## 🆘 Need Help?

### "My app isn't working"
Tell the AI: *"Something's broken, can you check my code?"*

### "The deployment failed"
Check the **Actions** tab in GitHub - the AI can help interpret errors.

### "I want to change something"
Just tell the AI what you want to change!

### "I'm stuck"
Ask the AI: *"I'm stuck, can you help me figure out what to do next?"*

---

## 🎯 What to Say to the AI

| What you want | Say this |
|---------------|----------|
| Test your app | "Can you start the app so I can see it?" |
| Stop testing | "Stop the app" or press `Ctrl + C` |
| Deploy live | "I'm happy with it, let's deploy!" |
| Make changes | "Change the button color to blue" |
| Fix something | "Something's not working, can you check?" |
| Undo changes | "Can we go back to the previous version?" |

---

## 🏆 You've Got This!

Remember:
- **There are no stupid questions** - ask the AI anything
- **Mistakes are okay** - we can always undo and try again
- **Have fun** - you're building something real!

**Now go talk to your AI assistant and start building!** 🚀
