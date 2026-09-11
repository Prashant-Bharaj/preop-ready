"""
scopes: [backend]
flags: [exports-csv]
description: Streaming CSV export endpoint for FastAPI with proper RFC 4180 escaping.

Mounts a FastAPI route that streams rows as CSV. Handles fields with commas,
quotes, and newlines correctly per RFC 4180. Use for downloads of any size;
does NOT buffer the full table in memory.

Wire it into your app:
    from fastapi import FastAPI
    from .csv_exporter import mount_csv_export
    app = FastAPI()
    async def rows(_req):
        yield ['id', 'email', 'created_at']  # header row
        async with pool.acquire() as conn:
            async for r in conn.cursor('SELECT id, email, created_at FROM users ORDER BY created_at DESC'):
                yield [r['id'], r['email'], r['created_at'].isoformat()]
    mount_csv_export(app, '/reports/csv', rows)

The async generator pattern streams rows without loading everything into
memory first.
"""

import csv
import io
from typing import AsyncIterable, Awaitable, Callable, Iterable, Optional, Union

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse


RowSource = Union[
    Iterable[list],
    AsyncIterable[list],
    Callable[[Request], Iterable[list]],
    Callable[[Request], AsyncIterable[list]],
    Callable[[Request], Awaitable[AsyncIterable[list]]],
]


def _row_to_csv_line(row: list) -> bytes:
    # Use the stdlib csv module to delegate RFC 4180 escaping (commas, quotes,
    # newlines). Write to an in-memory buffer per row so we can stream without
    # holding the full file.
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator='\r\n')
    writer.writerow(['' if v is None else v for v in row])
    return buf.getvalue().encode('utf-8')


async def _aiter(source, request):
    # Normalize the various row-source shapes to an async iterator yielding
    # row arrays. Accepts: a sync iterable, an async iterable, or a callable
    # returning either when given the request.
    if callable(source):
        result = source(request)
        if hasattr(result, '__await__'):
            result = await result
        source = result

    if hasattr(source, '__aiter__'):
        async for row in source:
            yield row
    else:
        for row in source:
            yield row


def mount_csv_export(
    app: FastAPI,
    path: str,
    row_source: RowSource,
    *,
    filename: Optional[str] = None,
) -> None:
    """
    Mount a streaming CSV export endpoint at `path`. `row_source` yields row
    arrays; the FIRST yielded row is treated as the header. Streams chunks via
    StreamingResponse so the response body is sent incrementally.
    """
    download_name = filename or ((path.rstrip('/').split('/')[-1] or 'export') + '.csv')

    @app.get(path)
    async def _csv_export(request: Request):
        async def generate():
            async for row in _aiter(row_source, request):
                yield _row_to_csv_line(row)

        return StreamingResponse(
            generate(),
            media_type='text/csv; charset=utf-8',
            headers={
                'Content-Disposition': f'attachment; filename="{download_name}"',
                'Cache-Control': 'no-store',
            },
        )
