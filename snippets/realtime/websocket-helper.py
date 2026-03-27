"""
SNIPPET: WebSocket Helper
CATEGORY: Realtime
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Socket.IO server setup with FastAPI, OIDC auth, and room management.
    Compatible with the JS Socket.IO client (same protocol).

DEPENDENCIES:
    pip install python-socketio

USAGE:
    from websocket_helper import create_socket_app, sio

    app = FastAPI()
    socket_app = create_socket_app(app)

    # Emit events
    await sio.emit("update", {"data": "new value"}, room="project-123")

    # Run with: uvicorn main:socket_app --host 0.0.0.0 --port 3000

CLIENT (JavaScript — frontend):
    import { io } from "socket.io-client";

    const socket = io(window.location.origin, { path: "/socket.io/" });
    socket.on("update", (data) => console.log(data));
    socket.emit("join-room", "project-123");

RELATED:
    - snippets/realtime/websocket-helper.js (Node.js version)
    - snippets/auth/user-identity.py (OIDC header extraction)
"""

import os
import socketio

# ---------------------------------------------------------------------------
# Socket.IO server
# ---------------------------------------------------------------------------

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=(
        []
        if os.getenv("NODE_ENV") == "production"
        else ["http://localhost:5173", "http://localhost:8080", "http://localhost:8888"]
    ),
    ping_interval=25,
    ping_timeout=60,
)

# ---------------------------------------------------------------------------
# Auth: extract user from OIDC headers
# ---------------------------------------------------------------------------

@sio.event
async def connect(sid, environ, auth=None):
    """Authenticate on connection using OIDC headers forwarded by ALB."""
    headers = {k.lower(): v for k, v in environ.items() if isinstance(v, str)}

    oidc_id = headers.get("http_x_amzn_oidc_identity")
    email = headers.get("http_x_amzn_oidc_email", "")
    name = headers.get("http_x_amzn_oidc_name", "")

    if oidc_id:
        user = {"id": oidc_id, "email": email, "name": name}
    elif os.getenv("NODE_ENV") != "production":
        user = {"id": "dev-user", "email": "dev@local", "name": "Dev User"}
    else:
        raise socketio.exceptions.ConnectionRefusedError("Not authenticated")

    await sio.save_session(sid, {"user": user})
    print(f"[WS] Connected: {user.get('email', sid)}")

@sio.event
async def disconnect(sid):
    session = await sio.get_session(sid)
    user = session.get("user", {})
    print(f"[WS] Disconnected: {user.get('email', sid)}")

# ---------------------------------------------------------------------------
# Room management
# ---------------------------------------------------------------------------

@sio.event
async def join_room(sid, room):
    """Join a room (e.g., project ID, chat channel)."""
    if not room or not isinstance(room, str) or len(room) > 100:
        return {"error": "Invalid room name"}

    sio.enter_room(sid, room)
    session = await sio.get_session(sid)
    user = session.get("user", {})
    print(f"[WS] {user.get('email', sid)} joined room: {room}")
    return {"joined": room}

@sio.event
async def leave_room(sid, room):
    """Leave a room."""
    sio.leave_room(sid, room)
    return {"left": room}

# ---------------------------------------------------------------------------
# Create ASGI app
# ---------------------------------------------------------------------------

def create_socket_app(fastapi_app):
    """
    Wrap a FastAPI app with Socket.IO.
    Returns an ASGI app that handles both HTTP and WebSocket.

    Usage:
        app = FastAPI()
        socket_app = create_socket_app(app)
        # Run: uvicorn main:socket_app
    """
    return socketio.ASGIApp(sio, other_app=fastapi_app)