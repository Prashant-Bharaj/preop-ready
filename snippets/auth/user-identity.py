"""
SNIPPET: User Identity Middleware (AWS ALB OIDC)
CATEGORY: Authentication
LANGUAGE: Python (FastAPI/Flask)
STATUS: ✅ Ready

DESCRIPTION:
    Extracts AND VERIFIES user identity from AWS ALB OIDC headers.
    Works automatically in production (Azure AD via ALB).
    Falls back to a test user for local development ONLY when the
    ALLOW_LOCAL_DEV_IDENTITY=true opt-in is set (see below).

SECURITY MODEL:
    The ALB overwrites x-amzn-oidc-* headers on every request, so a client
    cannot inject identity through the front door. This middleware ALSO
    cryptographically verifies the token (defense in depth): the JWT's
    ES256 signature is checked against the ALB's regional public key
    (fetched by key id, cached) and the expiry claim is enforced.
    A present-but-invalid token is REJECTED with 401 — it never falls
    back to the local dev user.

    A MISSING header is also a 401. The backend is reachable through a
    second ingress path that carries no OIDC at all (API Gateway ->
    VPC Link -> NLB -> the machine-to-machine ALB, which has no
    authenticate-oidc action -> Traefik -> this backend). Treating "no
    header" as "local developer" would hand that path a logged-in user.
    The local-dev fallback therefore requires an explicit opt-in:

        ALLOW_LOCAL_DEV_IDENTITY=true   # docker-compose / .env, local only

    Production task definitions never set it, so a header-less request in
    production yields None and the caller rejects with 401.

    The regional key endpoint serves the signing keys of EVERY load balancer
    in the region, so a signature check alone accepts a token minted by any
    other ALB. The platform therefore injects two pins into every deployed
    task, checked against the JWT header:

        PLATFORM_ALB_ARN      the platform ALB's ARN   -> header `signer`
        ALB_EXPECTED_ISSUER   the Cognito pool issuer  -> header `iss`

    Never hardcode either value or remove the checks. When PLATFORM_ALB_ARN
    is absent in production the module logs a warning at import time and
    falls back to signature-only verification.

DEPENDENCIES:
    pip install cryptography

HEADERS AVAILABLE:
    - x-amzn-oidc-data: JWT with user claims (sub, email, name) — VERIFIED
    - x-amzn-oidc-identity: User's unique subject ID (informational only;
      never trusted on its own)
    - x-amzn-oidc-accesstoken: OIDC access token

USAGE (FastAPI):
    from middleware.user_identity import get_current_user

    @app.get("/profile")
    def profile(user: dict = Depends(get_current_user)):
        return {"name": user["name"], "email": user["email"]}

USAGE (Flask):
    from middleware.user_identity import load_user

    @app.before_request
    def before_request():
        return load_user()   # returns a 401 response when the token is invalid

    @app.route("/profile")
    def profile():
        return {"name": g.user["name"], "email": g.user["email"]}

EXAMPLE:
    # User object structure:
    user = {
        "user_id": "MaTuw4CRnE7ZrlnsIntYUe83NiulIOEMYunPdOOHEAM",
        "email": "john.doe@bayer.com",
        "name": "John Doe",
        "given_name": "John",
        "family_name": "Doe"
    }
"""

import base64
import json
import os
import time
import urllib.request
from typing import Any, Dict, Optional

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

# Platform-injected pins (see SECURITY MODEL above). Empty = not pinned.
_EXPECTED_SIGNER = os.environ.get('PLATFORM_ALB_ARN', '')
_EXPECTED_ISSUER = os.environ.get('ALB_EXPECTED_ISSUER', '')
if not _EXPECTED_SIGNER and os.environ.get('ENVIRONMENT') == 'production':
    print('OIDC verify: PLATFORM_ALB_ARN not set - accepting tokens signed by any '
          'load balancer in the region (signer pinning inactive)')

# ALB public keys, cached per key id (keys rotate rarely)
_alb_key_cache: Dict[str, Any] = {}


def _b64url_decode(segment: str) -> bytes:
    segment = segment.replace('-', '+').replace('_', '/')
    padding = 4 - len(segment) % 4
    if padding != 4:
        segment += '=' * padding
    return base64.b64decode(segment)


def _get_alb_public_key(kid: str, region: str):
    """Fetch (and cache) the ALB's public key for a key id.
    Endpoint per AWS docs: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
    """
    if kid in _alb_key_cache:
        return _alb_key_cache[kid]
    url = f"https://public-keys.auth.elb.{region}.amazonaws.com/{kid}"
    with urllib.request.urlopen(url, timeout=5) as res:
        pem = res.read()
    key = serialization.load_pem_public_key(pem)
    _alb_key_cache[kid] = key
    return key


def verify_oidc_token(oidc_data: str) -> Optional[Dict[str, Any]]:
    """Verify the ALB OIDC JWT: ES256 signature against the regional ALB
    public key, plus expiry. Returns the verified payload, or None if invalid.
    """
    try:
        parts = oidc_data.split('.')
        if len(parts) != 3:
            return None

        header = json.loads(_b64url_decode(parts[0]))
        region = os.environ.get('AWS_REGION') or os.environ.get('AWS_DEFAULT_REGION')
        if not header.get('kid') or not region:
            # No key id or no region to fetch it from -> cannot verify -> reject.
            # (Deployed ECS tasks always have AWS_REGION set.)
            print('OIDC verify: missing kid or AWS_REGION')
            return None

        key = _get_alb_public_key(header['kid'], region)
        # ALB signs with ES256; the JOSE signature is raw r||s
        signature = _b64url_decode(parts[2])
        half = len(signature) // 2
        der_sig = utils.encode_dss_signature(
            int.from_bytes(signature[:half], 'big'),
            int.from_bytes(signature[half:], 'big'),
        )
        signing_input = f"{parts[0]}.{parts[1]}".encode()
        key.verify(der_sig, signing_input, ec.ECDSA(hashes.SHA256()))  # raises if invalid

        # Pin the signing load balancer and the identity provider behind it.
        # Both live in the JWT HEADER (`signer`, `iss`), not the payload. The
        # regional key endpoint serves keys for EVERY ALB in the region, so
        # without these a token minted elsewhere would verify.
        if _EXPECTED_SIGNER and header.get('signer') != _EXPECTED_SIGNER:
            print('OIDC verify: signer is not the platform load balancer')
            return None
        if _EXPECTED_ISSUER and header.get('iss') != _EXPECTED_ISSUER:
            print('OIDC verify: issuer is not the platform identity provider')
            return None

        payload = json.loads(_b64url_decode(parts[1]))
        if payload.get('exp') and payload['exp'] < time.time():
            return None
        return payload
    except Exception as e:
        print(f'OIDC verify failed: {e}')
        return None


def extract_user_identity(headers: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Extract user identity from AWS ALB OIDC headers (with verification).

    Returns the user dict, or None when the OIDC token is missing or
    INVALID — the caller must reject the request with 401 in that case.
    """
    oidc_data = headers.get('x-amzn-oidc-data')

    if oidc_data:
        payload = verify_oidc_token(oidc_data)
        if not payload:
            return None  # present but invalid -> reject, never fall back
        return {
            'user_id': payload.get('sub'),
            'email': payload.get('email'),
            'name': payload.get('name'),
            'given_name': payload.get('given_name'),
            'family_name': payload.get('family_name'),
            'picture': payload.get('picture'),
            'is_local_dev': False,
        }

    # No OIDC header at all. Only a machine that explicitly opted in gets the
    # local-dev user; everywhere else this is an unauthenticated request.
    if os.environ.get('ALLOW_LOCAL_DEV_IDENTITY') == 'true':
        return {
            'user_id': 'local-dev-user',
            'email': 'dev@localhost',
            'name': 'Local Developer',
            'given_name': 'Local',
            'family_name': 'Developer',
            'is_local_dev': True,
        }

    print(
        'No x-amzn-oidc-data header — rejecting as unauthenticated. '
        'For local development set ALLOW_LOCAL_DEV_IDENTITY=true (never in production).'
    )
    return None


def get_user_display_name(user: Dict[str, Any]) -> str:
    """Get user display name with graceful fallback."""
    if user.get('name'):
        return user['name']
    if user.get('given_name') and user.get('family_name'):
        return f"{user['given_name']} {user['family_name']}"
    if user.get('email'):
        return user['email'].split('@')[0]
    return 'User'


# ============================================
# FastAPI Integration
# ============================================

try:
    from fastapi import HTTPException, Request

    def get_current_user(request: Request) -> Dict[str, Any]:
        """FastAPI dependency for getting the VERIFIED current user.
        Raises 401 when the OIDC token is missing or fails verification.
        """
        headers = {k.lower(): v for k, v in request.headers.items()}
        user = extract_user_identity(headers)
        if user is None:
            raise HTTPException(
                status_code=401,
                detail='Identity token missing or could not be verified',
            )
        return user

except ImportError:
    # FastAPI not installed
    get_current_user = None


# ============================================
# Flask Integration
# ============================================

try:
    from flask import g, jsonify, request

    def load_user():
        """Flask before_request handler to load the VERIFIED user.
        Returns a 401 response (aborting the request) when the OIDC token
        is missing or fails verification; returns None to continue.
        """
        headers = {k.lower(): v for k, v in request.headers.items()}
        user = extract_user_identity(headers)
        if user is None:
            return jsonify({
                'error': 'UNAUTHORIZED',
                'message': 'Identity token missing or could not be verified',
                'statusCode': 401,
            }), 401
        g.user = user
        return None

except ImportError:
    # Flask not installed
    load_user = None
