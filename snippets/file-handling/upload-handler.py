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
from pathlib import Path
from fastapi import UploadFile, HTTPException

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
    safe_name = f"{int(time.time() * 1000)}-{file.filename}"
    file_path = os.path.join(save_dir, safe_name)

    with open(file_path, "wb") as f:
        f.write(content)

    return {
        "filename": file.filename,
        "path": file_path,
        "size": len(content),
        "content_type": file.content_type,
    }