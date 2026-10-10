"""Verified ALB identity, with an explicit local-demo opt-in.

A present token is verified (ES256, expiry, optional signer/issuer pins).
If verification fails the result is None — never the local demo user.
A missing token is the local demo user only when ALLOW_LOCAL_DEV_IDENTITY=true.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.request
from typing import Any, Dict, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from fastapi import HTTPException, Request

_EXPECTED_SIGNER = os.environ.get("PLATFORM_ALB_ARN", "")
_EXPECTED_ISSUER = os.environ.get("ALB_EXPECTED_ISSUER", "")

_alb_key_cache: Dict[str, Any] = {}


def _b64url_decode(segment: str) -> bytes:
    segment = segment.replace("-", "+").replace("_", "/")
    padding = 4 - len(segment) % 4
    if padding != 4:
        segment += "=" * padding
    return base64.b64decode(segment)


def _get_alb_public_key(kid: str, region: str):
    if kid in _alb_key_cache:
        return _alb_key_cache[kid]
    url = f"https://public-keys.auth.elb.{region}.amazonaws.com/{kid}"
    with urllib.request.urlopen(url, timeout=5) as res:
        pem = res.read()
    key = serialization.load_pem_public_key(pem)
    _alb_key_cache[kid] = key
    return key


def verify_oidc_token(oidc_data: str) -> Optional[Dict[str, Any]]:
    try:
        parts = oidc_data.split(".")
        if len(parts) != 3:
            return None
        header = json.loads(_b64url_decode(parts[0]))
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        if not header.get("kid") or not region:
            return None
        key = _get_alb_public_key(header["kid"], region)
        signature = _b64url_decode(parts[2])
        half = len(signature) // 2
        der_sig = utils.encode_dss_signature(
            int.from_bytes(signature[:half], "big"),
            int.from_bytes(signature[half:], "big"),
        )
        signing_input = f"{parts[0]}.{parts[1]}".encode()
        key.verify(der_sig, signing_input, ec.ECDSA(hashes.SHA256()))
        if _EXPECTED_SIGNER and header.get("signer") != _EXPECTED_SIGNER:
            return None
        if _EXPECTED_ISSUER and header.get("iss") != _EXPECTED_ISSUER:
            return None
        payload = json.loads(_b64url_decode(parts[1]))
        if payload.get("exp") and payload["exp"] < time.time():
            return None
        return payload
    except Exception:
        return None


def extract_user_identity(headers: Dict[str, str]) -> Optional[Dict[str, Any]]:
    oidc_data = headers.get("x-amzn-oidc-data")
    if oidc_data:
        payload = verify_oidc_token(oidc_data)
        if not payload:
            return None
        return {
            "user_id": payload.get("sub"),
            "email": payload.get("email"),
            "name": payload.get("name"),
            "given_name": payload.get("given_name"),
            "family_name": payload.get("family_name"),
            "is_local_dev": False,
        }
    if os.environ.get("ALLOW_LOCAL_DEV_IDENTITY") == "true":
        return {
            "user_id": "local-dev-user",
            "email": "clinician@test.local",
            "name": "Dr. Test Freigabe",
            "given_name": "Test",
            "family_name": "Freigabe",
            "is_local_dev": True,
        }
    return None


def get_current_user(request: Request) -> Dict[str, Any]:
    headers = {k.lower(): v for k, v in request.headers.items()}
    user = extract_user_identity(headers)
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="Identity token missing or could not be verified",
        )
    return user
