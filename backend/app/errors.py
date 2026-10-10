"""JSON error responses. 500s stay generic; details are logged server-side."""

from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger("app")


class ApiError(Exception):
    def __init__(self, message: str, status_code: int = 500, code: str = "INTERNAL_ERROR"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def bad_request(message: str) -> ApiError:
    return ApiError(message, 400, "BAD_REQUEST")


def not_found(message: str) -> ApiError:
    return ApiError(message, 404, "NOT_FOUND")


def unprocessable(message: str) -> ApiError:
    return ApiError(message, 422, "UNPROCESSABLE")


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


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        if exc.status_code >= 500:
            logger.exception("API error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": exc.code,
                "message": "An unexpected error occurred" if exc.status_code >= 500 else exc.message,
                "statusCode": exc.status_code,
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        message = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": _STATUS_CODES.get(exc.status_code, "ERROR"),
                "message": message,
                "statusCode": exc.status_code,
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=400,
            content={
                "error": "BAD_REQUEST",
                "message": "Invalid request",
                "statusCode": 400,
            },
        )

    @app.exception_handler(Exception)
    async def generic_handler(request: Request, exc: Exception):
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "INTERNAL_ERROR",
                "message": "An unexpected error occurred",
                "statusCode": 500,
            },
        )
