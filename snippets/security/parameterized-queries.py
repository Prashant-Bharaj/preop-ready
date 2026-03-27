"""
SNIPPET: Parameterized Queries
CATEGORY: Security
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Safe SQL queries using parameterized statements.
    Shows patterns for PostgreSQL (asyncpg) and MySQL (aiomysql).
    NEVER use string concatenation or f-strings for SQL!

DEPENDENCIES:
    pip install asyncpg    (PostgreSQL)
    pip install aiomysql   (MySQL)

USAGE:
    from parameterized_queries import get_db

    pool = await get_db()

    # SELECT
    user = await pool.fetchrow("SELECT * FROM users WHERE id = $1", user_id)

    # INSERT
    await pool.execute(
        "INSERT INTO users (name, email) VALUES ($1, $2)",
        name, email,
    )

IMPORTANT:
    ❌ NEVER DO THIS:
        query = f"SELECT * FROM users WHERE id = {user_id}"
        query = "SELECT * FROM users WHERE name = '" + name + "'"

    ✅ ALWAYS DO THIS:
        await pool.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
"""

import os
import asyncpg

# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------
_pool = None

async def get_db():
    """Get or create the database connection pool."""
    global _pool
    if _pool is None:
        # Platform provides DATABASE_URL in production
        database_url = os.getenv("DATABASE_URL")
        if database_url:
            _pool = await asyncpg.create_pool(dsn=database_url)
        else:
            _pool = await asyncpg.create_pool(
                host=os.getenv("DATABASE_HOST", "db"),
                port=int(os.getenv("DATABASE_PORT", "5432")),
                database=os.getenv("DATABASE_NAME", "myapp"),
                user=os.getenv("DATABASE_USER", "postgres"),
                password=os.getenv("DATABASE_PASSWORD", "postgres"),
            )
    return _pool


# ---------------------------------------------------------------------------
# CRUD examples (PostgreSQL with asyncpg)
# ---------------------------------------------------------------------------

# ✅ SELECT with parameters
async def get_user(user_id: int) -> dict | None:
    pool = await get_db()
    row = await pool.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
    return dict(row) if row else None


# ✅ SELECT with multiple conditions
async def search_users(name: str, role: str, limit: int = 20) -> list[dict]:
    pool = await get_db()
    rows = await pool.fetch(
        "SELECT * FROM users WHERE name ILIKE $1 AND role = $2 ORDER BY created_at DESC LIMIT $3",
        f"%{name}%", role, limit,
    )
    return [dict(r) for r in rows]


# ✅ INSERT with RETURNING
async def create_user(name: str, email: str, role: str = "user") -> dict:
    pool = await get_db()
    row = await pool.fetchrow(
        "INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *",
        name, email, role,
    )
    return dict(row)


# ✅ UPDATE
async def update_user(user_id: int, name: str = None, role: str = None) -> bool:
    pool = await get_db()
    result = await pool.execute(
        "UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role) WHERE id = $1",
        user_id, name, role,
    )
    return result == "UPDATE 1"


# ✅ DELETE
async def delete_user(user_id: int) -> bool:
    pool = await get_db()
    result = await pool.execute("DELETE FROM users WHERE id = $1", user_id)
    return result == "DELETE 1"


# ✅ Transaction
async def transfer_role(from_id: int, to_id: int, role: str) -> None:
    pool = await get_db()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("UPDATE users SET role = 'user' WHERE id = $1", from_id)
            await conn.execute("UPDATE users SET role = $1 WHERE id = $2", role, to_id)