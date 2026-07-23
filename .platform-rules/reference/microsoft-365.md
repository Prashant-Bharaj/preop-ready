---
description: "Connect to Microsoft 365 via the platform Graph proxy: SharePoint/OneDrive files, Outlook calendar and free/busy, mail, Teams chats, people search, org chart, meetings — plus unattended/cron access"
triggers: ["SharePoint", "OneDrive", "Teams", "calendar", "Outlook", "read my mail", "send an email to a colleague", "free/busy", "people search", "org chart", "my manager", "Graph API", "Microsoft 365", "M365", "meeting"]
globs: []
---

# Microsoft 365 (Graph API — platform proxy ONLY)

⛔ **ALL Microsoft Graph access goes through the platform OBO proxy.** Never call
`graph.microsoft.com` directly, never register a per-project Entra app, never put
MSAL or a `client_secret` in an app. The proxy handles auth (OBO from the user's
platform session), consent, and token refresh — apps just name an operation.

## How to build with it

1. **READ FIRST: `snippets/auth/graph-proxy-operations.md`** — the full operations
   catalog (identity/whoami, me/manager, me/photo, people search, SharePoint/OneDrive
   fetch + url/resolve + folder/list + files/recent, calendar upcoming + getSchedule
   free/busy, mail, Teams chats, online meetings, proxied myGenAssist token/knowledge
   ops) with scope, body shape, and response shape for each.
2. **Frontend**: COPY `snippets/auth/graph-proxy-client.js` — session bootstrap from
   the `#sid=` fragment, auto-redirect to the bouncer when the session is missing and
   to the consent screen on `403 consent_required`.
3. **Backend**: COPY `snippets/auth/graph-proxy-backend.js` (Express) or `.py`
   (FastAPI/Flask) — SigV4-signs requests to the proxy with the ECS task role and
   forwards `consent_required` + `consent_url` verbatim to the client.
4. **Unattended / scheduled jobs** (no user present): COPY
   `snippets/auth/graph-proxy-offline.{js,py}` — enrolls each user's session id in
   SSM and replays it; requires `&offline=1` sign-in and per-scope consent.

## Boundaries

- "Chat with my SharePoint documents" (AI over document content) → that's the
  myGenAssist Knowledge Base with OneDrive sync, not raw Graph — see
  `.platform-rules/reference/ai-features.md`.
- Sending notification email from the app (not as the user) → Bayer SMTP,
  `snippets/email/smtp-client.{js,py}` — no Graph involved.
