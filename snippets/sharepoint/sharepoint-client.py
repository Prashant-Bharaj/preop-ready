"""
SNIPPET: SharePoint Client
CATEGORY: Microsoft 365 Integration
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Fetch files from SharePoint/OneDrive via Microsoft Graph API.
    Converts sharing URLs to Graph API download URLs.
    Falls back to mock responses when not configured (local dev).

DEPENDENCIES:
    pip install httpx

ENVIRONMENT VARIABLES:
    ENTRA_TENANT_ID — Azure AD tenant ID (will be auto-injected by platform)
    ENTRA_CLIENT_ID — Azure AD client ID (will be auto-injected by platform)

USAGE:
    from sharepoint_client import fetch_from_sharepoint, is_share_link

    # Check if URL is a SharePoint link
    if is_share_link(url):
        content = await fetch_from_sharepoint(graph_token, url)

RELATED:
    - snippets/sharepoint/sharepoint-client.js (Node.js version)
    - snippets/auth/user-identity.py (get OIDC token for Graph API)
"""

import base64
import os
import re
import httpx

# ---------------------------------------------------------------------------
# URL detection and conversion
# ---------------------------------------------------------------------------

SHARE_LINK_PATTERNS = [
    r"sharepoint\.com",
    r"1drv\.ms",
    r"onedrive\.live\.com",
    r"\.sharepoint\.com/.*/:.",
]

def is_share_link(url: str) -> bool:
    """Check if a URL is a SharePoint/OneDrive sharing link."""
    return any(re.search(p, url, re.IGNORECASE) for p in SHARE_LINK_PATTERNS)


def convert_share_link_to_graph_url(share_url: str) -> str:
    """
    Convert a SharePoint sharing URL to a Graph API download URL.
    Uses the Microsoft Shares API encoding.
    """
    # Base64-encode the URL for the Shares API
    encoded = base64.b64encode(share_url.encode()).decode()
    # Convert to URL-safe base64 and add "u!" prefix
    share_token = "u!" + encoded.rstrip("=").replace("/", "_").replace("+", "-")
    return f"https://graph.microsoft.com/v1.0/shares/{share_token}/driveItem/content"


# ---------------------------------------------------------------------------
# Fetch file from SharePoint
# ---------------------------------------------------------------------------

async def fetch_from_sharepoint(graph_token: str, url: str) -> bytes:
    """
    Download a file from SharePoint/OneDrive using a Graph API token.

    Args:
        graph_token: OAuth2 access token with Files.Read.All scope
        url: SharePoint sharing URL or direct Graph API URL

    Returns: File content as bytes

    Raises: httpx.HTTPStatusError on auth/permission/not-found errors
    """
    if not graph_token:
        if os.getenv("NODE_ENV") != "production":
            print("[SharePoint] Mock mode: no token, returning placeholder")
            return b"Mock file content - SharePoint not configured"
        raise ValueError("No Graph API token provided")

    # Convert sharing URL to Graph API URL if needed
    download_url = convert_share_link_to_graph_url(url) if is_share_link(url) else url

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(
            download_url,
            headers={"Authorization": f"Bearer {graph_token}"},
            follow_redirects=True,
        )
        response.raise_for_status()
        return response.content


async def get_file_metadata(graph_token: str, url: str) -> dict:
    """Get file metadata (name, size, type) without downloading."""
    encoded = base64.b64encode(url.encode()).decode()
    share_token = "u!" + encoded.rstrip("=").replace("/", "_").replace("+", "-")
    metadata_url = f"https://graph.microsoft.com/v1.0/shares/{share_token}/driveItem"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            metadata_url,
            headers={"Authorization": f"Bearer {graph_token}"},
        )
        response.raise_for_status()
        data = response.json()
        return {
            "name": data.get("name"),
            "size": data.get("size"),
            "mime_type": data.get("file", {}).get("mimeType"),
            "modified": data.get("lastModifiedDateTime"),
        }