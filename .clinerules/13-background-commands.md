# 🔄 Background Commands & Hot Reload

## Running Long-Running Commands in Background

**For commands that run indefinitely (servers, watchers), run them in the background so the user can continue working.**

### Docker Commands (Background)

```bash
# Start containers in background (detached mode)
docker-compose up -d --build

# User can continue prompting while containers run!
```

**Show the correct URL based on environment — see `15-urls.md` for detection and URL formats.**

Then tell the user the app is running, show the URL, and remind them of useful commands:
- See logs: `docker-compose logs -f`
- Stop: `docker-compose down`

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
      - "8080:8080"

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

**Show the correct URLs based on environment — see `15-urls.md` for detection and URL formats.**

Tell them the app is running and provide useful commands:
- See logs: `docker-compose logs -f`
- Stop: `docker-compose down`
- Restart: `docker-compose restart`

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
