"""
scopes: [backend, vectordb]
flags: [ai-rag]
description: Compute MGA embeddings for vector search / RAG (Python).
"""

"""
SNIPPET: MGA Embeddings (Python)
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI / async httpx)

DESCRIPTION:
    Calls MGA's /embeddings endpoint to convert text into vectors. See
    mga-embedding.js for full notes on models and dimensions.

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES:
    MGA_API_KEY, MGA_BASE_URL (written by harness)
    MGA_EMBEDDING_MODEL (optional; defaults to text-embedding-3-large)

USAGE:
    from mga_embedding import embed, embed_many

    vec = await embed("aspirin contraindications")
    # → list[float] of length 3072

    vecs = await embed_many(["query A", "query B"])

EXAMPLE (asyncpg + pgvector):
    import json
    docs = await fetch_all_documents()
    vecs = await embed_many([d.content for d in docs])
    for d, v in zip(docs, vecs):
        await pool.execute(
            "INSERT INTO doc_chunks(id, content, embedding) VALUES ($1, $2, $3)",
            d.id, d.content, json.dumps(v),
        )
"""

import os
import httpx

MGA_API_KEY = os.getenv("MGA_API_KEY")
MGA_BASE_URL = os.getenv("MGA_BASE_URL", "https://chat.int.bayer.com/api/v2")
MGA_EMBEDDING_MODEL = os.getenv("MGA_EMBEDDING_MODEL", "text-embedding-3-large")

if not MGA_API_KEY:
    raise RuntimeError("MGA not configured. Set MGA_API_KEY in env.")


async def embed(text: str, *, model: str | None = None, dimensions: int | None = None) -> list[float]:
    """Embed a single string."""
    vecs = await embed_many([text], model=model, dimensions=dimensions)
    return vecs[0]


async def embed_many(
    texts: list[str],
    *,
    model: str | None = None,
    dimensions: int | None = None,
) -> list[list[float]]:
    """Embed many strings in one call."""
    if not texts:
        return []
    body = {
        "model": model or MGA_EMBEDDING_MODEL,
        "input": texts,
        "encoding_format": "float",
    }
    if dimensions is not None:
        body["dimensions"] = dimensions

    headers = {
        "Authorization": f"Bearer {MGA_API_KEY}",
        "Content-Type": "application/json",
    }
    endpoint = MGA_BASE_URL.rstrip("/") + "/embeddings"

    async with httpx.AsyncClient(timeout=60.0) as client:
        res = await client.post(endpoint, json=body, headers=headers)
        if res.status_code >= 400:
            raise RuntimeError(f"MGA embeddings failed: HTTP {res.status_code} — {res.text[:300]}")
        data = res.json()
        return [item["embedding"] for item in data.get("data", [])]
