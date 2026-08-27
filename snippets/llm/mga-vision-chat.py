"""
scopes: [backend]
flags: [ai-chat]
description: Send images + text to MGA for visual analysis (Python). Uses /chat/completions with vision-capable models.
"""

"""
SNIPPET: MGA Vision Chat (Python)
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI / async httpx)

DESCRIPTION:
    Calls /chat/completions (OpenAI-compatible) with multi-content message
    blocks for vision tasks. See mga-vision-chat.js for the rationale on
    why /chat/completions instead of /chat/agent.

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES:
    MGA_API_KEY, MGA_BASE_URL (written by harness)
    MGA_VISION_MODEL (optional; defaults to claude-opus-4.7)

USAGE:
    from mga_vision_chat import analyze_image

    answer = await analyze_image(
        "What is in this image?",
        url="https://example.com/photo.jpg",
    )

    # Or from base64 (FastAPI UploadFile)
    @app.post("/analyze-image")
    async def analyze(question: str = Form(), image: UploadFile = File()):
        b = (await image.read())
        import base64
        ans = await analyze_image(
            question,
            base64=base64.b64encode(b).decode(),
            mime=image.content_type,
        )
        return {"answer": ans}
"""

import os
import httpx

MGA_API_KEY = os.getenv("MGA_API_KEY")
MGA_BASE_URL = os.getenv("MGA_BASE_URL", "https://chat.int.bayer.com/api/v2")
MGA_VISION_MODEL = os.getenv("MGA_VISION_MODEL", "claude-opus-4.7")

if not MGA_API_KEY:
    raise RuntimeError("MGA not configured. Set MGA_API_KEY in env.")


async def analyze_image(
    prompt: str,
    *,
    url: str | None = None,
    base64: str | None = None,
    mime: str | None = None,
    model: str | None = None,
    temperature: float = 0,
) -> str:
    """
    Analyze an image with a text prompt. Pass either `url=` or `base64=`+`mime=`.
    Returns the model's text reply.
    """
    if url:
        image_url = url
    elif base64 and mime:
        image_url = f"data:{mime};base64,{base64}"
    else:
        raise ValueError("Pass either url= or base64=+mime=")

    body = {
        "model": model or MGA_VISION_MODEL,
        "temperature": temperature,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        }],
        "stream": False,
    }
    headers = {
        "Authorization": f"Bearer {MGA_API_KEY}",
        "Content-Type": "application/json",
    }
    endpoint = MGA_BASE_URL.rstrip("/") + "/chat/completions"

    async with httpx.AsyncClient(timeout=120.0) as client:
        res = await client.post(endpoint, json=body, headers=headers)
        if res.status_code >= 400:
            raise RuntimeError(f"MGA vision failed: HTTP {res.status_code} — {res.text[:300]}")
        data = res.json()
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
