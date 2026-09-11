"""
scopes: [backend]
flags: [ai-rag, file-uploads]
description: Upload end-user files to the MGA assistant's knowledge base (Python). Surfaces via uploaded_docs tool.
"""

"""
SNIPPET: MGA Assistant File Upload (Python)
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI / async httpx)

DESCRIPTION:
    Posts a file to /assistants/{id}/files. See mga-file-upload.js for the
    full rationale on uploaded_docs vs custom RAG.

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES:
    MGA_API_KEY, MGA_BASE_URL, MGA_ASSISTANT_ID (written by harness).

USAGE:
    from mga_file_upload import upload_file

    file_id = await upload_file(
        buffer=file_bytes,
        filename="report.pdf",
        mime="application/pdf",
    )

EXAMPLE FASTAPI ROUTE:
    @app.post("/upload-doc")
    async def upload(file: UploadFile = File()):
        b = await file.read()
        file_id = await upload_file(
            buffer=b,
            filename=file.filename,
            mime=file.content_type,
        )
        return {"fileId": file_id}
"""

import os
import httpx

MGA_API_KEY = os.getenv("MGA_API_KEY")
MGA_BASE_URL = os.getenv("MGA_BASE_URL", "https://chat.int.bayer.com/api/v2")
MGA_ASSISTANT_ID = os.getenv("MGA_ASSISTANT_ID")

if not MGA_API_KEY or not MGA_ASSISTANT_ID:
    raise RuntimeError("MGA not configured. Set MGA_API_KEY and MGA_ASSISTANT_ID in env.")


async def upload_file(*, buffer: bytes, filename: str, mime: str) -> str:
    """Upload a file to the assistant's knowledge base. Returns the MGA file id."""
    if not buffer:
        raise ValueError("buffer required")
    if not filename:
        raise ValueError("filename required")
    if not mime:
        raise ValueError("mime required")

    url = MGA_BASE_URL.rstrip("/") + f"/assistants/{MGA_ASSISTANT_ID}/files"
    headers = {"Authorization": f"Bearer {MGA_API_KEY}"}
    files = {"file": (filename, buffer, mime)}

    async with httpx.AsyncClient(timeout=120.0) as client:
        res = await client.post(url, headers=headers, files=files)
        if res.status_code >= 400:
            raise RuntimeError(f"MGA file upload failed: HTTP {res.status_code} — {res.text[:300]}")
        data = res.json()
        file_id = data.get("id")
        if not file_id:
            raise RuntimeError(f"MGA file upload returned no id: {str(data)[:200]}")
        return file_id
