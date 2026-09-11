---
description: "Add a vector database for embeddings, semantic search, or RAG: pgvector"
triggers: ["vector search", "embeddings", "semantic search", "RAG", "add Chroma", "add Qdrant", "pgvector", "similarity search"]
globs: ["vectordb/**"]
---

# Vector Database Rules

Core rules (`/data` persistence, protected files) are in `.platform-rules/01-common.md` — this file adds vector-DB depth only.

`vectordb/` is a **second, fully independent service** — it is not the relational `database/`. Relational data stays in `database/`; embeddings live here. Either folder can exist without the other.

## Choosing a Setup

| Scenario | Use |
|----------|-----|
| Only vectors, no relational DB | `vectordb/` alone (no `database/`) |
| SQL + separate vector service | `database/Dockerfile.postgres` + `vectordb/Dockerfile.pgvector` |

`Dockerfile.pgvector`: SQL-based vectors; `CREATE EXTENSION vector` auto-enabled; supports `vectordb/init/init.sql`.

Setup:
```bash
cp vectordb/Dockerfile.pgvector vectordb/Dockerfile
```
Then add a `vectordb` service to `docker-compose.yml` for local dev (see `.platform-rules/scope-integration.md`).

## Auto-Injected Env Vars (production, when vectordb/Dockerfile exists)

| Variable | Value |
|----------|-------|
| `VECTORDB_HOST` | Internal hostname of the vector DB service |
| `VECTORDB_PORT` | 5432 (pgvector) |
| `VECTORDB_NAME` / `VECTORDB_USER` / `VECTORDB_PASSWORD` | Auto-injected credentials |

## Persistence

EFS is mounted at `/data`; the templates are pre-configured to use it:

| Template | Data directory |
|----------|----------------|
| pgvector | `/data/postgres` |

Init scripts (pgvector's `vectordb/init/init.sql`) run on FIRST deploy only — same rules as `.platform-rules/scope-database.md` (schema only, `IF NOT EXISTS`, later changes via backend migrations).

## Generating Embeddings

Use the Bayer LLM clients — `snippets/llm/bayer-llm-client.ts` / `.py` (and `snippets/llm/mga-assistant-client.*` for assistants). API key via the `OPENAI_KEY` secret per the core rules.
