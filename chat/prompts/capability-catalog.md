# Platform Capability Catalog (user-facing)

What the platform can wire up out of the box. The Understanding Agent uses this list to proactively offer capabilities the user didn't mention but might benefit from. Phrased for non-technical users.

Each capability has:
- **Name** — short user-facing label
- **What it does** — one sentence the user would understand
- **When to offer** — signals that suggest it's worth bringing up
- **Maps to flag** — internal flag the Contract Agent will set when accepted

---

## Identity & access

### user_management
- **What it does:** Single sign-on so people log in with their company account; tracks who's using the app.
- **When to offer:** Whenever the app stores anything per-person, has personal views, or anyone besides the user themselves should see different things.
- **Maps to flag:** `has-users`

### admin_dashboard
- **What it does:** A separate admin area where designated managers/admins can manage data, users, and settings the rest of the team can't.
- **When to offer:** When the request hints at oversight, approval, "for HR / finance / leadership", "moderation", "admin", "manager review".
- **Maps to flag:** `has-admin`

### audit_logging
- **What it does:** Records who did what and when, so you can review activity later for compliance or troubleshooting.
- **When to offer:** Compliance-flavored language, regulated industries, sensitive data, "audit", "review", "track changes".
- **Maps to flag:** `has-admin` (delivered as part of admin scope)

---

## Data & document sources

### sharepoint_integration
- **What it does:** Pull documents and files from your SharePoint sites and Teams libraries.
- **When to offer:** When the user mentions SharePoint, Teams sites, shared drives, "where our docs live", policy libraries.
- **Maps to flag:** `sharepoint`

### snowflake_queries
- **What it does:** Run queries against your Snowflake warehouse and show the results in the app.
- **When to offer:** When the user mentions Snowflake, data warehouse, KPI dashboards on top of existing data, "the numbers we already have."
- **Maps to flag:** `snowflake`

### file_uploads
- **What it does:** Let users upload files (PDFs, images, docs) — held in memory for processing during the session, not permanently stored.
- **When to offer:** Anytime the user wants to "submit", "attach", "upload" something. Worth noting the no-persistent-storage caveat.
- **Maps to flag:** `file-uploads`

---

## Communication & notifications

### email_notifications
- **What it does:** Send emails when something happens in the app (e.g., new submission, approval needed, status change).
- **When to offer:** When the user describes workflows that span time / involve multiple people who shouldn't have to keep checking the app: approvals, escalations, decisions, deadlines, alerts.
- **Maps to flag:** `notifications-email`

### realtime_updates
- **What it does:** Live updates so multiple people see changes immediately without refreshing.
- **When to offer:** Collaboration features, presence, "see what teammates are doing", live dashboards.
- **Maps to flag:** `real-time`

---

## AI features

### ai_chat
- **What it does:** A chatbot interface backed by Bayer's MGA platform — answers questions in plain language.
- **When to offer:** Anytime the user wants a "chatbot", "Q&A", "assistant that answers questions", or LLM-style interactions.
- **Maps to flag:** `ai-chat`

### ai_rag_over_documents
- **What it does:** AI that answers questions using the user's documents as the source of truth — semantic search + summarized answers with citations.
- **When to offer:** When the user describes "ask questions about our policies/docs/procedures", "find info in our knowledge base", "search but smarter", "AI that knows our content".
- **Maps to flag:** `ai-rag` (plus implies vectordb scope)

### ai_text_classification_extraction
- **What it does:** AI that extracts structured information or classifies content from large bodies of text (contracts, reports, etc.).
- **When to offer:** When user describes reviewing many similar documents, "find clauses", "extract key terms", "spot unusual things".
- **Maps to flag:** `ai-chat` (delivered as a backend-side AI call with structured prompts)

---

## Output & reporting

### csv_export
- **What it does:** Let users (typically admins) download data as CSV for offline analysis or sharing.
- **When to offer:** When user mentions "export", "CSV", "spreadsheet", "send to finance/HR", or reporting workflows.
- **Maps to flag:** `exports-csv`

### in_app_search
- **What it does:** Search bar with filters and sorting across the app's own data — fast, structured search.
- **When to offer:** Any list-heavy app where users need to find specific records.
- **Maps to flag:** `search-ui`

---

## Configuration

### app_settings_page
- **What it does:** An admin page for changing runtime settings (e.g., thresholds, feature toggles, email templates) without redeploying.
- **When to offer:** When the user mentions "configure", "tune", "preferences", "make it adjustable", or describes settings that might change post-launch.
- **Maps to flag:** `app-settings`

### cors_proxy
- **What it does:** Lets the app call external APIs that would otherwise be blocked by the browser.
- **When to offer:** Rarely — only when user explicitly mentions calling external services from the frontend, or when an external integration won't work directly.
- **Maps to flag:** `cors-proxy`

---

## What we DON'T offer (out of scope — don't suggest)

- Mobile native apps (iOS / Android) — only responsive web
- Real-time video / audio
- Custom hardware integration
- Multi-region deployment
- Custom auth providers (we use ALB OIDC, fixed)
- Anything requiring on-prem database hosting other than the standard Postgres + pgvector

If the user asks for one of these, the understanding agent should respectfully note it's outside the platform's scope and ask what core problem they're trying to solve so we can suggest a different approach.

---

## Hybrid module eligibility (for Understanding Agent signal detection)

Capabilities that trigger hybrid module invocation at build time. The Understanding Agent should emit the corresponding `hybrid_signals` field in the brief when these capabilities are detected.

| Capability | Signal | Module triggered |
|---|---|---|
| `ai_integration` | `has_llm_at_runtime: true` | synthesis |
| `content_generation` | `has_dynamic_content: true` | synthesis |
| `compliance_sensitive` | `has_compliance_risk: true` | policy-checker |
| `domain_research` | `has_exploratory_requirement: true` | retrieval + synthesis |

**Signal detection keywords:**
- `has_llm_at_runtime`: user says "call AI", "generate with AI", "use LLM", "call the model", "GPT-powered", "AI that writes", "ask the AI to"
- `has_dynamic_content`: output depends on user input at runtime ("based on what category I pick", "generate different content per user", "personalized for each user")
- `has_compliance_risk`: regulated domain keywords — medical, healthcare, health, doctor, patient, clinic, hospital, children, minors, COPPA, finance, financial, investment, legal, law, attorney
- `has_exploratory_requirement`: vague or research-like framing — "something like ChatGPT", "I'm not sure exactly", "help me figure out", "explore options", "research-style", "discovery"