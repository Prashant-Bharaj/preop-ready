"""myGenAssist chat client.

Reads MGA_BASE_URL / MGA_API_KEY and the platform names
SECRET_1 / LLM_ENDPOINT, API_KEY / LLM_API_KEY, SECRET_2 / LLM_MODEL.
No key means the caller should use the mock extractor. There is no
public-endpoint fallback.

Vision calls follow snippets/llm/mga-vision-chat.py (multi-content blocks).
"""

from __future__ import annotations

import os

import httpx


def llm_settings() -> dict:
    endpoint = (
        os.environ.get("MGA_BASE_URL")
        or os.environ.get("SECRET_1")
        or os.environ.get("LLM_ENDPOINT")
        or ""
    ).strip()
    api_key = (
        os.environ.get("MGA_API_KEY")
        or os.environ.get("API_KEY")
        or os.environ.get("LLM_API_KEY")
        or ""
    ).strip()
    model = (
        os.environ.get("MGA_MODEL")
        or os.environ.get("SECRET_2")
        or os.environ.get("LLM_MODEL")
        or ""
    ).strip()
    vision_model = (
        os.environ.get("MGA_VISION_MODEL")
        or model
    ).strip()
    return {
        "endpoint": endpoint,
        "api_key": api_key,
        "model": model,
        "vision_model": vision_model,
    }


def llm_configured() -> bool:
    settings = llm_settings()
    return bool(settings["endpoint"] and settings["api_key"] and settings["model"])


def _completions_url(endpoint: str) -> str:
    url = endpoint.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions"
    return url


async def call_llm(prompt: str, system_prompt: str) -> str:
    settings = llm_settings()
    if not settings["endpoint"] or not settings["api_key"] or not settings["model"]:
        raise RuntimeError("LLM is not configured")
    body = {
        "model": settings["model"],
        "temperature": 0,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            _completions_url(settings["endpoint"]),
            json=body,
            headers={
                "Authorization": f"Bearer {settings['api_key']}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        payload = response.json()
    return payload["choices"][0]["message"]["content"]


async def call_llm_vision(
    prompt: str,
    system_prompt: str,
    *,
    image_base64: str,
    mime: str,
) -> str:
    """Send an image + text prompt to a vision-capable MGA model."""
    settings = llm_settings()
    model = settings["vision_model"] or settings["model"]
    if not settings["endpoint"] or not settings["api_key"] or not model:
        raise RuntimeError("LLM is not configured")
    image_url = f"data:{mime};base64,{image_base64}"
    body = {
        "model": model,
        "temperature": 0,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            _completions_url(settings["endpoint"]),
            json=body,
            headers={
                "Authorization": f"Bearer {settings['api_key']}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        payload = response.json()
    return payload["choices"][0]["message"]["content"]
