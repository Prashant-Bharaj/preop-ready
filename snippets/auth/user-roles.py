"""
SNIPPET: User Roles & Whitelisting
CATEGORY: Authentication & Access Control
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Role-based access control with admin approval workflow.
    Auto-creates users on first login from OIDC headers.
    Supports user/expert/admin roles and pending/approved/denied statuses.

DEPENDENCIES:
    pip install asyncpg

ENVIRONMENT VARIABLES:
    SECRET_3 or INITIAL_ADMIN_EMAILS — comma-separated bootstrap admin emails

SQL SCHEMA:
    Uses the same schema as auth/user-roles-schema.sql

USAGE:
    from user_roles import create_session, require_approved, require_role, auth_router

    # Auto-create user on login
    @app.middleware("http")
    async def auth_middleware(request, call_next):
        await create_session(request)
        return await call_next(request)

    # Protect routes
    @app.get("/dashboard", dependencies=[Depends(require_approved)])
    async def dashboard(): ...

    @app.get("/admin", dependencies=[Depends(require_role("admin"))])
    async def admin_panel(): ...

    # Mount auth routes
    app.include_router(auth_router, prefix="/auth")

RELATED:
    - snippets/auth/user-roles-schema.sql (database schema)
    - snippets/auth/user-identity.py (basic OIDC identity extraction)
"""

import os
from fastapi import APIRouter, Depends, HTTPException, Request
import asyncpg

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ADMIN_EMAILS = [
    e.strip().lower()
    for e in (os.getenv("INITIAL_ADMIN_EMAILS") or os.getenv("SECRET_3") or "").split(",")
    if e.strip()
]

_pool = None

async def get_pool():
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            host=os.getenv("DATABASE_HOST", "db"),
            port=int(os.getenv("DATABASE_PORT", "5432")),
            database=os.getenv("DATABASE_NAME", "myapp"),
            user=os.getenv("DATABASE_USER", "postgres"),
            password=os.getenv("DATABASE_PASSWORD", "postgres"),
        )
    return _pool

# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

async def create_session(request: Request) -> dict | None:
    """Upsert user from OIDC headers. Auto-approves admin emails."""
    oidc_id = request.headers.get("x-amzn-oidc-identity")
    email = request.headers.get("x-amzn-oidc-email", "").lower()
    name = request.headers.get("x-amzn-oidc-name", "")

    if not oidc_id:
        # Local dev fallback
        if os.getenv("NODE_ENV") != "production":
            request.state.user = {"id": 0, "email": "dev@local", "name": "Dev User", "role": "admin", "account_status": "approved"}
            return request.state.user
        return None

    pool = await get_pool()

    # Check if user exists
    row = await pool.fetchrow("SELECT * FROM users WHERE oidc_user_id = $1", oidc_id)

    if row:
        request.state.user = dict(row)
        return dict(row)

    # New user — auto-approve admins
    is_admin = email in ADMIN_EMAILS
    role = "admin" if is_admin else "user"
    status = "approved" if is_admin else "pending"

    row = await pool.fetchrow(
        """INSERT INTO users (oidc_user_id, email, name, role, account_status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *""",
        oidc_id, email, name, role, status,
    )
    request.state.user = dict(row)
    return dict(row)

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

async def require_approved(request: Request):
    """FastAPI dependency: block pending/denied users."""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Not authenticated")
    if user.get("account_status") != "approved":
        raise HTTPException(403, f"Account is {user.get('account_status', 'unknown')}")
    return user

def require_role(*roles: str):
    """FastAPI dependency factory: check user role."""
    async def check_role(request: Request):
        user = getattr(request.state, "user", None)
        if not user:
            raise HTTPException(401, "Not authenticated")
        if user.get("account_status") != "approved":
            raise HTTPException(403, f"Account is {user.get('account_status', 'unknown')}")
        if user.get("role") not in roles:
            raise HTTPException(403, f"Requires role: {', '.join(roles)}")
        return user
    return Depends(check_role)

# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------
auth_router = APIRouter()

@auth_router.get("/users")
async def list_users(_=Depends(require_role("admin"))):
    pool = await get_pool()
    rows = await pool.fetch("SELECT id, email, name, role, account_status, created_at FROM users ORDER BY created_at DESC")
    return [dict(r) for r in rows]

@auth_router.put("/users/{user_id}/role")
async def update_role(user_id: int, body: dict, _=Depends(require_role("admin"))):
    role = body.get("role")
    if role not in ("user", "expert", "admin"):
        raise HTTPException(400, "Invalid role")
    pool = await get_pool()
    await pool.execute("UPDATE users SET role = $1 WHERE id = $2", role, user_id)
    return {"success": True}

@auth_router.put("/users/{user_id}/access")
async def update_access(user_id: int, body: dict, _=Depends(require_role("admin"))):
    status = body.get("status")
    if status not in ("approved", "denied", "pending"):
        raise HTTPException(400, "Invalid status")
    pool = await get_pool()
    await pool.execute("UPDATE users SET account_status = $1 WHERE id = $2", status, user_id)
    return {"success": True}