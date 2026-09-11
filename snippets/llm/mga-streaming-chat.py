"""
scopes: [backend]
flags: [ai-chat]
description: Stream MGA assistant responses to the frontend via SSE (Python / FastAPI).
"""

"""
SNIPPET: MGA Streaming Chat (SSE forwarder, Python)
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI / async httpx)

DESCRIPTION:
    FastAPI endpoint that opens a Server-Sent Events stream to the browser,
    calls MGA's /chat/agent with stream=True, parses incoming SSE chunks, and
    forwards them as `data:` events on the outbound stream.

    Pairs with snippets/frontend/mga-chat-component.jsx (EventSource client).

    Why a server-side proxy: MGA_API_KEY must never reach the browser.

DEPENDENCIES:
    pip install httpx fastapi sse-starlette

ENVIRONMENT VARIABLES:
    MGA_API_KEY, MGA_BASE_URL, MGA_ASSISTANT_ID (written to .env by harness).

USAGE (FastAPI):
    from mga_streaming_chat import stream_chat_endpoint

    app.post("/chat/stream")(stream_chat_endpoint)

REQUEST SHAPE:
    {"message": str, "conversationId": str | None}

RESPONSE STREAM (SSE):
    data: {"delta": "..."}              — content chunk
    data: {"conversationId": "..."}     — once, near end
    data: {"done": true}                — final marker
    data: {"error": "..."}              — on failure
"""

import json
import logging
import os
import httpx
from fastapi import Request
from fastapi.responses import StreamingResponse

MGA_API_KEY = os.getenv("MGA_API_KEY")
MGA_BASE_URL = os.getenv("MGA_BASE_URL", "https://chat.int.bayer.com/api/v2")
MGA_ASSISTANT_ID = os.getenv("MGA_ASSISTANT_ID")

if not MGA_API_KEY or not MGA_ASSISTANT_ID:
    raise RuntimeError("MGA not configured. Set MGA_API_KEY and MGA_ASSISTANT_ID in env.")


from typing import Any, AsyncIterator
from fastapi.responses import JSONResponse


async def stream_chat_endpoint(request: Request) -> StreamingResponse | JSONResponse:
    payload = await request.json()
    message = payload.get("message")
    conversation_id = payload.get("conversationId")
    if not isinstance(message, str) or not message:
        return JSONResponse({"error": "message required"}, status_code=400)

    body: dict[str, Any] = {
        "assistant_id": MGA_ASSISTANT_ID,
        "messages": [{"role": "user", "content": message}],
        "stream": True,
        "hidden": False,
    }
    if conversation_id:
        body["conversation_id"] = conversation_id

    url = MGA_BASE_URL.rstrip("/") + "/chat/agent"
    headers = {
        "Authorization": f"Bearer {MGA_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    async def event_stream() -> AsyncIterator[str]:
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", url, headers=headers, json=body) as r:
                    if r.status_code >= 400:
                        txt = (await r.aread()).decode(errors="ignore")[:300]
                        yield f"data: {json.dumps({'error': f'HTTP {r.status_code}: {txt}'})}\n\n"
                        return

                    convo_sent = False
                    buffer = ""
                    async for chunk in r.aiter_text():
                        buffer += chunk
                        while "\n\n" in buffer:
                            event, buffer = buffer.split("\n\n", 1)
                            data_line = next(
                                (l for l in event.split("\n") if l.startswith("data:")), None,
                            )
                            if not data_line:
                                continue
                            data = data_line[5:].strip()
                            if not data or data == "[DONE]":
                                continue
                            try:
                                parsed = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            delta = (
                                (parsed.get("choices") or [{}])[0]
                                .get("delta", {})
                                .get("content")
                            )
                            if delta:
                                yield f"data: {json.dumps({'delta': delta})}\n\n"
                            if not convo_sent and parsed.get("conversation_id"):
                                yield f"data: {json.dumps({'conversationId': parsed['conversation_id']})}\n\n"
                                convo_sent = True
                    yield 'data: {"done": true}\n\n'
        except Exception:
            logging.getLogger(__name__).exception("myGenAssist streaming request failed")
            yield f"data: {json.dumps({'error': 'Upstream chat request failed'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
