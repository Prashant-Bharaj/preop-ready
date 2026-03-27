"""
SNIPPET: App Settings (Runtime Config)
CATEGORY: Configuration
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Runtime configuration from database — change settings without redeploying.
    Reads DB first, falls back to env var, falls back to default.
    In-memory cache with 5-minute TTL.

DEPENDENCIES:
    pip install asyncpg

USAGE:
    from app_settings import get_config, set_config, settings_router

    # Read a setting
    assistant_id = await get_config("mga_assistant_id", fallback_env="MGA_ASSISTANT_ID")

    # Write a setting
    await set_config("mga_assistant_id", "asst_abc123", updated_by="admin@bayer.com")

    # Mount routes
    app.include_router(settings_router, prefix="/settings")

SQL SCHEMA (run in database/init/init.sql):
    CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT,
        description TEXT,
        updated_by VARCHAR(255),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
"""

import os
import time
from fastapi import APIRouter, HTTPException

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
_cache: dict[str, dict] = {}  # key -> {"value": str, "expires": float}
CACHE_TTL = 300  # 5 minutes

# ---------------------------------------------------------------------------
# Database connection (replace with your pool)
# ---------------------------------------------------------------------------
_pool = None

async def get_pool():
    global _pool
    if _pool is None:
        import asyncpg
        _pool = await asyncpg.create_pool(
            host=os.getenv("DATABASE_HOST", "db"),
            port=int(os.getenv("DATABASE_PORT", "5432")),
            database=os.getenv("DATABASE_NAME", "myapp"),
            user=os.getenv("DATABASE_USER", "postgres"),
            password=os.getenv("DATABASE_PASSWORD", "postgres"),
        )
    return _pool

# ---------------------------------------------------------------------------
# Core functions
# ---------------------------------------------------------------------------

async def get_config(key: str, fallback_env: str = None, default: str = None) -> str | None:
    """Get a config value. Priority: DB → env var → default."""
    # Check cache
    if key in _cache and _cache[key]["expires"] > time.time():
        return _cache[key]["value"]

    # Check DB
    try:
        pool = await get_pool()
        row = await pool.fetchrow("SELECT value FROM app_settings WHERE key = $1", key)
        if row and row["value"] is not None:
            _cache[key] = {"value": row["value"], "expires": time.time() + CACHE_TTL}
            return row["value"]
    except Exception as e:
        print(f"[Settings] DB read failed for '{key}': {e}")

    # Fallback to env var
    if fallback_env:
        env_val = os.getenv(fallback_env)
        if env_val is not None:
            return env_val

    return default


async def set_config(key: str, value: str, updated_by: str = None) -> dict:
    """Set a config value (upsert). Invalidates cache."""
    pool = await get_pool()
    await pool.execute(
        """INSERT INTO app_settings (key, value, updated_by, updated_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP""",
        key, value, updated_by,
    )
    # Invalidate cache
    _cache.pop(key, None)
    return {"key": key, "value": value, "updated_by": updated_by}


async def get_all_settings() -> list[dict]:
    """Get all settings (admin)."""
    pool = await get_pool()
    rows = await pool.fetch("SELECT key, value, description, updated_by, updated_at FROM app_settings ORDER BY key")
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# FastAPI routes
# ---------------------------------------------------------------------------
settings_router = APIRouter()

@settings_router.get("")
async def list_settings():
    return await get_all_settings()

@settings_router.put("/{key}")
async def update_setting(key: str, body: dict):
    if "value" not in body:
        raise HTTPException(400, "Missing 'value' in request body")
    result = await set_config(key, body["value"], updated_by=body.get("updated_by"))
    return result