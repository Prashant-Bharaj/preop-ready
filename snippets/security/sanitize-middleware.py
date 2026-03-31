"""
SNIPPET: Global Sanitization Middleware
CATEGORY: Security
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Global middleware that automatically sanitizes ALL incoming request bodies
    and ALL outgoing JSON responses. Acts as a safety net — even if per-route
    validation is forgotten, this catches dangerous input/output.

    Also includes validation helpers: is_positive_int, is_allowed_value,
    validate_required_fields, enforce_max_lengths.

DEPENDENCIES:
    pip install nh3

USAGE:
    from sanitize_middleware import SanitizeMiddleware, is_positive_int

    app = FastAPI()
    app.add_middleware(SanitizeMiddleware)

    @app.get("/items/{item_id}")
    async def get_item(item_id: int):
        if not is_positive_int(item_id):
            raise HTTPException(status_code=400, detail="Invalid ID")
        ...

IMPORTANT:
    - Add SanitizeMiddleware BEFORE defining routes
    - Pydantic models handle most validation, but this middleware is a safety net
    - These are a SAFETY NET, not a replacement for Pydantic validation
"""

import json
from typing import Any
import nh3
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response, JSONResponse
from fastapi import FastAPI


# ---------------------------------------------------------------------------
# Sanitization functions
# ---------------------------------------------------------------------------

def strip_html(value: str) -> str:
    """
    Strip ALL HTML tags from a string.
    Uses nh3 library (Rust-backed, replaces deprecated bleach) for robust
    protection against XSS bypasses like unclosed tags and nested encoding.
    """
    if not isinstance(value, str):
        return value
    return nh3.clean(value, tags=set())


def deep_sanitize(obj: Any) -> Any:
    """Recursively sanitize all string values in an object/list."""
    if isinstance(obj, str):
        return strip_html(obj).strip()
    if isinstance(obj, list):
        return [deep_sanitize(item) for item in obj]
    if isinstance(obj, dict):
        return {key: deep_sanitize(value) for key, value in obj.items()}
    return obj


# ---------------------------------------------------------------------------
# Global Sanitization Middleware
# ---------------------------------------------------------------------------

class SanitizeMiddleware(BaseHTTPMiddleware):
    """
    Middleware that sanitizes both request bodies and response bodies.
    - Strips HTML tags from all string values in JSON request bodies
    - Strips HTML tags from all string values in JSON responses
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # --- Sanitize request body ---
        if request.method in ("POST", "PUT", "PATCH"):
            content_type = request.headers.get("content-type", "")
            if "application/json" in content_type:
                try:
                    body = await request.body()
                    if body:
                        parsed = json.loads(body)
                        sanitized = deep_sanitize(parsed)
                        # Replace the request body with sanitized version
                        request._body = json.dumps(sanitized).encode()
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass  # Let FastAPI handle malformed JSON

        # --- Call the route handler ---
        response = await call_next(request)

        # --- Sanitize response body ---
        if response.headers.get("content-type", "").startswith("application/json"):
            body = b""
            async for chunk in response.body_iterator:
                if isinstance(chunk, str):
                    chunk = chunk.encode()
                body += chunk
            try:
                parsed = json.loads(body)
                sanitized = deep_sanitize(parsed)
                return JSONResponse(
                    content=sanitized,
                    status_code=response.status_code,
                    headers=dict(response.headers),
                )
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass  # Return original response if not valid JSON

        return response


# ---------------------------------------------------------------------------
# Global Error Handler
# ---------------------------------------------------------------------------

def add_global_error_handler(app: FastAPI) -> None:
    """
    Add a global exception handler that never exposes stack traces.
    Returns generic message for 500s.

    Usage:
        app = FastAPI()
        add_global_error_handler(app)
    """

    @app.exception_handler(Exception)
    async def global_exception_handler(request: Request, exc: Exception):
        import traceback
        traceback.print_exc()  # Log full error server-side
        return JSONResponse(
            status_code=500,
            content={
                "error": "INTERNAL_ERROR",
                "message": "An unexpected error occurred",
            },
        )


# ---------------------------------------------------------------------------
# Per-route validation helpers
# ---------------------------------------------------------------------------

def is_positive_int(value) -> bool:
    """Check if a value is a positive integer (for :id params)."""
    try:
        num = int(value)
        return num > 0
    except (TypeError, ValueError):
        return False


def is_allowed_value(value: str, allowed: list[str]) -> bool:
    """Check if a value is in an allowed list (for query params / enums)."""
    return value in allowed


def validate_required_fields(body: dict, fields: list[str]) -> list[str]:
    """
    Validate that required fields are present.
    Returns list of missing field names, or empty list if all present.
    """
    return [f for f in fields if not body.get(f)]


def enforce_max_lengths(body: dict, max_lengths: dict[str, int]) -> list[dict]:
    """
    Enforce max lengths on string fields.
    Returns list of violations: [{"field": name, "max": N, "actual": N}]
    """
    violations = []
    for field, max_len in max_lengths.items():
        value = body.get(field)
        if isinstance(value, str) and len(value) > max_len:
            violations.append({"field": field, "max": max_len, "actual": len(value)})
    return violations


# ---------------------------------------------------------------------------
# Setup helper
# ---------------------------------------------------------------------------

def apply_security_middleware(app: FastAPI) -> None:
    """
    Apply all global security middleware to a FastAPI app.
    Call this ONCE during app setup, BEFORE defining routes.

    Usage:
        from sanitize_middleware import apply_security_middleware

        app = FastAPI()
        apply_security_middleware(app)
    """
    app.add_middleware(SanitizeMiddleware)
    add_global_error_handler(app)