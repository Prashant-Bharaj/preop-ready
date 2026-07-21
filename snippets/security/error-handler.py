"""
SNIPPET: API Error Handler
CATEGORY: Security
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Global FastAPI exception handlers that return descriptive JSON error
    responses with proper HTTP status codes. Never leaks stack traces,
    internal paths, or database details to clients — the full error is
    logged server-side only. 500s get a generic message; 4xx errors get
    a specific message so the client can fix the request.

    Standard error response format:
    { "error": "NOT_FOUND", "message": "User with ID 42 was not found", "statusCode": 404 }

HTTP STATUS CODE GUIDE:
    | Code | When to Use                                            |
    |------|--------------------------------------------------------|
    | 400  | Bad request — invalid input, missing fields            |
    | 401  | Unauthorized — not authenticated                       |
    | 403  | Forbidden — authenticated but no permission            |
    | 404  | Not found — resource doesn't exist                     |
    | 409  | Conflict — duplicate entry, version mismatch           |
    | 422  | Unprocessable — valid format but failed business rules |
    | 429  | Too many requests — rate limited                       |
    | 500  | Internal error — unexpected server failure             |

DEPENDENCIES:
    None (uses built-in FastAPI features)

USAGE:
    from error_handler import register_error_handlers, ApiError, not_found

    app = FastAPI()
    register_error_handlers(app)

    @app.get("/users/{user_id}")
    def get_user(user_id: int):
        user = find_user(user_id)
        if not user:
            raise not_found(f"User with ID {user_id} was not found")
        return user
"""

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("app")

# ---------------------------------------------------------------------------
# Error class + helpers
# ---------------------------------------------------------------------------

class ApiError(Exception):
    """Operational API error with status code and machine-readable code."""

    def __init__(self, message: str, status_code: int = 500,
                 code: str = "INTERNAL_ERROR"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def bad_request(message: str = "Invalid request") -> ApiError:
    return ApiError(message, 400, "BAD_REQUEST")


def unauthorized(message: str = "Authentication required") -> ApiError:
    return ApiError(message, 401, "UNAUTHORIZED")


def forbidden(message: str = "You do not have permission to do this") -> ApiError:
    return ApiError(message, 403, "FORBIDDEN")


def not_found(message: str = "Resource not found") -> ApiError:
    return ApiError(message, 404, "NOT_FOUND")


def conflict(message: str = "Resource already exists") -> ApiError:
    return ApiError(message, 409, "CONFLICT")


def unprocessable(message: str = "Request failed business rules") -> ApiError:
    return ApiError(message, 422, "UNPROCESSABLE")


def too_many_requests(message: str = "Too many requests, slow down") -> ApiError:
    return ApiError(message, 429, "TOO_MANY_REQUESTS")


# Map status codes to machine-readable codes (for plain HTTPException)
_STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "UNPROCESSABLE",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_ERROR",
}

# ---------------------------------------------------------------------------
# Exception handlers
# ---------------------------------------------------------------------------

def register_error_handlers(app: FastAPI) -> None:
    """Attach the global exception handlers to a FastAPI app."""

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        if exc.status_code >= 500:
            logger.exception("Unhandled ApiError: %s", exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": exc.code,
                "message": ("An unexpected error occurred"
                            if exc.status_code >= 500 else exc.message),
                "statusCode": exc.status_code,
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        # Normalize FastAPI's own HTTPException to the standard format
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": _STATUS_CODES.get(exc.status_code, "ERROR"),
                "message": str(exc.detail),
                "statusCode": exc.status_code,
            },
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        # Log full error (with traceback) server-side only
        logger.exception("Unhandled error on %s %s", request.method,
                         request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "INTERNAL_ERROR",
                "message": "An unexpected error occurred",  # Hide internals
                "statusCode": 500,
            },
        )
