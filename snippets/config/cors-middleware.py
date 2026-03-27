"""
SNIPPET: CORS Middleware
CATEGORY: Configuration
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    CORS middleware setup for FastAPI.
    Production: same origin (Traefik handles routing) — no CORS needed.
    Local dev: different ports — CORS required for frontend -> backend calls.

DEPENDENCIES:
    None (FastAPI includes CORSMiddleware)

USAGE:
    from cors_middleware import setup_cors

    app = FastAPI()
    setup_cors(app)

IMPORTANT:
    In production on this platform, CORS is NOT needed because:
    - Frontend (nginx:8080) and backend (express:3000) are behind Traefik
    - All requests go through the same domain: https://<repo>.vibe.intranet.cnb
    - Frontend calls /api/* → Traefik routes to backend (same origin)

    CORS is ONLY needed for local development when frontend and backend
    run on different ports (e.g., Vite on 5173, FastAPI on 3000).

COMMON MISTAKES:
    1. allow_origins=["*"] with allow_credentials=True → browsers block this
    2. Adding CORS in production → unnecessary, may cause duplicate headers
    3. Forgetting to handle OPTIONS preflight → use CORSMiddleware (handles it)
"""

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

def setup_cors(app: FastAPI) -> None:
    """
    Add CORS middleware. Only active in development.
    In production, Traefik handles same-origin routing — no CORS needed.
    """
    is_production = os.getenv("NODE_ENV") == "production"

    if is_production:
        # No CORS needed in production (same origin via Traefik)
        return

    # Local development: allow frontend dev servers
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",   # Vite default
            "http://localhost:8080",   # nginx local
            "http://localhost:3000",   # backend direct
            "http://localhost:8888",   # alternative dev port
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )