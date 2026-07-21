"""
SNIPPET: MGA RAG Tools (embeddings, rerank, chunking, model list)
CATEGORY: AI / LLM
LANGUAGE: Python (async httpx)
STATUS: Ready

DESCRIPTION:
    Building blocks for CUSTOM semantic search over the app's own data
    (DB rows, user content) — embed with MGA, store vectors in the app's
    vector DB (see .platform-rules/scope-vectordb.md), rerank candidates.
    For DOCUMENT collections prefer the managed path instead:
    snippets/llm/knowledge_base_client.py (no vector DB needed).
    Falls back to mock responses when credentials are not configured (local dev).

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
    APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL
    APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
    Optional: MGA_PROJECT        ->  project identifier header (mga-project)
    For local development: LLM_ENDPOINT, LLM_API_KEY in backend/.env

USAGE:
    from rag_tools import embed, rerank, chunk_text, list_models

    chunks = await chunk_text(long_text, chunk_size=500, chunk_overlap=50)
    vectors = await embed(chunks, model="text-embedding-model")
    # ... store vectors in pgvector/Chroma/Qdrant, query top-20 ...
    best = await rerank(question, candidate_texts, top_n=5)
"""

import os
from typing import Any, Dict, List, Optional

import httpx

ENDPOINT = os.environ.get('SECRET_1') or os.environ.get('LLM_ENDPOINT')
API_KEY = os.environ.get('API_KEY') or os.environ.get('LLM_API_KEY')
PROJECT = os.environ.get('MGA_PROJECT')
TIMEOUT = 60.0


def _configured() -> bool:
    return bool(ENDPOINT and API_KEY)


def _headers() -> Dict[str, str]:
    h = {'Authorization': f'Bearer {API_KEY}'}
    if PROJECT:
        h['mga-project'] = PROJECT
    return h


async def embed(texts: List[str], model: Optional[str] = None) -> List[List[float]]:
    """Create embeddings (OpenAI-compatible /embeddings). One vector per text."""
    if not _configured():
        print('[RAG] Not configured - returning mock embeddings')
        return [[0.0] * 8 for _ in texts]
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(
            f'{ENDPOINT}/embeddings',
            json={'model': model, 'input': texts},
            headers=_headers(),
        )
        res.raise_for_status()
        return [d['embedding'] for d in res.json()['data']]


async def rerank(
    query: str,
    documents: List[str],
    model: Optional[str] = None,
    top_n: Optional[int] = None,
    return_documents: bool = True,
) -> Dict[str, Any]:
    """Rerank candidate documents against a query (relevance scores + indices)."""
    if not _configured():
        print('[RAG] Not configured - returning mock reranking')
        return {'results': [
            {'index': i, 'relevance_score': 1 - i * 0.1} for i in range(len(documents))
        ]}
    body: Dict[str, Any] = {
        'model': model, 'query': query,
        'documents': documents, 'return_documents': return_documents,
    }
    if top_n:
        body['top_n'] = top_n
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(f'{ENDPOINT}/rerank', json=body, headers=_headers())
        res.raise_for_status()
        return res.json()


async def chunk_text(text: str, **settings) -> List[str]:
    """Split text into chunks server-side (use before embed())."""
    if not _configured():
        print('[RAG] Not configured - returning single mock chunk')
        return [text]
    merged = {
        'chunking_method': 'recursive_character',
        'chunk_size': 500,
        'chunk_overlap': 50,
        **settings,
    }
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(
            f'{ENDPOINT}/chunking/chunk',
            json={'text': text, 'settings': merged},
            headers=_headers(),
        )
        res.raise_for_status()
        data = res.json()
        # VERIFY: adjust if ChunkingOutput nests chunks differently
        return data.get('chunks', data)


async def list_models(include_hidden: bool = False, include_aliases: bool = True) -> List[Dict[str, Any]]:
    """List available models (chat, embedding, rerank) for model selection UIs."""
    if not _configured():
        print('[RAG] Not configured - returning mock model list')
        return [{'id': 'mock-model'}]
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.get(
            f'{ENDPOINT}/models',
            params={'include_hidden_models': include_hidden, 'include_aliases': include_aliases},
            headers=_headers(),
        )
        res.raise_for_status()
        data = res.json()
        return data.get('data') or data.get('models') or data
