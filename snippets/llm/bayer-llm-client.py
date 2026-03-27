"""
SNIPPET: Bayer Internal LLM Client
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Connects to Bayer's internal LLM platform using the OpenAI-compatible API.
    Handles authentication, endpoint resolution, and error handling.
    Falls back to mock responses when credentials are not configured (local dev).

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
    APP_SECRET_1  ->  SECRET_1   ->  LLM endpoint URL
    APP_API_KEY   ->  API_KEY    ->  LLM API key (Bearer token)
    APP_SECRET_2  ->  SECRET_2   ->  Model name (e.g. gpt-4)

    For local development:
        LLM_ENDPOINT, LLM_API_KEY, LLM_MODEL

USAGE:
    from llm_client import call_llm, test_llm_connection

    answer = await call_llm("What is the capital of France?")

    answer = await call_llm("Summarize this...", system_prompt="You are a helpful assistant.")

EXAMPLE FASTAPI ROUTE:
    @app.post("/ask")
    async def ask(body: dict):
        answer = await call_llm(body["question"], system_prompt="You are a helpful assistant.")
        return {"success": True, "answer": answer}
"""

import os
import httpx

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
LLM_CONFIG = {
    "endpoint": os.getenv("SECRET_1") or os.getenv("LLM_ENDPOINT"),
    "api_key": os.getenv("API_KEY") or os.getenv("LLM_API_KEY"),
    "model": os.getenv("SECRET_2") or os.getenv("LLM_MODEL") or "gpt-4",
    "temperature": float(os.getenv("LLM_TEMPERATURE", "0.1")),
    "max_tokens": int(os.getenv("LLM_MAX_TOKENS", "0")) or None,
}

# ---------------------------------------------------------------------------
# Core LLM function
# ---------------------------------------------------------------------------

async def call_llm(
    prompt: str,
    system_prompt: str = "You are a helpful assistant.",
    model: str = None,
    temperature: float = None,
    max_tokens: int = None,
    skip_mock: bool = False,
) -> str:
    """Call the Bayer internal LLM API (OpenAI-compatible format)."""
    endpoint = LLM_CONFIG["endpoint"]
    api_key = LLM_CONFIG["api_key"]

    if not endpoint or not api_key:
        if skip_mock:
            raise ValueError("LLM not configured - set SECRET_1 and API_KEY environment variables")
        print("[LLM] No endpoint/API key configured, using mock response")
        return "Mock response: LLM is not configured. Set SECRET_1 (endpoint) and API_KEY."

    selected_model = model or LLM_CONFIG["model"]

    # Auto-append /chat/completions
    full_endpoint = endpoint if endpoint.endswith("/chat/completions") else f"{endpoint}/chat/completions"

    body = {
        "model": selected_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature if temperature is not None else LLM_CONFIG["temperature"],
    }

    token_limit = max_tokens or LLM_CONFIG["max_tokens"]
    if token_limit:
        body["max_tokens"] = token_limit

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            full_endpoint,
            json=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Connection test
# ---------------------------------------------------------------------------

async def test_llm_connection() -> dict:
    """Test the LLM connection. Returns config status and response time."""
    import time

    if not LLM_CONFIG["endpoint"] or not LLM_CONFIG["api_key"]:
        return {
            "success": False,
            "message": "LLM not configured",
            "config": {
                "endpoint": bool(LLM_CONFIG["endpoint"]),
                "api_key": bool(LLM_CONFIG["api_key"]),
                "model": LLM_CONFIG["model"],
            },
        }

    start = time.time()
    try:
        await call_llm('Respond with exactly one word: "OK"', max_tokens=10, skip_mock=True)
        return {
            "success": True,
            "message": "LLM connection successful",
            "response_time": round((time.time() - start) * 1000),
            "model": LLM_CONFIG["model"],
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"LLM connection failed: {e}",
            "response_time": round((time.time() - start) * 1000),
            "model": LLM_CONFIG["model"],
        }