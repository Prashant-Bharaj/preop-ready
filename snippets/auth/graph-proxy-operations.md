---
scopes: [backend, frontend]
flags: [microsoft-graph, sharepoint, onedrive, calendar, mail, people, teams]
description: Operations catalog for the Microsoft Graph platform OBO proxy -- every op, scope, body shape, response shape. Read this before writing Graph code.
---

# Microsoft Graph -- Platform Proxy Operations Catalog

User apps DO NOT call `graph.microsoft.com` directly and DO NOT register their
own Entra app. Everything routes through the platform OBO proxy at
`api.vibe.intranet.cnb/v1/platform/graph/<op>`.

## When to read this

Before writing any code that touches Microsoft 365 data:
- SharePoint files / OneDrive
- Mail (inbox)
- Calendar
- People search / directory lookup
- User profile / manager / photo

If the user wants something Graph supports but NOT in the catalog below,
surface that as a platform gap rather than building a workaround.

## Companion snippets (use these, don't roll your own)

| Snippet | Layer | Path |
|---|---|---|
| `graph-proxy-client.js` | Frontend (vanilla JS / React / Vue / any) | `snippets/auth/graph-proxy-client.js` |
| `graph-proxy-backend.js` | Backend (Node.js + Express) | `snippets/auth/graph-proxy-backend.js` |
| `graph-proxy-backend.py` | Backend (Python + FastAPI / Flask) | `snippets/auth/graph-proxy-backend.py` |

The frontend snippet handles session bootstrap, auto-redirect to the bouncer
on missing session, auto-redirect to the consent page on `403 consent_required`,
and replay of pending actions after a redirect-return.

The backend snippet handles SigV4-signing requests to the platform proxy with
the ECS task role, forwarding `X-Platform-Session` from frontend → platform,
and propagating proxy errors in a structured shape the frontend understands.

## Required env vars (auto-injected by platform deploy)

The platform deploy workflow injects these on every project container:

- `PLATFORM_GRAPH_PROXY_URL` -- AWS-native VPC-endpoint URL for backend calls
- `PLATFORM_GRAPH_AUTH_START_URL` -- custom-domain URL for browser redirects
- `AWS_REGION` (ECS sets this)

User apps do NOT set `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, or any
Entra-related env var. The platform owns those centrally.

## Operations catalog

All operations: `POST /platform/graph/<op>` with `X-Platform-Session: <sid>`
header. Body is JSON. Response is JSON.

### whoami

- **Scope:** `User.Read`
- **Body:** `{}` (no inputs)
- **Returns:** Microsoft Graph `/me` payload -- `displayName`, `mail`,
  `userPrincipalName`, `jobTitle`, `officeLocation`, etc.
- **Use when:** rendering a user badge, branching on identity.

### me/manager

- **Scope:** `User.Read`
- **Body:** `{}`
- **Returns:** `{id, displayName, mail, userPrincipalName, jobTitle,
  department, officeLocation}` -- the user's directory manager.
- **404 path:** if the user has no manager set; treat as "no manager".

### me/photo

- **Scope:** `User.Read`
- **Body:** `{}`
- **Returns:** `{hasPhoto: true, mimeType: "image/jpeg", data_base64: "..."}`
  OR `{hasPhoto: false}` (HTTP 200 in both cases -- don't special-case 404).
- **Use when:** rendering an avatar. Inline base64 avoids a round-trip.

### users/search

- **Scope:** `People.Read`
- **Body:** `{query: "ana garcia", limit?: 25, from?: 0}` -- `query` is
  required; `limit` 1..50 default 25; `from` is pagination offset.
- **Returns:**
  ```json
  {
    "results": [
      {"id": "...", "displayName": "Ana Garcia",
       "mail": "ana.garcia@bayer.com", "userPrincipalName": "...",
       "givenName": "Ana", "surname": "Garcia", "jobTitle": "...",
       "department": "...", "companyName": "Bayer", "officeLocation": "..."}
    ],
    "total": 42,
    "moreResultsAvailable": true
  }
  ```
- **Use when:** "pick a colleague" UI. Microsoft ranks by collaboration
  relevance (people you actually work with appear first).
- **Privacy:** the query string is NOT logged (may contain PII).

### sharepoint/fetch

- **Scope:** `Files.Read.All`
- **Body:** `{url: "<full SharePoint/OneDrive sharing URL>"}`
- **Returns:** `{name, mimeType, size, download_url}`. `download_url` is
  Microsoft's pre-authenticated short-lived URL (~1 hour); fetch it directly
  with no auth header. This bypasses Lambda's 6MB response cap.
- **Use when:** fetching any Excel / Word / PDF / etc. from a shared
  SharePoint URL.

### files/recent

- **Scope:** `Files.Read.All`
- **Body:** `{limit?: 25}` (1..50)
- **Returns:** `{items: [{id, name, mimeType, size, lastModifiedDateTime,
  webUrl, downloadUrl, isFolder}]}`
- **Use when:** showing the user's most-recent OneDrive items (e.g. a
  "pick a file" UI without making the user paste a URL).

### sharepoint/url/resolve

- **Scope:** `Files.Read.All`
- **Body:** `{url: "<SharePoint/OneDrive sharing URL>"}`
- **Returns:** `{item_id, drive_id, site_id, name, webUrl, size, type, isFolder}`
- **Use when:** you need the Graph identifiers behind a sharing URL -- e.g.
  resolve a link, then list a folder or address the file by id.

### sharepoint/folder/list

- **Scope:** `Files.Read.All`
- **Body:** `{url: "<folder sharing URL>", limit?: 100}` (1..200)
- **Returns:** `{items: [{id, name, mimeType, size, lastModifiedDateTime,
  webUrl, downloadUrl, isFolder}]}`
- **Use when:** listing the contents of a shared SharePoint/OneDrive folder
  (not just a single file).

### calendar/upcoming

- **Scope:** `Calendars.Read`
- **Body:** `{limit?: 10}` (1..50)
- **Returns:** `{events: [{id, subject, start, end, timeZone, location,
  organizer: {name, email}, isOnlineMeeting, joinUrl, isCancelled, webLink}]}`
- **Window:** 30 days forward from now. Recurring series are expanded into
  individual occurrences (uses `/me/calendarView`, not `/me/events`).

### mail/recent

- **Scope:** `Mail.ReadWrite` (admin-consented; this operation only reads)
- **Body:** `{limit?: 10}` (1..50)
- **Returns:** `{messages: [{id, subject, from: {name, email},
  receivedDateTime, bodyPreview, isRead, hasAttachments, importance, webLink}]}`
- **Order:** newest first.

### teams/chats/list

- **Scope:** `Chat.ReadBasic`
- **Body:** `{limit?: 20}` (1..50)
- **Returns:** `{chats: [{id, topic, chatType, webUrl, lastUpdatedDateTime,
  members: [{displayName, email}]}]}`
- **Order:** most recently active first.
- **Use when:** showing the user's Teams chats (e.g. a chat picker).

### teams/chats/messages

- **Scope:** `Chat.Read`
- **Body:** `{chatId: "<id from teams/chats/list>", limit?: 20}` (1..50)
- **Returns:** `{messages: [{id, from, body, contentType, createdDateTime}]}`
- **Order:** newest first.
- **Use when:** reading the messages of a specific Teams chat.

### onlineMeetings/createOrGet

- **Scope:** `OnlineMeetings.ReadWrite`
- **Body:** `{externalId?: "<your stable id>", subject?, startDateTime?,
  endDateTime?}` (ISO 8601 times)
- **Returns:** `{id, joinUrl, subject, startDateTime, endDateTime}`
- **Use when:** creating a Teams meeting link for the user. Pass a stable
  `externalId` to make retries idempotent (createOrGet); omit it for a plain
  one-off create.

## Auth + consent flow

The proxy enforces **two gates** on every `/platform/graph/<op>` call:

1. **Session binding (PR2.1):** the user's session id (sid) is bound to the
   project subdomain that initiated sign-in. A sid created at
   `oceanic-helper.vibe.intranet.cnb` cannot be replayed against
   `calc-incentive.vibe.intranet.cnb`. The proxy extracts the calling
   project from the SigV4-caller's task-role ARN
   (`vibe-<project>-(task|db-task|vectordb-task)`) and 403s on mismatch.

2. **Per-(user, project, scope) consent (PR2.2):** the FIRST time a project
   tries to use a Graph scope for a given user, the proxy returns
   `403 consent_required` with a `consent_url`. The frontend snippet
   redirects the user to that URL; the user clicks Allow on the
   platform-owned consent screen; redirected back, the original call
   replays via the `stateBag` argument to `callGraph()`. Consent records
   are stored in DynamoDB with a 30-day TTL. Users can revoke at
   `https://api.vibe.intranet.cnb/platform/me/permissions?sid=<sid>`.

User apps MUST handle these two response shapes:

```json
// Stale session -> redirect to bouncer (snippet does this automatically)
{ "error": "session_expired_or_invalid", "status": 401 }
{ "error": "session_format_outdated", "status": 401 }

// Need consent -> redirect to consent_url (snippet does this automatically)
{ "error": "consent_required",
  "consent_url": "https://api.../platform/auth/consent?...",
  "project": "<project>",
  "scope": "<scope>",
  "status": 403 }
```

If you copied the canonical snippets, you don't have to write this branching
yourself -- the snippets handle both.

## Adding a new operation

Operations live in the smart-aws repo
(`configuration/lambda/graph-proxy/index.py`). Adding one requires:

1. Author a new `@operation("/platform/graph/<path>", scope="<Graph.Scope>")`
   handler in `index.py`.
2. Verify the scope is in `SCOPE_DESCRIPTIONS` in that file (or add a
   human-readable line) so the consent screen explains the request.
3. Confirm the scope is admin-consented for the Entra app
   (`bayergroup.onmicrosoft.com/vibe-graph-proxy`). If not, file a ticket
   with Bayer Entra admins before merging.
4. PR to `prod-*`; CODEOWNERS auto-requests review on
   `configuration/lambda/graph-proxy/**`.
5. After deploy, add a row to this catalog so user apps know it exists.

## Common mistakes to avoid

- Calling `graph.microsoft.com` directly from a project backend. NO. Always
  through the platform proxy. The OBO + scope narrowing is the whole point.
- Holding a Graph token in the project backend. NO. The platform proxy
  performs OBO server-side; the project never holds tokens.
- Asking the user to install MSAL or register an Entra app. NO. One platform
  Entra app, centrally managed.
- Hardcoding the platform URL. NO. Use `PLATFORM_GRAPH_PROXY_URL` env var.
- Ignoring `403 consent_required` (showing "Access denied" to the user). NO.
  Redirect them to `consent_url` so they can grant permission.

## Related docs

- `snippets/auth/graph-proxy-client.js` -- canonical frontend code.
- `snippets/auth/graph-proxy-backend.{js,py}` -- canonical backend code.
- Smart-aws repo design docs (in `docs/proposals/`):
  - `platform-obo-graph-proxy.md` -- design + flow
  - `platform-obo-graph-proxy-flows.md` -- Mermaid sequence diagrams
  - `security-hardening.md` -- threat model + controls matrix
