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
frontend/           ← Website (what users see)
├── index.html      ← Main page
├── style.css       ← Colors and styling
├── script.js       ← Interactive features (optional)
└── Dockerfile      ← Don't modify unless necessary

backend/            ← Server (saves data, APIs)
├── server.js       ← Main server code (Node.js)
└── Dockerfile      ← Don't modify unless necessary

database/           ← Data storage (optional)
└── init/init.sql   ← Database setup
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
