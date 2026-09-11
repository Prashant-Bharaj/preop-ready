# snippets/

Code templates fetched on-demand by the AI agent via the `platform-tools` MCP server (`get_snippet`, `list_snippets`, `search_snippets`).

## Layout

| Subdir | Purpose |
|---|---|
| `backend/` | Backend templates (Express, FastAPI, MySQL/Postgres connections, routes, etc.) |
| `database/` | Schema, migrations, init.sql patterns |
| `frontend/` | React scaffolds + UI components (PascalCase) |
| `config/` | Per-language config templates (`AppSettings.jsx`, `app-settings.js`, `app-settings.py`) |
| `integration/` | Docker-compose templates (full-stack, mysql, vectordb, frontend-only) |
| `auth/`, `email/`, `llm/`, `notifications/`, `security/`, `storage/`, `ui/` | Feature-specific templates |

## Naming conventions

Filename style follows the **target language**, not the snippet's role:

| Extension | Convention | Example |
|---|---|---|
| `.jsx` (React components) | `PascalCase` | `AdminPage.jsx`, `AppScaffold.jsx` |
| `.js` (Node.js modules) | `kebab-case` | `express-server-template.js`, `mga-assistant-client.js` |
| `.py` (Python modules) | `kebab-case` | `fastapi-server-template.py`, `pdf-extract.py` |
| `.sql` (SQL files) | `kebab-case` | `app-settings-schema.sql`, `migration-runner.sql` |
| `.yml` / `.toml` / `.conf` | `kebab-case` | `docker-compose-fullstack.yml`, `nginx-production.conf` |

The same semantic feature can have **different filenames per language** — e.g., `config/AppSettings.jsx` (React) coexists with `config/app-settings.js` (Node) and `config/app-settings.py` (Python). This matches the dominant convention of each ecosystem.

## INDEX.md

[INDEX.md](INDEX.md) is the canonical manifest of available snippets. Update it when adding new templates.

## How the AI agent discovers snippets

The `platform-tools` MCP server (`chat/server/mcp-server.js`) exposes:
- `list_snippets()` — catalog
- `get_snippet(path)` — fetch one
- `search_snippets(query)` — keyword search
- `resolve_context({flags, scope})` — return all snippets matching feature flags + scope

The AI never reads `snippets/` directly via the filesystem; it always goes through MCP.
