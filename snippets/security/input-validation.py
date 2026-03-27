"""
SNIPPET: Input Validation
CATEGORY: Security
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Server-side input validation using Pydantic (built into FastAPI).
    Shows common validation patterns and sanitization helpers.

DEPENDENCIES:
    None (Pydantic is built into FastAPI)

USAGE:
    from input_validation import sanitize_string, CreateUserRequest

    @app.post("/users")
    async def create_user(body: CreateUserRequest):
        # body is already validated by Pydantic
        clean_name = sanitize_string(body.name)
        ...

IMPORTANT:
    - ALWAYS validate on the server, even if frontend validates too
    - NEVER trust client-side validation alone
    - Use Pydantic models for all request bodies
"""

import re
import html
from pydantic import BaseModel, Field, field_validator, EmailStr

# ---------------------------------------------------------------------------
# Example: Validated request models
# ---------------------------------------------------------------------------

class CreateUserRequest(BaseModel):
    """Example: validate a user creation request."""
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    role: str = Field(default="user", pattern=r"^(user|expert|admin)$")
    age: int | None = Field(default=None, ge=0, le=150)

    @field_validator("name")
    @classmethod
    def clean_name(cls, v):
        # Strip HTML tags and excessive whitespace
        v = re.sub(r"<[^>]+>", "", v).strip()
        if not v:
            raise ValueError("Name cannot be empty after sanitization")
        return v


class SearchRequest(BaseModel):
    """Example: validate search/filter params."""
    query: str = Field(min_length=1, max_length=500)
    page: int = Field(default=1, ge=1)
    per_page: int = Field(default=20, ge=1, le=100)
    sort_by: str = Field(default="created_at", pattern=r"^(created_at|name|email|updated_at)$")
    sort_order: str = Field(default="desc", pattern=r"^(asc|desc)$")


class FileUploadRequest(BaseModel):
    """Example: validate file metadata."""
    filename: str = Field(max_length=255)
    content_type: str = Field(pattern=r"^(application|text|image)/[\w.+-]+$")
    size: int = Field(ge=1, le=50 * 1024 * 1024)  # 50MB max

    @field_validator("filename")
    @classmethod
    def safe_filename(cls, v):
        # Remove path traversal attempts
        v = v.replace("..", "").replace("/", "").replace("\\", "")
        if not v:
            raise ValueError("Invalid filename")
        return v


# ---------------------------------------------------------------------------
# Sanitization helpers
# ---------------------------------------------------------------------------

def sanitize_string(value: str) -> str:
    """Remove HTML tags, escape special chars, normalize whitespace."""
    # Remove HTML tags
    clean = re.sub(r"<[^>]+>", "", value)
    # Escape remaining HTML entities
    clean = html.escape(clean)
    # Normalize whitespace
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean


def sanitize_url(url: str) -> str | None:
    """Validate and sanitize a URL. Returns None if invalid."""
    url = url.strip()
    if not re.match(r"^https?://", url, re.IGNORECASE):
        return None
    # Block javascript: URLs
    if re.match(r"^javascript:", url, re.IGNORECASE):
        return None
    return url


def sanitize_filename(filename: str) -> str:
    """Make a filename safe for storage."""
    # Remove path separators and traversal
    safe = re.sub(r'[/\\:*?"<>|]', "_", filename)
    safe = safe.replace("..", "_")
    return safe[:255]  # Limit length