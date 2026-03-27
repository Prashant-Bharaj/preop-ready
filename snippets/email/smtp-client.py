"""
SNIPPET: SMTP Email Client
CATEGORY: Email
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Send emails via Bayer's internal SMTP server.
    Falls back to console logging when credentials are not configured (local dev).

DEPENDENCIES:
    None (uses built-in smtplib)

ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
    APP_SECRET_1  ->  SECRET_1   ->  SMTP password
    APP_SECRET_2  ->  SECRET_2   ->  SMTP username (Bayer email)

    For local development:
        SMTP_USER, SMTP_PASSWORD

USAGE:
    from smtp_client import send_email

    await send_email(
        to="recipient@bayer.com",
        subject="Hello from my app",
        html="<h1>Hello!</h1><p>This is a test email.</p>",
    )

EXAMPLE FASTAPI ROUTE:
    @app.post("/send-notification")
    async def notify(body: dict):
        await send_email(
            to=body["email"],
            subject="Your report is ready",
            html=f"<p>Download your report: <a href='{body['url']}'>here</a></p>",
        )
        return {"success": True}
"""

import os
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SMTP_CONFIG = {
    "host": os.getenv("SMTP_HOST", "exsmtp.na.bayer.cnb"),
    "port": int(os.getenv("SMTP_PORT", "25")),
    "user": os.getenv("SMTP_USER") or os.getenv("SECRET_2"),
    "password": os.getenv("SMTP_PASSWORD") or os.getenv("SECRET_1"),
}

# ---------------------------------------------------------------------------
# Send email
# ---------------------------------------------------------------------------

async def send_email(
    to: str | list[str],
    subject: str,
    html: str = None,
    text: str = None,
    cc: str | list[str] = None,
    bcc: str | list[str] = None,
    attachments: list[dict] = None,
    from_addr: str = None,
) -> dict:
    """
    Send an email via Bayer SMTP.

    Args:
        to: Recipient email(s)
        subject: Email subject
        html: HTML body (preferred)
        text: Plain text body (fallback)
        cc: CC recipient(s)
        bcc: BCC recipient(s)
        attachments: List of {"filename": str, "content": bytes, "content_type": str}
        from_addr: Sender address (defaults to SMTP_USER)

    Returns: {"success": True, "message": "Email sent"} or mock result
    """
    user = SMTP_CONFIG["user"]
    password = SMTP_CONFIG["password"]

    if not user:
        print(f"[SMTP] Mock email (not configured):")
        print(f"  To: {to}")
        print(f"  Subject: {subject}")
        print(f"  Body: {text or html or '(empty)'}")
        return {"success": True, "message": "Mock email logged to console", "mock": True}

    sender = from_addr or user

    # Build recipients list
    to_list = [to] if isinstance(to, str) else to
    cc_list = [cc] if isinstance(cc, str) else (cc or [])
    bcc_list = [bcc] if isinstance(bcc, str) else (bcc or [])
    all_recipients = to_list + cc_list + bcc_list

    # Build message
    msg = MIMEMultipart("alternative")
    msg["From"] = sender
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)

    if text:
        msg.attach(MIMEText(text, "plain"))
    if html:
        msg.attach(MIMEText(html, "html"))

    # Attachments
    if attachments:
        for att in attachments:
            part = MIMEBase("application", "octet-stream")
            part.set_payload(att["content"])
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", f'attachment; filename="{att["filename"]}"')
            msg.attach(part)

    # Send
    with smtplib.SMTP(SMTP_CONFIG["host"], SMTP_CONFIG["port"]) as server:
        if password:
            server.starttls()
            server.login(user, password)
        server.sendmail(sender, all_recipients, msg.as_string())

    return {"success": True, "message": f"Email sent to {', '.join(to_list)}"}