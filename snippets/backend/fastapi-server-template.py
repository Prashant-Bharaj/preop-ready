"""
scopes: [backend]
flags: []
description: Baseline FastAPI server (typed) with Pydantic response models, CORS, /health, port 3000.
"""

"""
FastAPI Server Template (typed)

Basic FastAPI server with CORS middleware, Pydantic response models, and a
health endpoint. Routes are defined WITHOUT /api prefix — nginx/Traefik
strips it. Frontend calls /api/items -> backend defines /items.

Port: 3000 (fixed, do not change)

Type-checking:
  pip install mypy
  mypy --strict backend/

The mypy.ini snippet (snippets/backend/mypy.ini) is the canonical config.

RECOMMENDED requirements.txt block (commented — copy/adjust):

    fastapi>=0.115
    uvicorn[standard]>=0.32
    pydantic>=2.9
    mypy>=1.11

TODO (Phase 1 — W1.TYPES.GEN): once the contract type generator lands, import
generated Pydantic models from backend/generated/models.py:
    from generated.models import GetItemsResponse, ItemModel
The generator emits this file from .harness/contracts.json after every
successful build/iterate. Until W1.TYPES.GEN ships, hand-write Pydantic
models inline (see ItemsResponse below).
"""

from typing import List, Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: Literal["ok"]


class Item(BaseModel):
    id: int
    name: str


class ItemsResponse(BaseModel):
    items: List[Item]


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# FastAPI survives handler exceptions natively — this handler is for parity
# with the Node template: structured 500s, no stack traces to the client.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": "InternalServerError", "message": str(exc), "statusCode": 500},
    )


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Required health probe (do not remove)."""
    return HealthResponse(status="ok")


@app.get("/items", response_model=ItemsResponse)
def list_items() -> ItemsResponse:
    """Routes have NO /api prefix — nginx/Traefik strips it."""
    return ItemsResponse(items=[])


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=3000)
