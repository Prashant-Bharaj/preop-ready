"""
SNIPPET: User Identity Middleware (AWS ALB OIDC)
CATEGORY: Authentication
LANGUAGE: Python (FastAPI/Flask)
STATUS: ✅ Ready

DESCRIPTION:
    Extracts user identity from AWS ALB OIDC headers.
    Works automatically in production (Azure AD via ALB).
    Falls back to test user for local development.

DEPENDENCIES:
    None - uses built-in Python modules

HEADERS AVAILABLE:
    - x-amzn-oidc-data: JWT with user claims (sub, email, name)
    - x-amzn-oidc-identity: User's unique subject ID
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
        load_user()
    
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
from typing import Optional, Dict, Any


def extract_user_identity(headers: Dict[str, str]) -> Dict[str, Any]:
    """
    Extract user identity from AWS ALB OIDC headers.
    
    Args:
        headers: Request headers dictionary
        
    Returns:
        User identity dictionary with userId, email, name, etc.
    """
    oidc_data = headers.get('x-amzn-oidc-data')
    oidc_identity = headers.get('x-amzn-oidc-identity')
    
    # Try to decode the JWT from x-amzn-oidc-data header
    if oidc_data:
        try:
            # JWT structure: header.payload.signature
            # We only need the payload (middle part)
            parts = oidc_data.split('.')
            if len(parts) >= 2:
                # Add padding if needed for base64 decoding
                payload_b64 = parts[1]
                padding = 4 - len(payload_b64) % 4
                if padding != 4:
                    payload_b64 += '=' * padding
                    
                payload = json.loads(base64.b64decode(payload_b64).decode('utf-8'))
                return {
                    'user_id': payload.get('sub') or oidc_identity,
                    'email': payload.get('email'),
                    'name': payload.get('name'),
                    'given_name': payload.get('given_name'),
                    'family_name': payload.get('family_name'),
                    'picture': payload.get('picture'),
                    'is_local_dev': False
                }
        except Exception as e:
            print(f'Failed to decode OIDC data: {e}')
    
    # Fallback: use identity header if JWT decode failed
    if oidc_identity:
        return {
            'user_id': oidc_identity,
            'email': None,
            'name': None,
            'is_local_dev': False
        }
    
    # Fallback for local development (no ALB headers)
    return {
        'user_id': 'local-dev-user',
        'email': 'dev@localhost',
        'name': 'Local Developer',
        'given_name': 'Local',
        'family_name': 'Developer',
        'is_local_dev': True
    }


def get_user_display_name(user: Dict[str, Any]) -> str:
    """
    Get user display name with graceful fallback.
    
    Args:
        user: User dictionary from extract_user_identity
        
    Returns:
        Display name string
    """
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

def get_current_user_fastapi():
    """
    FastAPI dependency for getting current user.
    
    Usage:
        from fastapi import Depends
        from middleware.user_identity import get_current_user
        
        @app.get("/profile")
        def profile(user: dict = Depends(get_current_user)):
            return {"name": user["name"]}
    """
    from fastapi import Request, Depends
    
    def _get_user(request: Request) -> Dict[str, Any]:
        headers = dict(request.headers)
        return extract_user_identity(headers)
    
    return _get_user


# For FastAPI - import this
try:
    from fastapi import Request, Depends
    
    def get_current_user(request: Request) -> Dict[str, Any]:
        """FastAPI dependency for getting current user."""
        headers = {k.lower(): v for k, v in request.headers.items()}
        return extract_user_identity(headers)
        
except ImportError:
    # FastAPI not installed
    get_current_user = None


# ============================================
# Flask Integration
# ============================================

try:
    from flask import request, g
    
    def load_user():
        """
        Flask before_request handler to load user.
        
        Usage:
            @app.before_request
            def before_request():
                load_user()
            
            @app.route("/profile")
            def profile():
                return {"name": g.user["name"]}
        """
        headers = {k.lower(): v for k, v in request.headers.items()}
        g.user = extract_user_identity(headers)
        
except ImportError:
    # Flask not installed
    load_user = None
