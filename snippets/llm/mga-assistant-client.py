"""
SNIPPET: Bayer MGA Assistant Client
CATEGORY: AI / LLM
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Connects to a Bayer MGA assistant using the ChatCompletion API.
    Same pattern as bayer-llm-client.py but for MGA-hosted assistants.
    Falls back to mock responses when credentials are not configured (local dev).

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
    APP_SECRET_1  ->  SECRET_1   ->  MGA endpoint URL
    APP_API_KEY   ->  API_KEY    ->  MGA API key (Bearer token)
    APP_SECRET_2  ->  SECRET_2   ->  Model / assistant ID

    For local development:
        MGA_ENDPOINT, MGA_API_KEY, MGA_MODEL

USAGE:
    from mga_assistant_client import call_assistant

    answer = await call_assistant("What are the side effects of aspirin?")

    # With conversation history
    answer = await call_assistant("Tell me more", messages=[
        {"role": "user", "content": "What is aspirin?"},
        {"role": "assistant", "content": "Aspirin is a pain reliever..."},
        {"role": "user", "content": "Tell me more"},
    ])

EXAMPLE FASTAPI ROUTE:
    @app.post("/ask-assistant")
    async def ask(body: dict):
        answer = await call_assistant(body["question"])
        return {"success": True, "answer": answer}

RELATED:
    - snippets/llm/bayer-llm-client.py (direct LLM chat completions)
"""

import os
import httpx

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MGA_CONFIG = {
    "endpoint": os.getenv("SECRET_1") or os.getenv("MGA_ENDPOINT"),
    "api_key": os.getenv("API_KEY") or os.getenv("MGA_API_KEY"),
    "model": os.getenv("SECRET_2") or os.getenv("MGA_MODEL"),
}

# ---------------------------------------------------------------------------
# Core function
# ---------------------------------------------------------------------------

async def call_assistant(
    prompt: str,
    model: str = None,
    messages: list = None,
    stream: bool = False,
    project: str = None,
    skip_mock: bool = False,
) -> str:
    """Call an MGA assistant via the ChatCompletion API."""
    endpoint = MGA_CONFIG["endpoint"]
    api_key = MGA_CONFIG["api_key"]

    if not endpoint or not api_key:
        if skip_mock:
            raise ValueError("MGA not configured - set SECRET_1 and API_KEY environment variables")
        print("[MGA] No endpoint/API key configured, using mock response")
        return "Mock response: MGA is not configured. Set SECRET_1 (endpoint) and API_KEY."

    selected_model = model or MGA_CONFIG["model"]
    if not selected_model:
        raise ValueError("MGA: No model configured. Set SECRET_2 or MGA_MODEL, or pass model argument.")

    # Build messages: use provided history or wrap prompt
    msg_list = messages or [{"role": "user", "content": prompt}]

    # Auto-append /chat/completions
    full_endpoint = endpoint if endpoint.endswith("/chat/completions") else f"{endpoint}/chat/completions"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if project:
        headers["project"] = project

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            full_endpoint,
            json={"model": selected_model, "messages": msg_list, "stream": stream},
            headers=headers,
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Connection test
# ---------------------------------------------------------------------------

async def test_assistant_connection() -> dict:
    """Test the MGA assistant connection."""
    import time

    if not MGA_CONFIG["endpoint"] or not MGA_CONFIG["api_key"]:
        return {
            "success": False,
            "message": "MGA not configured",
            "config": {
                "endpoint": bool(MGA_CONFIG["endpoint"]),
                "api_key": bool(MGA_CONFIG["api_key"]),
                "model": MGA_CONFIG.get("model"),
            },
        }

    start = time.time()
    try:
        await call_assistant('Respond with exactly one word: "OK"', skip_mock=True)
        return {
            "success": True,
            "message": "MGA connection successful",
            "response_time": round((time.time() - start) * 1000),
            "model": MGA_CONFIG["model"],
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"MGA connection failed: {e}",
            "response_time": round((time.time() - start) * 1000),
            "model": MGA_CONFIG["model"],
        }