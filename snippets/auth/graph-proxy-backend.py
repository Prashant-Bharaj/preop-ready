"""
scopes: [backend]
flags: [microsoft-graph, sharepoint, onedrive]
description: FastAPI/Flask helpers that proxy frontend Graph requests + auth-start redirects to the platform proxy + bouncer.

SNIPPET: Microsoft Graph -- Platform OBO Proxy + Bouncer (Backend, Python)
CATEGORY: Authentication
LANGUAGE: Python (FastAPI / Flask)
STATUS: Ready

DEPENDENCIES:
    pip install boto3 httpx fastapi  # or flask

ENVIRONMENT VARIABLES (injected by platform deploy, do not hardcode):
    PLATFORM_GRAPH_PROXY_URL        AWS-native VPC endpoint URL for backend
                                    -> https://<api-id>-<vpce-id>.execute-api.<region>.amazonaws.com/v1/platform/graph
                                    Served with an Amazon Trust Services cert
                                    (publicly trusted by Python out of the box).
                                    Avoids forcing every project to bundle
                                    Bayer's corporate CA.
    PLATFORM_GRAPH_AUTH_START_URL   Custom domain URL for browser redirects
                                    -> https://api.vibe.intranet.cnb/platform/auth/start
                                    Must be the custom domain because Entra's
                                    registered redirect URI matches this host
                                    and the browser sets session cookies on it.
    AWS_REGION                      eu-central-1 (set by ECS)

USAGE (FastAPI):
    from fastapi import FastAPI, Request, Header, HTTPException
    from fastapi.responses import JSONResponse, RedirectResponse
    from graph_proxy_backend import call_graph_proxy, auth_start_url

    app = FastAPI()

    @app.get("/graph/auth-start")  # frontend calls /api/graph/... — the /api prefix is stripped in transit
    def auth_start(return_url: str):
        return RedirectResponse(url=auth_start_url(return_url), status_code=302)

    @app.post("/graph/{operation:path}")
    async def graph(operation: str, body: dict, x_platform_session: str = Header(...)):
        try:
            return await call_graph_proxy(operation, body, x_platform_session)
        except RuntimeError as e:
            status = getattr(e, "status_code", 502)
            code = getattr(e, "code", None)
            detail = getattr(e, "detail", None) or {}
            # PR2.2 -- forward consent_required + consent_url verbatim so the
            # frontend client snippet can redirect the browser to the consent
            # screen. Other codes go through the generic error shape.
            if code == "consent_required" and detail.get("consent_url"):
                return JSONResponse(
                    status_code=403,
                    content={
                        "error": "consent_required",
                        "consent_url": detail["consent_url"],
                        "project": detail.get("project"),
                        "scope": detail.get("scope"),
                        "message": str(e),
                    },
                )
            return JSONResponse(
                status_code=status,
                content={
                    "error": code or "graph_proxy_error",
                    "status": status,
                    "message": str(e),
                    "detail": detail or None,
                },
            )
"""

import json
import os
from typing import Any, Dict, Optional
from urllib.parse import quote, urlparse

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = os.environ.get("AWS_REGION", "eu-central-1")

_session: Optional[boto3.Session] = None


def _get_session() -> boto3.Session:
    global _session
    if _session is None:
        _session = boto3.Session()
    return _session


def _proxy_url() -> str:
    url = os.environ.get("PLATFORM_GRAPH_PROXY_URL")
    if not url:
        raise RuntimeError(
            "PLATFORM_GRAPH_PROXY_URL not set -- platform deploy should inject this."
        )
    return url


def _auth_start_endpoint() -> str:
    url = os.environ.get("PLATFORM_GRAPH_AUTH_START_URL")
    if not url:
        raise RuntimeError("PLATFORM_GRAPH_AUTH_START_URL not set.")
    return url


def auth_start_url(return_url: str) -> str:
    """Build the redirect URL to the platform bouncer."""
    return f"{_auth_start_endpoint()}?return={quote(return_url, safe='')}"


async def call_graph_proxy(
    operation: str,
    body: Optional[Dict[str, Any]],
    session_id: str,
) -> Dict[str, Any]:
    """
    SigV4-signed POST to the platform Graph proxy. The platform looks up the
    user_token by session_id server-side; this backend never sees user_tokens.
    """
    if not session_id:
        err = RuntimeError("missing X-Platform-Session header from frontend")
        setattr(err, "status_code", 401)
        raise err

    proxy = urlparse(f"{_proxy_url()}/{operation}")
    payload = json.dumps(body or {})

    creds = _get_session().get_credentials()
    if creds is None:
        raise RuntimeError("no AWS credentials available (ECS task role not attached?)")

    request = AWSRequest(
        method="POST",
        url=proxy.geturl(),
        data=payload,
        headers={
            "host": proxy.hostname or "",
            "content-type": "application/json",
            "x-platform-session": session_id,
        },
    )
    SigV4Auth(creds.get_frozen_credentials(), "execute-api", REGION).add_auth(request)

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(proxy.geturl(), headers=dict(request.headers), content=payload)

    try:
        parsed = resp.json() if resp.content else {}
    except Exception:
        parsed = {"raw": resp.text}

    if resp.status_code >= 400:
        # Preserve the platform proxy's `error` code (e.g. "consent_required",
        # "session_project_mismatch") so callers can branch on it cleanly.
        code = parsed.get("error") if isinstance(parsed.get("error"), str) else None
        err = RuntimeError(f"graph proxy {resp.status_code}: {parsed.get('error', resp.text)}")
        setattr(err, "status_code", resp.status_code)
        setattr(err, "code", code)
        setattr(err, "detail", parsed)
        raise err

    return parsed
