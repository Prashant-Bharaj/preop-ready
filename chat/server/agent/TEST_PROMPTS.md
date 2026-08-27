# Test prompts for the custom agent spike

Each prompt targets a different scope / rule path so we can verify rule selectivity (the model fetches only what applies). Record the token numbers + tool calls per run.

## Prerequisites for every test

1. `CODER_ASSISTANT_ID` is configured (or `coderAssistantId` in `.chat/secrets.json`)
2. Trimmed `system-prompt-source.md` is uploaded to MGA (re-paste whenever the file changes)
3. Start from a clean workspace for each test (Start Fresh) OR explicitly use a project with existing code for the continuation tests

The custom agent is the only dispatch path — the legacy `USE_CUSTOM_AGENT=1` gate was retired in D.2; see [`docs/retired/RETIRED_CLINE_INTEGRATION.md`](../../../docs/retired/RETIRED_CLINE_INTEGRATION.md).

## Recording template (copy into a notepad per run)

```
Prompt: <one-liner>
Scope picked by router: <backend/frontend/database/...>
Agent LLM calls (count `LLM response` lines): N
Tool calls — breakdown:
  get_rules(<names>): [...]
  get_snippet(<paths>): [...]
  write_to_file: N
  replace_in_file: N
  execute_command: N
Duration (Confirm: plan executed ...ms): Ns
Token usage (prompt / completion / total): P / C / T
UI rendering: clean / had XML leaks (which)
Outcome: exit=0 / exit=1, files correct: Y/N
```

## Test 1 — Baseline (re-run of original)

```
Add a minimal Node + Express backend with a single GET /health endpoint that returns {ok: true}. Use the platform snippets where possible.
```

- **Expected scope**: `backend`
- **Expected MCP fetches**: `get_rules("backend")`, `list_snippets`, `get_snippet("backend/express-server-template.ts")`, `get_snippet("security/sanitize-middleware.ts")`
- **Expected file writes**: `backend/src/index.js`, `backend/package.json`, `backend/Dockerfile` (copy from template)
- **Success**: `/health` endpoint exists in `backend/src/index.js`, Dockerfile uses non-root user
- **Cline baseline we're beating**: 137.6s, 427.8K prompt tokens, 14 API calls

## Test 2 — Small edit to existing backend (tests replace_in_file + conversation continuity)

_Run AFTER Test 1 succeeded — same chat session, don't clear._

```
Add a GET /version endpoint to the existing backend that returns {"version": "1.0.0"}. Don't touch anything else.
```

- **Expected scope**: `backend`
- **Expected MCP fetches**: maybe `get_rules("backend")` again (new MGA conversation inside the same chat session, depending on how session continuity works) — or nothing if the model trusts its context
- **Expected tool calls**: `read_file(backend/src/index.js)`, `replace_in_file(backend/src/index.js)` — target tool
- **Expected NO writes to**: package.json, Dockerfile
- **Success**: `/version` endpoint exists; `/health` still works; no new dependencies; no Dockerfile change

## Test 3 — User-identity feature (should pull reference/user-identity.md)

_Start Fresh before running._

```
Add a backend with a GET /api/whoami endpoint that reads the current user's email from the X-User-Email header and returns {email: "..."}. Handle the case where the header is missing.
```

- **Expected scope**: `backend`
- **Expected MCP fetches**: `get_rules("backend")`, `get_rules("user-identity")`, `list_snippets`, `get_snippet("auth/user-identity.ts")`
- **Key check**: did the model call `get_rules("user-identity")`? That's the selectivity test. If yes → selectivity works. If no → we need to make the use case clearer in the assistant prompt.
- **Success**: endpoint reads `X-User-Email`, returns 400 or similar on missing, implementation report mentions the header

## Test 4 — Frontend scope (different rules path)

_Start Fresh before running._

```
Create a minimal React + Vite frontend with a single page that fetches GET /api/health from the backend and displays the result. Use the platform snippets.
```

- **Expected scope**: `frontend`
- **Expected MCP fetches**: `get_rules("frontend")`, `get_snippet("frontend/AppScaffold.jsx")`, `get_snippet("frontend/vite-react-config.js")`, maybe `get_snippet("frontend/dockerfile-react.conf")`
- **Expected file writes**: `frontend/package.json`, `frontend/vite.config.js`, `frontend/index.html`, `frontend/src/App.jsx`, `frontend/Dockerfile`, `frontend/nginx.conf`, `frontend/nginx.local.conf`
- **Success**: frontend builds, nginx config has security headers and proxies /api to backend in local mode

## Test 5 — Intentionally narrow task (should fetch few rules)

_Start Fresh before running._

```
Create a file at docs/ARCHITECTURE.md that describes the hypothetical architecture of a simple note-taking app. Don't create any code.
```

- **Expected scope**: fuzzy — router might route to `backend` or ask for clarification
- **Expected MCP fetches**: ideally zero or minimal (pure documentation task)
- **Key check**: does the agent avoid fetching backend rules / snippets when they don't apply?
- **Success**: file exists, no code was written, implementation report lists only the md file

## User-style prompts (real-world, multi-scope)

These mirror what end users actually type — longer, outcome-focused prose rather than narrow technical specs. They pressure-test three things that Tests 1-5 don't:

- Router scope decomposition on messy prose (does it correctly split into frontend/backend/database/vectordb/integration, not misclassify as docs-only?)
- Parallel-phase correctness across 3+ scopes
- Post-completion verification — the path only fires when `tasks.length > 1`, so all Tests 1-5 skip it. These prompts run it every time.

Success criteria here are demo-level ("running app does what the prompt describes"), not exact file-match. Expected scope decomposition is a prediction — log what the router actually picks.

### Test 6 — Smart project document knowledge system

_Start Fresh before running._

```
Project teams generate huge volumes of documents, but finding the right file and keeping storage organized is painfully manual across large teams. This idea turns static project documentation into a smart, living knowledge system that bridges file-based storage with fast, AI-powered retrieval. A lightweight prototype that ingests a project folder (SharePoint/OneDrive/local), auto-classifies and tags documents, and exposes a chat/search UI that can answer project questions with source citations. Should demonstrate semantic search over mixed file types (docx, pptx, pdf) and surface a basic structured view of the folder.
```

- **Expected router decomposition**: frontend (chat/search UI + folder view) + backend (ingest + retrieval API) + vectordb (semantic index over docx/pptx/pdf) + integration + docs
- **Expected verification signals**:
  - CHECK 1: Dockerfiles for frontend, backend, vectordb
  - CHECK 2: frontend `/api/search` or `/api/ask` calls match backend routes + response shapes (citations array)
  - CHECK 3: n/a unless router adds a relational DB
  - CHECK 4: `docker-compose build` exit 0
- **Success**: `docker-compose up` yields a UI at :8080 that submits a query and displays an answer with source citations. Document parsing can be stubbed for demo.
- **Watch for**: router wrongly collapsing to `docs` scope — this prompt leads with narrative prose before the technical ask. If it docs-classifies, the docs-only reclassifier (router.js) has a false positive.

### Test 7 — QualCoder (qualitative research, human-in-the-loop)

_Start Fresh before running._

```
Manually coding hundreds or thousands of open-ended survey responses, interview transcripts, and free-text feedback is one of the most time-consuming tasks in consumer research. QualCoder is a human-in-the-loop AI agent that codes every verbatim for themes, sentiment, emotion, and mental models - compressing days of analysis into hours while preserving nuance and auditability.
A multi-step agent workflow: (1) ingest verbatims + study objectives, (2) auto-code themes/sentiment/emotion, (3) flag ambiguous comments for human review, (4) cluster validated codes into themes with co-occurrence + contradiction checks, (5) generate narrative insights with traceability back to source quotes. Demo on a sample dataset.
```

- **Expected router decomposition**: frontend (review queue + insights display) + backend (5-step pipeline, LLM calls) + database (verbatims, codes, themes, review_flags) + vectordb (clustering / semantic dedup) + integration + docs
- **Expected verification signals**:
  - CHECK 1: Dockerfiles for all services
  - CHECK 2: frontend POST /api/verbatims, GET /api/themes/:id/codes, POST /api/review, etc. match backend
  - CHECK 3: **primary check for this prompt** — verbatims / codes / themes tables must match backend queries. Five-step pipeline = lots of table touches, high chance of drift
  - CHECK 4: `docker-compose build` exit 0
- **Success**: UI uploads a sample dataset, triggers auto-coding, shows the ambiguous-comment review queue, renders clustered themes with source-quote citations.

### Test 8 — Farmer field-problem photo → Bayer product recommendation

_Start Fresh before running._

```
A farmer takes a photo of a field problem (weed, pest, disease, drought, birds) and the system identifies the issue, then recommends the matching Bayer seed or crop-protection product. The farmer can tap through to the e-commerce platform and buy it. End-to-end flow: helps farmers solve problems and helps Bayer sell its portfolio.
A mobile-style web prototype: upload/capture a field photo, run image classification (open-source model or hosted vision API), map the identified issue to a product catalog entry, and deep-link to a mocked e-commerce product page. Demo with 3-5 sample field issues.
```

- **Expected router decomposition**: frontend (mobile-style upload + product card) + backend (classification endpoint + product lookup) + database (products table seeded with 3-5 entries, issue→product mapping) + integration + docs
- **Expected verification signals**:
  - CHECK 1: Dockerfiles present
  - CHECK 2: frontend POST /api/classify + GET /api/products/:id match backend routes and response shapes (must include the deep-link URL)
  - CHECK 3: products table columns match backend query (id, name, sku, issue_category, external_url at minimum)
  - CHECK 4: `docker-compose build` exit 0
- **Success**: UI where uploading a sample photo returns a mocked classification result + product card with a clickable external URL. Classification can be keyword-matched on filename or a stub for demo.

### More prompts forthcoming

Placeholder — additional real-world prompts to be appended here.

## Comparison matrix (fill in after runs)

| Test | Cline prompt tokens | Agent prompt tokens | Savings % | Cline duration | Agent duration | Notes |
|---|---|---|---|---|---|---|
| 1 | 427,800 | ? | ? | 137.6s | ? | baseline |
| 2 | - | ? | - | - | ? | incremental edit |
| 3 | - | ? | - | - | ? | rule-selectivity test |
| 4 | - | ? | - | - | ? | frontend scope |
| 5 | - | ? | - | - | ? | minimal rules |

## What a successful spike looks like (exit criteria)

- **Test 1**: ≥ 40% reduction in prompt tokens vs Cline, same end state
- **Test 2**: No new writes to unrelated files, only `replace_in_file` or targeted edits
- **Test 3**: `get_rules("user-identity")` appears in the tool log
- **Test 4**: Produces a valid React + Vite scaffold with nginx configs
- **Test 5**: Agent doesn't over-fetch rules for a trivial task
- Across all: clean UI rendering (no `<tool_name>` fragments visible to user), token usage logged per turn, no crashes

## If something fails

- Paste the last 30 lines of terminal output (from `[session] Single-scope execution` onward)
- Screenshot the UI if rendering looks wrong
- Note whether the file actually got written on disk
