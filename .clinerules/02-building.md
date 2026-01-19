# 🔨 Step 2: Building the App

## Always Start with Something Visual

Users get excited when they SEE something. Build the frontend first!

```
Let me create the first version of your app - give me a moment...

[create the files]

Done! ✨ I've created your app with:
- A clean, modern homepage
- [specific feature they asked for]
- Mobile-friendly design

Would you like me to start it so you can see it? 
```

**If user says yes, RUN THE COMMAND FOR THEM:**
```bash
docker-compose up --build
```

Then tell them:
```
🚀 Starting your app... (this takes about 30 seconds the first time)

When you see "ready" messages, open this link:
👉 http://localhost:8080

Let me know when you've seen it, or if anything looks wrong!
```

## Project Structure (For Your Reference)

```
frontend/              ← Website (what users see)
├── index.html         ← Main page
├── style.css          ← Colors and styling
├── script.js          ← Interactive features (optional)
├── Dockerfile         ← Copy from Dockerfile.vanilla or .react
├── Dockerfile.vanilla ← Template for static HTML sites
└── Dockerfile.react   ← Template for React apps

backend/               ← Server (saves data, APIs)
├── server.js          ← Main server code (Node.js)
├── Dockerfile         ← Copy from Dockerfile.node or .python
├── Dockerfile.node    ← Template for Node.js
└── Dockerfile.python  ← Template for Python

database/              ← Data storage (optional)
├── Dockerfile         ← Copy from one of the templates below
├── Dockerfile.postgres  ← PostgreSQL (recommended)
├── Dockerfile.mysql     ← MySQL
├── Dockerfile.pgvector  ← PostgreSQL + vector search (AI apps)
├── Dockerfile.chroma    ← ChromaDB vector database
├── Dockerfile.qdrant    ← Qdrant vector database
└── init/init.sql        ← Database initialization scripts
```

## Building Frontend

### For Simple Sites (Vanilla HTML)
Create these files:
- `frontend/index.html` - the webpage
- `frontend/style.css` - make it pretty
- Copy `Dockerfile.vanilla` → `frontend/Dockerfile`

### For Interactive Apps (React)
Create these files:
- `frontend/package.json` with React + Vite
- `frontend/src/App.jsx` - main component
- Copy `Dockerfile.react` → `frontend/Dockerfile`

## Building Backend (Only If Needed)

Only add a backend if they need:
- Save/load data
- User accounts
- External API calls (like OpenAI)
- Server-side logic

### Node.js Backend
- Create `backend/server.js`
- Copy `Dockerfile.node` → `backend/Dockerfile`

### CRITICAL: Health Endpoint
**ALWAYS include this** - deployment will fail without it:

```javascript
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});
```

## Design Principles

Make it look good! Users judge apps by appearance:

- **Clean layout** - lots of white space
- **Modern colors** - subtle gradients, not harsh primaries
- **Rounded corners** - `border-radius: 8px` on buttons/cards
- **Good fonts** - Use system fonts or Google Fonts
- **Mobile friendly** - Test narrow widths
- **Feedback** - Loading spinners, success/error messages

## After Creating Files

Always tell them what you made:

```
✅ Your app is ready! Here's what I created:

📁 frontend/
   - index.html (your main page with the voting form)
   - style.css (modern dark theme with your brand colors)

📁 backend/
   - server.js (saves votes and shows results)

Want to test it locally, or should we deploy it right away?
```

---

# ➕ Adding Components to Existing Projects

## When Users Want to Extend Their App

Users often start simple and want to add features later. Here's how to handle common requests:

### Adding a Backend to Frontend-Only App

**User says:** "I want to save data" / "Add a database" / "Connect to OpenAI"

```
Great idea! Right now your app is frontend-only (just the website).
To save data or use APIs, we need to add a backend server.

I'll create:
- A backend folder with your server code
- Connect your frontend to talk to it

Want me to set that up?
```

**Then create:**
1. `backend/` folder
2. `backend/server.js` (or `app.py` for Python)
3. `backend/package.json` (or `requirements.txt`)
4. Copy `Dockerfile.node` → `backend/Dockerfile`
5. Add health endpoint
6. Update `docker-compose.yml` to include backend service
7. Update frontend to call `/api/*` endpoints

### Adding a Database

**User says:** "I need a database" / "Save user data permanently"

```
To store data permanently, we'll add a database. 

I'll set up:
- A database container with persistent storage
- Initial tables for your data
- Backend code to read/write from it

Your data will persist even when the app restarts!
```

**Then create:**
1. Copy the appropriate Dockerfile template to `database/Dockerfile`
2. Create `database/init/init.sql` with table definitions (for SQL databases)
3. Update `backend/server.js` to connect to database
4. Update `docker-compose.yml` with database service
5. Add database environment variables

**Database choice guide:**

| Use Case | Template | Notes |
|----------|----------|-------|
| Most web apps | `Dockerfile.postgres` | Recommended default |
| Familiar with MySQL | `Dockerfile.mysql` | Traditional choice |
| AI app with embeddings | `Dockerfile.pgvector` | PostgreSQL + vector search |
| Simple vector search | `Dockerfile.chroma` | Easy to use, Python-native |
| High-performance vectors | `Dockerfile.qdrant` | Production-grade vector DB |

**Setup steps:**
```bash
# Pick one:
cp database/Dockerfile.postgres database/Dockerfile    # SQL database
cp database/Dockerfile.chroma database/Dockerfile      # Vector database for AI
```

### Adding OpenAI / AI Features

**User says:** "Add AI" / "Use ChatGPT" / "Make it smart"

```
Let's add AI to your app! I'll:
- Set up the OpenAI connection in your backend
- Create an endpoint your frontend can call
- You'll need to add your API key as a secret

Ready to add some AI magic? ✨
```

**Then:**
1. Add OpenAI package to backend
2. Create `/api/ai` endpoint (or similar)
3. Add proper error handling
4. Update frontend with AI interaction UI
5. Guide them to add `APP_OPENAI_KEY` secret

### Switching Frontend Framework

**User says:** "Can we use React instead?" / "I want a more interactive UI"

```
Sure! We can upgrade to React for a more interactive experience.

This will replace your current HTML with React components.
Your design and features will stay the same, just built differently.

Want me to convert it?
```

**Migration steps:**
1. Keep existing HTML/CSS as reference
2. Create new React structure in `frontend/`
3. Convert HTML → JSX components
4. Move styles to CSS modules or styled-components
5. Replace `Dockerfile.vanilla` with `Dockerfile.react`
6. Update nginx.conf for React SPA routing

### Adding Authentication (Advanced)

**User says:** "Add login" / "User accounts"

```
Adding user accounts is more complex, but doable!

For a hackathon, I'd recommend keeping it simple:
- Basic username/password stored in database
- Session-based login

For production apps, you'd want proper auth (OAuth, SSO), 
but for demo purposes, simple auth works great.

Want me to add basic login?
```

---

## 🔄 Component Addition Checklist

When adding any new component, always:

- [ ] Update `docker-compose.yml` with new service
- [ ] Ensure health endpoints exist for new services
- [ ] Update frontend API calls if backend changed
- [ ] Test locally before deploying
- [ ] Add any new secrets to GitHub if needed

## Communication When Adding Components

**Always reassure them:**
```
Don't worry - your existing features will keep working exactly the same.
We're just adding new capabilities on top of what you already have.
```

**After adding:**
```
✅ Done! I've added [component] to your app.

Here's what's new:
- [list new files/features]

Your existing [features] still work the same way.

Want to test the new features locally?
```
