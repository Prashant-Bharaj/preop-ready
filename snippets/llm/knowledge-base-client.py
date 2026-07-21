"""
SNIPPET: MGA Knowledge Base Client (managed RAG)
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI/Flask, async httpx)
STATUS: Ready

DESCRIPTION:
    The PREFERRED path for "chat with my documents" / document QA:
    myGenAssist's v3 Knowledge Base does chunking, embedding, storage and
    retrieval as a managed service — no custom pipeline, no own vector DB.
    Flow: create KB -> upload documents -> attach -> poll status -> retrieve
    relevant chunks -> feed them + the question to chat completions
    (snippets/llm/bayer-llm-client.py).
    Falls back to mock responses when credentials are not configured (local dev).

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
    APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL
    APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
    Optional: MGA_PROJECT        ->  project identifier header (mga-project)
    For local development: LLM_ENDPOINT, LLM_API_KEY in backend/.env

USAGE:
    from knowledge_base_client import (
        create_knowledge_base, upload_documents, attach_documents,
        retrieve_context,
    )

    # One-time setup
    kb = await create_knowledge_base(name="project-docs")
    docs = await upload_documents([("guide.pdf", pdf_bytes, "application/pdf")])
    await attach_documents(kb["id"], [d["id"] for d in docs])

    # Per question
    context = await retrieve_context(kb["id"], user_question)
    answer = await call_llm(user_question,
                            system_prompt=f"Answer using ONLY this context:\n{context}")
"""

import os
from typing import Any, Dict, List, Optional, Tuple

import httpx

ENDPOINT = os.environ.get('SECRET_1') or os.environ.get('LLM_ENDPOINT')
API_KEY = os.environ.get('API_KEY') or os.environ.get('LLM_API_KEY')
PROJECT = os.environ.get('MGA_PROJECT')
TIMEOUT = 60.0


def _configured() -> bool:
    return bool(ENDPOINT and API_KEY)


def _headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    h = {'Authorization': f'Bearer {API_KEY}'}
    if PROJECT:
        h['mga-project'] = PROJECT
    if extra:
        h.update(extra)
    return h


async def create_knowledge_base(
    name: str,
    description: Optional[str] = None,
    access: str = 'private',
    media_type: str = 'DOCUMENTS',
    content_type: str = 'DOCUMENTS',
) -> Dict[str, Any]:
    """Create a knowledge base (form-urlencoded body per the MGA API)."""
    if not _configured():
        print('[KB] Not configured - returning mock knowledge base')
        return {'id': 'mock-kb-id', 'name': name, 'mock': True}
    data = {'name': name, 'access': access, 'media_type': media_type, 'content_type': content_type}
    if description:
        data['description'] = description
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(f'{ENDPOINT}/knowledge', data=data, headers=_headers())
        res.raise_for_status()
        return res.json()


async def upload_documents(
    files: List[Tuple[str, bytes, str]],
    purpose: str = 'file_upload',
) -> List[Dict[str, Any]]:
    """Upload documents (multipart). files = [(filename, content_bytes, mime_type)].
    purpose: file_upload | onedrive_sync | sharepoint_sync | conversation_upload
    """
    if not _configured():
        print('[KB] Not configured - returning mock documents')
        return [{'id': f'mock-doc-{i}', 'name': f[0], 'mock': True} for i, f in enumerate(files)]
    multipart = [('files', (name, content, mime)) for name, content, mime in files]
    params = {'content_type': 'DOCUMENTS', 'purpose': purpose}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(
            f'{ENDPOINT}/knowledge/documents',
            files=multipart, params=params, headers=_headers(),
        )
        res.raise_for_status()
        # VERIFY: response is a list of document records; adjust the id field
        # if the API returns e.g. document_id instead of id.
        return res.json()


async def attach_documents(knowledge_base_id: str, document_ids: List[str]) -> Dict[str, Any]:
    """Attach uploaded documents to a knowledge base.
    VERIFY: body shape assumed {"document_ids": [...]} — confirm against the
    POST /knowledge/{id}/documents schema and adjust if needed.
    """
    if not _configured():
        return {'attached': len(document_ids), 'mock': True}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(
            f'{ENDPOINT}/knowledge/{knowledge_base_id}/documents',
            json={'document_ids': document_ids}, headers=_headers(),
        )
        res.raise_for_status()
        return res.json()


async def get_documents_status(knowledge_base_id: str) -> Dict[str, Any]:
    """Processing status of the KB's documents (poll until ready before retrieving)."""
    if not _configured():
        return {'status': 'ready', 'mock': True}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.get(
            f'{ENDPOINT}/knowledge/{knowledge_base_id}/documents/status',
            headers=_headers(),
        )
        res.raise_for_status()
        return res.json()


async def retrieve(
    knowledge_base_id: str,
    query: str,
    top_k: int = 10,
    method: str = 'semantic_search',
    score_threshold_enabled: bool = False,
) -> Dict[str, Any]:
    """Retrieve relevant chunks for a query (raw response)."""
    if not _configured():
        print('[KB] Not configured - returning mock retrieval')
        return {'chunks': [{'text': f'Mock context for: {query}', 'score': 1}], 'mock': True}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(
            f'{ENDPOINT}/knowledge/{knowledge_base_id}/retrieve',
            json={
                'query': query,
                'retrieval_settings': {
                    'retrieval_method': method,
                    'score_threshold_enabled': score_threshold_enabled,
                    'top_k': top_k,
                },
            },
            headers=_headers(),
        )
        res.raise_for_status()
        return res.json()


async def retrieve_context(knowledge_base_id: str, query: str, **options) -> str:
    """Retrieve and join chunk texts into one context string for a prompt.
    VERIFY: adapts to chunks/results/documents arrays with text/content
    fields — confirm against a real retrieve response.
    """
    data = await retrieve(knowledge_base_id, query, **options)
    items = data.get('chunks') or data.get('results') or data.get('documents') or []
    return '\n---\n'.join(
        c.get('text') or c.get('content') or '' for c in items if isinstance(c, dict)
    )
