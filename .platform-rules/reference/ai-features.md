---
description: "Add AI to the app: chat with a model, assistants, summarize, embeddings/semantic search, RAG, chat with documents, knowledge base, model selection — always via the internal myGenAssist API"
triggers: ["add AI", "chatbot", "LLM", "GPT", "call a model", "summarize with AI", "assistant", "embeddings", "semantic search", "RAG", "chat with my documents", "knowledge base", "analyze documents with AI", "which models"]
globs: []
---

# AI Features (internal LLM platform — myGenAssist)

⛔ **ALL AI capability goes through Bayer's internal myGenAssist (MGA) API.** Never call
public LLM endpoints (`api.openai.com`, Azure OpenAI, Anthropic, Gemini, ...) from an app —
public endpoints are unreachable/unapproved, and app data must stay inside Bayer. The MGA
API is OpenAI-compatible, so OpenAI SDKs work by pointing `baseURL` at MGA.

## Setup (same for every capability)

| What | Where |
|------|-------|
| Endpoint URL | `SECRET_1` (GitHub secret `APP_SECRET_1`); local: `LLM_ENDPOINT` in `.env` |
| API key (Bearer) | `API_KEY` (GitHub secret `APP_API_KEY`); local: `LLM_API_KEY` |
| Model / assistant ID | `SECRET_2` (GitHub secret `APP_SECRET_2`) |

Users get their MGA API key from the myGenAssist UI. Local dev without a key must degrade
to a mock response, never crash — the snippets do this already.

## Capability → implementation map

| User wants | Use | Implementation |
|------------|-----|----------------|
| "Ask a model", summarize, generate, classify, rewrite | `POST /chat/completions` (v3 also offers `POST /responses`) | COPY `snippets/llm/bayer-llm-client.{js,py}` |
| A persona/assistant with instructions (and optional knowledge files) | MGA assistant + `POST /chat/completions` with the assistant as model | COPY `snippets/llm/mga-assistant-client.{js,py}`; assistants are typically created in the MGA UI — the app CALLS them |
| Pick/switch models | `GET /models` lists what's available | `listModels()` in `snippets/llm/rag-tools.{js,py}`; offer the list in app settings (`snippets/config/app-settings.*`) rather than hardcoding; default model in `SECRET_2` |
| QA over documents / "chat with my documents" | **v3 Knowledge Base — the managed RAG path (preferred)** | COPY `snippets/llm/knowledge-base-client.{js,py}` (create KB → upload → attach → retrieve; `POST /knowledge/onedrive` can sync OneDrive/SharePoint files in). Feed retrieved chunks + question to `/chat/completions`. No custom pipeline, no own vector DB needed. `POST /doc_qa` is the LEGACY v2 path — avoid in new apps. ⛔ Retrieval returns from the WHOLE knowledge base: if users upload private documents, create ONE KB PER USER (store the kb_id per user in the app DB) — a shared KB leaks documents across users |
| Semantic search over the app's OWN data (DB rows, user content) | `POST /embeddings` (+ `POST /rerank` to improve top-k) | COPY `snippets/llm/rag-tools.{js,py}` — embed with MGA, store vectors in the app's own vector DB (`.platform-rules/scope-vectordb.md`), rerank candidates before handing them to the model. Rule of thumb: documents → Knowledge Base; app data rows → embeddings + own vectordb |
| Extract text from uploaded documents for AI | `POST /parsing/parse` (sync, small files) or `/parsing/submit` + `/parsing/status/{id}` + `/parsing/collect/{id}` (async, large) | Alternative to local extraction (`snippets/file-handling/document-text-extractor.*`) when quality matters (PDF layout, tables) |
| Split long text for embedding | `POST /chunking/chunk` | `chunkText()` in `snippets/llm/rag-tools.{js,py}` — use before `/embeddings` instead of writing a custom splitter |
| Persist chat history server-side | v3 `/conversations` (create/search/get) | Optional — storing history in the app's own database is equally fine; don't use both |
| Bulk/offline processing of many prompts | `POST /batches` (+ `GET /batches/{id}`) | For imports/nightly jobs — never loop chat completions for hundreds of items in one request cycle |

## Endpoints apps must NOT touch

Platform/admin surface — never call these from a user app: `POST/DELETE/PATCH /model`
(model registry admin), `/countries`, `/tools*` (MCP tool administration), `/evaluation`
and `/judge` (platform evaluation), `/tags` admin, `/reader` (deprecated), and the v3
`/artifacts*` endpoints (MGA's own GenUI artifact system, not an app surface). Assistant
management endpoints (`/assistants*`) are for tooling built around MGA itself — hackathon
apps manage assistants in the MGA UI and only call them.

## Mechanics that bite

- **Timeouts:** completions can be slow; the ALB kills idle connections at 5 min. Set
  client timeouts (~120s), show a loading state, and stream (`stream: true`) for long
  answers so the connection stays active. For anything longer, use `/batches` or the
  async parsing flow.
- **Resources:** the app task has 1 GB RAM total — never run local models, local
  embedding libraries, or in-process vector math over big corpora. MGA does the heavy
  lifting; the app orchestrates.
- **Bound the tokens:** always set `max_tokens`; unbounded generation in a loop is a
  cost and latency bug.
- **Errors:** MGA errors must not leak to the client raw — map to the standard JSON
  error shape (`snippets/security/error-handler.*`), log details server-side only.

## Data rules for prompts

Prompts are data. The platform's data policy applies unchanged: dummy/synthetic data
only in code and fixtures; real data may flow through the app at runtime (user input →
MGA is fine — MGA is internal), but never hardcode real names/records into prompt
templates, and never log full prompts or completions (see `.platform-rules/02-security.md`).
