---
description: "Diagnose and fix a broken, erroring, or non-loading app for the user"
triggers: ["broken", "error", "404", "500", "blank page", "not loading", "undo", "doesn't work", "stuck"]
globs: []
---

# Troubleshooting

Never make the user feel bad — "I see the issue, let me add the missing piece", never "you forgot X".
Don't explain what they should do — fix it yourself, then explain what you fixed.

## Symptom → Action

| Symptom | Action |
|---------|--------|
| Site isn't loading | Check in order: on Bayer VPN? deployment finished (Actions)? app error (logs)? Then fix it |
| Made changes, nothing updated (deployed) | Changes must be pushed: preflight → add specific files → commit → push → wait 3–5 min |
| Made changes, nothing updated (local) | Stale Docker layer cache — `docker-compose build --no-cache && docker-compose up -d` |
| Deployment stuck | Normal up to ~10 min; beyond that read the Actions log, identify, fix |
| "Weird error" | Ask them to paste the text or say where it appeared (terminal/browser/GitHub), then diagnose |
| Wants to undo | Ask how far back: last change, last working state, or start fresh — then do it via git |
| Works locally, not deployed | Usual suspects: missing `/health` or wrong port, env vars not set, local-vs-prod path/URL differences — check each |
| Blank/broken page | Check browser console, `docker-compose ps`, container logs |
| Deploy failure messages | Use the failures table in `.platform-rules/reference/deployment.md` |
| CORS errors | Add CORS middleware / proxy — use `snippets/config/cors-proxy.js` |

## Technical Reference

**Deployment status:** GitHub repo → Actions tab → latest workflow; or `gh run list --workflow=deploy.yml --limit=5`.

**Logs:** GitHub Actions workflow output; `docker-compose logs -f` locally; AWS CloudWatch if you have access.

**Health checks:** must respond at `/health` with 200; backend on port 3000 (details in the always-on core).

**Common Dockerfile issues:**
- Missing `EXPOSE`, wrong port number, failing build steps
- Multiline config written with `echo` — `echo '...\n...'` does NOT interpret `\n` without `-e`, producing a corrupt config. Use `printf '...\n...'` in `RUN` instead

Full platform requirements: `.platform-rules/reference/deployment.md` and the always-on core rules.
