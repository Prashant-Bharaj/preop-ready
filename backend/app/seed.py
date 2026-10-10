"""Reset the synthetic cohort. Usage: python -m app.seed"""

from __future__ import annotations

from app.db import connect, init_schema
from app.repository import reset_and_seed


def main() -> None:
    conn = connect()
    try:
        init_schema(conn)
        reset_and_seed(conn)
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
