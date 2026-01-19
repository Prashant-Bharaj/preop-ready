# 🔄 Background Commands & Hot Reload

## Running Long-Running Commands in Background

**For commands that run indefinitely (servers, watchers), run them in the background so the user can continue working.**

### Docker Commands (Background)

```bash
# Start containers in background (detached mode)
docker-compose up -d --build

# User can continue prompting while containers run!
```

**Tell the user:**
```
🐳 Starting your app in the background...

It's running! You can continue working while it runs.

To see the app: http://localhost:8080
To see logs: docker-compose logs -f
To stop it: docker-compose down
```

### NPM Dev Server (Background)

```bash
# Run in background with nohup
cd frontend && nohup npm run dev > /dev/null 2>&1 &

# Or use & to background
cd frontend && npm run dev &
```

### Check If Already Running

Before starting, check if containers are already running:

```bash
# Check if containers are running
docker-compose ps

# If already running, don't start again
```

---

## ⚡ Hot Reload Setup

### For Development Efficiency

When user is actively developing, set up hot reload so changes appear instantly.

### Frontend (Vite/React) - Already Built-in

Vite has hot reload by default. Just ensure:
- `npm run dev` is running
- User edits files in `frontend/src/`
- Browser updates automatically

### Backend (Node.js) - Add Nodemon

For backend hot reload, recommend nodemon:

```json
// package.json
{
  "scripts": {
    "dev": "nodemon server.js",
    "start": "node server.js"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
```

### Docker Compose with Volume Mounts

For hot reload with Docker:

```yaml
# docker-compose.yml
services:
  frontend:
    build: ./frontend
    volumes:
      - ./frontend:/app          # Mount source for hot reload
      - /app/node_modules        # Don't override node_modules
    ports:
      - "8080:80"

  backend:
    build: ./backend
    volumes:
      - ./backend:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    command: npm run dev         # Use dev script with nodemon
```

---

## 🎯 Command Execution Guidelines

### Run in Background When:
- ✅ `docker-compose up` - server needs to keep running
- ✅ `npm run dev` - dev server needs to keep running
- ✅ `npm run watch` - file watchers
- ✅ Long-running builds

### Run in Foreground When:
- ✅ `npm install` - needs to complete before next step
- ✅ `git` commands - quick, need result
- ✅ `docker build` - need to see if it succeeds
- ✅ Running tests - need to see results
- ✅ Preflight check - need to see results

---

## 📋 Pre-flight Check

**Before first deployment, run the preflight check:**

```bash
./scripts/preflight-check.sh
```

This verifies:
- ✅ Folder structure (frontend/, backend/)
- ✅ Dockerfiles exist and are valid
- ✅ nginx.conf is correct (no events/http blocks)
- ✅ Health endpoints exist
- ✅ Docker is running

**When to suggest preflight check:**
- Before first deploy
- After major changes
- If deployment fails
- User asks "is my project ready?"

**How to communicate:**
```
Before we deploy, let me run a quick check to make sure everything is configured correctly...

[Run: ./scripts/preflight-check.sh]

[If passes]: ✅ All checks passed! Ready to deploy.
[If fails]: I found a few issues. Let me fix them...
```

---

## 💬 Communicating Background Processes

### When Starting Background Process

```
🚀 Starting your app in the background...

You can keep working while it runs! Here's what's happening:
- Frontend: http://localhost:8080
- Backend: http://localhost:3000

Commands you might need:
- See logs: docker-compose logs -f
- Stop: docker-compose down
- Restart: docker-compose restart
```

### When User Asks About Running Processes

```bash
# Check what's running
docker-compose ps
```

### Stopping Background Processes

```
To stop your running app:
docker-compose down

Or if you want to stop and remove everything:
docker-compose down -v
```
