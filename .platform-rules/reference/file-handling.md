---
description: "Build file upload/import features in the app, or receive files from the user for the AI to analyze"
triggers: ["upload", "import file", "CSV", "PDF", "save files", "share a file with you", "analyze this file"]
globs: []
---

# File Handling

## Two Different Scenarios — pick the right one first

| Scenario | What It Means | Section |
|----------|---------------|---------|
| **App uploads** | The user's APP handles file uploads (feature) | § App File Uploads |
| **AI file input** | The user gives YOU a file to read/analyze | § Files for the AI |

---

# App File Uploads

## Default: process in memory — don't store

Most operations (CSV import, PDF parsing, image conversion, report generation) need no persistence. Process the buffer, return the result, let it be garbage collected. Simpler, more secure, no cleanup logic.

| App Description | Approach |
|-----------------|----------|
| "Import CSV and show results" / "Parse PDF" / "Convert image" / "Analyze uploaded data" / "Generate report from file" | Memory (default) |
| "Document management" / "File gallery/sharing" / "Upload files, access later" / "Team file portal" | EFS `/data/uploads` |

Ask the user: "Do you need to keep the files for later, or just process them?" — default to memory.

⚠️ Memory is TIGHT in production: frontend + backend share one 1 GB RAM task. Keep the
upload size limit (snippets default 10 MB) and stream/iterate large files (csv-parser row
by row, not `.toString()` on a huge buffer) — an OOM kill restarts the container.

## Implementation: COPY the snippets

| Need | Snippet |
|------|---------|
| Upload handler (memory storage), JS | `snippets/file-handling/upload-handler.ts` |
| Upload handler (FastAPI UploadFile) | `snippets/file-handling/upload-handler.py` |
| Extract text from PDF/DOCX/XLSX/PPTX/CSV, JS | `snippets/file-handling/document-text-extractor.ts` |
| Same, Python (pypdf, python-docx, openpyxl) | `snippets/file-handling/document-text-extractor.py` |

Remember routing: frontend calls `fetch('/api/upload')`, backend route is `/upload` (no `/api` prefix — see `01-common.md`).

## Persistent storage (only when truly needed)

EFS is mounted at `/data` in production. Use `const UPLOAD_DIR = '/data/uploads'` (create with `mkdirSync(..., {recursive:true})`), `multer.diskStorage`, and a `/files/:filename` download route. ⛔ `./uploads` is lost on every restart — container filesystems are ephemeral.

Local dev equivalent — mount a volume in docker-compose:

```yaml
backend:
  volumes:
    - ./local-data:/data
```

## ⏱️ Timeouts for large uploads / slow processing

The ALB has a **5-minute idle timeout**. For 30MB+ uploads or endpoints that process before responding (document extraction, LLM calls), configure EVERY layer — any layer that times out first yields 502/504:

```
ALB (300s) → Traefik (no limit) → nginx (proxy_read_timeout) → backend (server timeout)
```

- **nginx** (`nginx.local.conf` `/api` block): `proxy_read_timeout 300s; proxy_send_timeout 300s; client_max_body_size 50m;`
- **Express**: `app.use(express.json({ limit: '50mb' }))`, same for urlencoded; `server.setTimeout(300000);`
- **FastAPI**: run uvicorn with `--timeout-keep-alive 300`

---

# Files for the AI (`context/` folder)

When the user wants YOU to read a requirements doc, example data, design mockup, etc.

- **`context/` is gitignored** — safe for sensitive reference files, never committed.
- Upload: right-click `context/` in the Explorer → "Upload..." (drag-and-drop not supported). Small text can be pasted in chat. Create the folder with `mkdir -p context` if missing.
- Text formats read directly; Excel/PDF/images depend on editor capabilities — for complex binary analysis, use an inline extraction script (below).
- ⛔ NEVER copy real data from `context/` into tracked files — see `reference/sensitive-files.md`.

## ⛔ MANDATORY size check BEFORE reading any context/ file

Reading a large file blind crashes with a 400 error. Not optional:

```bash
wc -c context/file.ext | awk '{print $1}'   # > 1000000 (1MB)? Don't read whole
wc -l context/file.ext | awk '{print $1}'   # > 3000 lines? Don't read whole
```

Under both limits → read directly. Over either → chunk:

1. `head -50 context/file.csv` to learn the structure
2. `mkdir -p context/chunks && split -l 500 context/file.csv context/chunks/chunk_` — dispatch a subagent per chunk to extract columns/patterns, combine results, then `rm -rf context/chunks`
3. Very large (>50MB) or binary (Excel/PDF): inline `python3 -c` script that prints JSON structure + sample rows only (openpyxl `read_only=True` for Excel, pypdf first 5 pages for PDF) — no app feature needed, the goal is understanding the data

| File Type | Strategy |
|-----------|----------|
| CSV | `head -50` → `split -l 500` → subagents |
| JSON | inline python: schema + sample entries |
| Excel | inline python + openpyxl: sheets, headers, sample rows |
| PDF | inline python + pypdf: page count + first 5 pages |
| SQL dump | `head -100` for schema, `grep -c INSERT` for row count |
| Logs | `tail -200` + `wc -l` |

## Security do/don'ts for context/

- ✅ OK: example data, requirements docs, mockups, reference code, sample configs
- ⛔ Don't: API keys/credentials, `.env` files, production exports with real PII, private keys/certs. Gitignored ≠ risk-free — conversations may be logged.
