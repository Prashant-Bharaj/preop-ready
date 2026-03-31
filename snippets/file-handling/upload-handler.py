"""
SNIPPET: File Upload Handler
CATEGORY: File Handling
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Handle file uploads in FastAPI using UploadFile.
    Processes files in MEMORY by default — files are NOT saved to disk.
    For persistent storage, use /data/uploads (EFS-mounted in production).

DEPENDENCIES:
    pip install fastapi python-multipart

USAGE:
    from upload_handler import process_upload, save_upload

    # Memory processing (recommended)
    @app.post("/import-csv")
    async def import_csv(file: UploadFile):
        result = await process_upload(file, allowed_types=["text/csv"])
        rows = result["content"].decode().split("\\n")
        return {"rows": len(rows)}

    # Persistent storage (when files need to be accessed later)
    @app.post("/upload")
    async def upload(file: UploadFile):
        saved = await save_upload(file)
        return {"path": saved["path"], "size": saved["size"]}
"""

import os
import re
from pathlib import Path
from fastapi import UploadFile, HTTPException
from fastapi.responses import Response

# ---------------------------------------------------------------------------
# Filename Sanitization
# ---------------------------------------------------------------------------

def sanitize_filename(filename: str) -> str:
    """
    Sanitize a filename to prevent path traversal and injection.
    Strips directory components, null bytes, and dangerous characters.
    """
    if not filename:
        return "unnamed"
    # Strip path components (prevents ../../../etc/passwd)
    safe = os.path.basename(filename)
    # Remove null bytes
    safe = safe.replace("\0", "")
    # Remove non-printable characters
    safe = re.sub(r"[^\x20-\x7E]", "", safe)
    # Remove characters problematic on filesystems
    safe = re.sub(r'[<>:"/\\|?*]', "_", safe)
    # Collapse multiple dots/underscores
    safe = re.sub(r"\.{2,}", ".", safe)
    safe = re.sub(r"_{2,}", "_", safe)
    # Don't allow leading dots (hidden files)
    safe = safe.lstrip(".")
    return safe or "unnamed"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB

UPLOADS_DIR = (
    "/data/uploads"
    if os.getenv("NODE_ENV") == "production"
    else str(Path(__file__).parent.parent / "uploads")
)

# ---------------------------------------------------------------------------
# Memory processing (recommended — no files saved to disk)
# ---------------------------------------------------------------------------

async def process_upload(
    file: UploadFile,
    allowed_types: list[str] = None,
    max_size: int = MAX_FILE_SIZE,
) -> dict:
    """
    Read an uploaded file into memory. Does NOT save to disk.

    Returns: {"filename": str, "size": int, "content_type": str, "content": bytes}
    """
    content = await file.read()

    if len(content) > max_size:
        raise HTTPException(413, f"File too large. Max size: {max_size // (1024*1024)}MB")

    if allowed_types and file.content_type not in allowed_types:
        raise HTTPException(
            415,
            f"File type '{file.content_type}' not allowed. Allowed: {', '.join(allowed_types)}",
        )

    return {
        "filename": file.filename,
        "size": len(content),
        "content_type": file.content_type,
        "content": content,
    }


# ---------------------------------------------------------------------------
# Persistent storage (only when files need to be accessed later)
# ---------------------------------------------------------------------------

async def save_upload(
    file: UploadFile,
    subdirectory: str = "",
    allowed_types: list[str] = None,
    max_size: int = MAX_FILE_SIZE,
) -> dict:
    """
    Save an uploaded file to persistent storage (/data/uploads in production).

    Returns: {"filename": str, "path": str, "size": int, "content_type": str}
    """
    content = await file.read()

    if len(content) > max_size:
        raise HTTPException(413, f"File too large. Max size: {max_size // (1024*1024)}MB")

    if allowed_types and file.content_type not in allowed_types:
        raise HTTPException(
            415,
            f"File type '{file.content_type}' not allowed. Allowed: {', '.join(allowed_types)}",
        )

    save_dir = os.path.join(UPLOADS_DIR, subdirectory) if subdirectory else UPLOADS_DIR
    os.makedirs(save_dir, exist_ok=True)

    import time
    safe_name = f"{int(time.time() * 1000)}-{sanitize_filename(file.filename)}"
    file_path = os.path.join(save_dir, safe_name)

    with open(file_path, "wb") as f:
        f.write(content)

    return {
        "filename": file.filename,
        "path": file_path,
        "size": len(content),
        "content_type": file.content_type,
    }


# ---------------------------------------------------------------------------
# Secure file download response
# ---------------------------------------------------------------------------

def create_file_response(
    content: bytes,
    filename: str,
    content_type: str = "application/octet-stream",
) -> Response:
    """
    Create a download response with security headers.
    Forces the browser to download rather than render inline (prevents XSS).

    Usage:
        @app.get("/download/{file_id}")
        async def download(file_id: str):
            data, name = get_file_from_storage(file_id)
            return create_file_response(data, name, "application/pdf")
    """
    safe_name = sanitize_filename(filename)
    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )