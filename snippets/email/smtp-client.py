"""
scopes: [backend]
flags: [notifications-email]
description: SMTP client (Python) for sending email via Bayer EBR (ebr.bayer.com:2525).
"""

"""
SNIPPET: SMTP Email Client (Bayer EBR)
CATEGORY: Email
LANGUAGE: Python (FastAPI)
STATUS: Ready

DESCRIPTION:
    Send emails via Bayer's External Bayer Relay (ebr.bayer.com:2525).
    The EBR is the approved method for sending @bayer.com emails from AWS.
    Falls back to console logging in development.

DEPENDENCIES:
    None (uses built-in smtplib)

ENVIRONMENT VARIABLES:
    SMTP_HOST and SMTP_PORT are automatically injected by the platform
    into every backend container — no setup required:

        SMTP_HOST  = ebr.bayer.com   (auto-injected)
        SMTP_PORT  = 2525            (auto-injected)

    EBR uses IP-based whitelisting (the AWS VPC's Central NAT Gateway
    public IPs are pre-whitelisted on the EBR side), so no SMTP
    credentials are needed.

    Default sender (optional):
        For local dev, you can name your own env var (e.g. EMAIL_SENDER)
        in `backend/.env` or docker-compose.yml.
        For prod, use the platform's generic "admin email" slot:
            Add `APP_SECRET_3` in GitHub Secrets with your @bayer.com
            sender address. It becomes `SECRET_3` in the container.
        The snippet falls back through: explicit from_addr arg ->
        EMAIL_SENDER env var -> SECRET_3.

SENDER ADDRESS REQUIREMENT:
    The "from_addr" MUST be a valid @bayer.com address. EBR will reject
    emails with non-Bayer sender addresses.

    Two valid sender patterns:

    1. "Send as the logged-in user" — for emails triggered by a user
       action (e.g. "send this report to a colleague"). Use the user's
       email from the OIDC token (x-amzn-oidc-data header). See the
       auth/user-identity snippet for details.

       Pros: clean audit trail (real sender), no extra setup.
       Cons: requires a logged-in user; can't be used for system jobs.

    2. "Send from a shared mailbox" — for app-generated emails not tied
       to a specific user (notifications, alerts, cron job output, etc.).
       Requires a shared mailbox provisioned by the Bayer Messaging team
       via ServiceNow (Order Something -> Messaging Engineer/Analyst).
       Common pattern: noreply-<project>@bayer.com.

       Pros: works for system-generated email; clear "from app" identity.
       Cons: one-time provisioning request needed.

TLS:
    EBR requires StartTLS with TLSv1.2 or higher.

USAGE:
    from smtp_client import send_email

    # Pattern 1: send as the logged-in user (from OIDC)
    await send_email(
        from_addr=user_email,  # extracted from x-amzn-oidc-data
        to="colleague@bayer.com",
        subject="Hello from my app",
        html="<h1>Hello!</h1><p>This is a test email.</p>",
    )

    # Pattern 2: send from a shared mailbox (provisioned via Messaging team)
    await send_email(
        from_addr="noreply-myproject@bayer.com",
        to="user@bayer.com",
        subject="Your weekly report is ready",
        text="Daily digest of your project activity.",
    )

EXAMPLE FASTAPI ROUTE:
    @app.post("/send-notification")
    async def notify(body: dict, request: Request):
        user_email = get_user_email_from_oidc(request)  # from auth snippet
        await send_email(
            from_addr=user_email,
            to=body["email"],
            subject="Your report is ready",
            html=f"<p>Download your report: <a href='{body['url']}'>here</a></p>",
        )
        return {"success": True}
"""

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SMTP_CONFIG = {
    "host": os.getenv("SMTP_HOST", "ebr.bayer.com"),
    "port": int(os.getenv("SMTP_PORT", "2525")),
}

# ---------------------------------------------------------------------------
# Send email
# ---------------------------------------------------------------------------

async def send_email(
    to: str | list[str],
    subject: str,
    from_addr: str = None,
    html: str = None,
    text: str = None,
    cc: str | list[str] = None,
    bcc: str | list[str] = None,
    attachments: list[dict] = None,
) -> dict:
    """
    Send an email via Bayer's External Bayer Relay (EBR).

    Args:
        to: Recipient email(s)
        subject: Email subject
        from_addr: Sender address (must be @bayer.com). If not provided,
            falls back to SMTP_DEFAULT_FROM env var (project-wide default).
        html: HTML body (preferred)
        text: Plain text body (fallback)
        cc: CC recipient(s)
        bcc: BCC recipient(s)
        attachments: List of {"filename": str, "content": bytes, "content_type": str}

    Returns: {"success": True, "message": "Email sent"} or mock result
    """
    # Sender resolution order: explicit arg -> local-dev env var -> platform secret slot
    sender = from_addr or os.getenv("EMAIL_SENDER") or os.getenv("SECRET_3")
    if not sender:
        raise ValueError(
            'send_email: sender required (must be a @bayer.com address). '
            "Pass `from_addr` per-call, set EMAIL_SENDER env var for local dev, "
            "or add APP_SECRET_3 (@bayer.com address) in GitHub Secrets for prod."
        )
    if not sender.lower().endswith("@bayer.com"):
        raise ValueError(
            f'send_email: sender must be a @bayer.com address (got "{sender}"). '
            "EBR will reject other senders."
        )

    # Dev mock — log emails to console instead of sending
    if os.getenv("ENV", "").lower() in ("development", "dev", "local"):
        print(f"[SMTP] Mock email (development):")
        print(f"  From: {from_addr}")
        print(f"  To: {to}")
        print(f"  Subject: {subject}")
        print(f"  Body: {text or html or '(empty)'}")
        return {"success": True, "message": "Mock email logged to console", "mock": True}

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

    # Send via EBR with StartTLS (TLSv1.2+)
    tls_ctx = ssl.create_default_context()
    tls_ctx.minimum_version = ssl.TLSVersion.TLSv1_2

    with smtplib.SMTP(SMTP_CONFIG["host"], SMTP_CONFIG["port"], timeout=15) as server:
        server.ehlo()
        server.starttls(context=tls_ctx)
        server.ehlo()
        server.sendmail(sender, all_recipients, msg.as_string())

    return {"success": True, "message": f"Email sent to {', '.join(to_list)}"}
