# Brief Schema — handoff from Understanding Agent → Contract Agent

The Understanding Agent emits this when ready. The Contract Agent receives it verbatim and emits the full plan (data_model, api_contract, etc.) without asking further questions.

## Schema

```json
{
  "ready": true,
  "intent": "1-sentence plain-English summary of what the user wants built",
  "archetype": "crud-app | landing | content-site | dashboard | form-tool | collab-tool | search-tool | ai-tool | migration",
  "entities": ["..."],
  "user_roles": ["..."],
  "key_workflows": ["..."],
  "stack_signals": {
    "backend_language": "node | python",
    "explicit_user_choice": false
  },
  "explicit_features": ["..."],
  "capabilities_offered": {
    "accepted": ["..."],
    "declined": ["..."],
    "user_didnt_choose": ["..."]
  },
  "flags": ["..."],
  "notes_for_contract_agent": "Free-text any contextual decisions the user made that the contract agent should respect (specific terminology, naming preferences, etc.). May be empty string."
}
```

## Field reference

### `ready` (boolean, required)
- `true` — gathering is complete, this brief is final, pass to contract agent
- `false` — still asking the user; this shape is NOT emitted, see clarify path instead

### `intent` (string, required, 1 sentence)
Plain English. Captures the *what*, not the *how*. The summary the user would recognize as "yes that's what I asked for."

Examples:
- *"A search tool for employees to find policies across SharePoint sites."*
- *"A request submission and approval workflow with email notifications and CSV export."*

### `archetype` (string, required)
One of the 9 valid values. Pick the closest match. This anchors what scopes are minimally needed.

| archetype | scopes typically needed |
|---|---|
| `landing` | frontend only |
| `crud-app` | db + be + fe + integration |
| `content-site` | db + be + fe + integration |
| `dashboard` | db + be + fe + integration |
| `form-tool` | be + fe + integration (db only if storing) |
| `collab-tool` | db + be + fe + integration |
| `search-tool` | db + be + fe + integration (+ vectordb if semantic) |
| `ai-tool` | vectordb + db + be + fe + integration |
| `migration` | matches source stack |

### `entities` (string[], required)
Named things the system tracks. E.g., `["policies", "users", "departments"]`. Plural, lowercase, business language. Drives table names.

### `user_roles` (string[], required)
Distinct user types. E.g., `["employees", "admins"]`. Empty array if no auth.

### `key_workflows` (string[], required)
Sentences describing what users DO. E.g., `["search for a policy by question", "admin syncs SharePoint sources nightly", "audit who searched what"]`. Drives endpoints + business logic triggers.

### `stack_signals`
- `backend_language`: `node` is the default. Only `python` if user explicitly named Python OR requested ML/scientific workloads.
- `explicit_user_choice`: `true` if user named the language; `false` if it's the default.

### `explicit_features` (string[])
Features the user explicitly asked for, in plain English. E.g., `["search across SharePoint", "audit log of every query", "export results to CSV"]`.

### `capabilities_offered`
What the Understanding Agent proactively offered from the capability catalog:
- `accepted`: catalog keys the user said yes to (e.g., `["sharepoint_integration", "audit_logging"]`)
- `declined`: catalog keys the user said no to
- `user_didnt_choose`: catalog keys offered but user didn't answer (treat as decline by default)

### `flags` (string[], required)
The flags array the planner emits. Should be the union of:
- Flags implied by `archetype`
- Flags implied by `entities`/`user_roles` (e.g., user_roles non-empty → `has-users`)
- Flags mapped from `capabilities_offered.accepted` (see catalog)
- Flags from `explicit_features`

The Contract Agent uses this as authoritative — don't re-derive.

### `notes_for_contract_agent` (string)
Any free-form context worth preserving. Examples:
- *"User specifically wants 'queries' table named 'searches' instead — preserve their terminology."*
- *"User said 'just internal users for now' so don't add external-user features."*
- Empty string when nothing notable.

## Example brief

For the prompt: *"Our employees frequently struggle to find the latest version of internal policies..."*

```json
{
  "ready": true,
  "intent": "AI-powered search tool for internal policies and procedures across SharePoint sites.",
  "archetype": "ai-tool",
  "entities": ["policies", "documents", "users", "search_queries"],
  "user_roles": ["employees", "admins"],
  "key_workflows": [
    "employee searches policies in plain language and reads ranked results with citations",
    "admin manages which SharePoint sources are indexed",
    "admin reviews search analytics to identify content gaps",
    "system syncs documents from SharePoint nightly"
  ],
  "stack_signals": {
    "backend_language": "node",
    "explicit_user_choice": false
  },
  "explicit_features": [
    "search across SharePoint sites and shared drives",
    "find authoritative versions even when documents are duplicated"
  ],
  "capabilities_offered": {
    "accepted": ["user_management", "admin_dashboard", "ai_rag_over_documents", "sharepoint_integration", "audit_logging"],
    "declined": ["email_notifications", "csv_export"],
    "user_didnt_choose": []
  },
  "flags": ["has-users", "has-admin", "ai-rag", "sharepoint"],
  "notes_for_contract_agent": "User emphasized 'authoritative version' — ensure documents table tracks last-modified and source-URL so frontend can show provenance on every result."
}
```