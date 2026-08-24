---
name: Hybrid Module Policy
version: v1
date: 2026-06-18
status: ACTIVE — read by handoff-engine.js and execution-router.js at runtime.
purpose: |
  Defines what each specialist module is allowed to do, what it must emit,
  and what it is never permitted to do. This is the authoritative policy
  document for the hybrid module layer. All specialist implementations must
  conform to these rules.
---

## 1. OVERVIEW

The hybrid module layer consists of three specialist modules that enrich the
deterministic contract before build-dispatcher.js runs. Each module is:

- **Read-only** — no file writes, no database mutations, no state changes
- **Bounded** — max 3 hops total across all modules per build session
- **Fallback-safe** — any failure reverts to the original un-enriched contract
- **Auditable** — every call is appended to session.hybridTrace[]

---

## 2. GLOBAL DENY LIST (applies to ALL modules)

No module may ever:
- Write files to disk (no `fs.writeFile`, no `write_to_file` tool calls)
- Mutate the database (no INSERT, UPDATE, DELETE, DDL)
- Call external APIs outside the approved MGA completions endpoint
- Read environment secrets or credentials beyond what `getCredentials()` provides
- Invoke other modules directly (all fan-out goes through handoff-engine.js)
- Modify `tasks[]` structure — only content fields (businessLogicContract, complianceNotes) may be enriched
- Exceed the per-module token budget: **4 000 completion tokens maximum**
- Run for longer than **30 seconds** (enforced by handoff-engine timeout)
- Call itself recursively or circularly

---

## 3. MODULE DEFINITIONS

### 3.1 `synthesis` — LLM Integration Designer

**Purpose:** Designs the LLM prompt templates, API endpoint specs, and content schemas
the built application will use to call an LLM at runtime. Fires when
`has_llm_at_runtime: true` or `has_dynamic_content: true`.

**Allowed tools / APIs:**
- `callMgaCompletions` via `/chat/completions` endpoint only
- Read access to `contract.businessLogicContract` (input context, read-only)

**Input shape (what it receives from execution-router):**
```json
{
  "intent": "string — the application's purpose from the brief",
  "context": [ { "topic": "string", "summary": "string" } ],
  "expectedOutput": "string — description of what the LLM integration should produce"
}
```

**Required output shape:**
```json
{
  "promptTemplate": "string — the prompt the app sends to the LLM at runtime, with {placeholders}",
  "apiSpec": {
    "method": "POST",
    "path": "/api/generate",
    "provider": "mga",
    "mgaEndpoint": "/chat/completions",
    "requestBody": { "description": "string", "fields": [] },
    "responseBody": { "description": "string", "fields": [] }
  },
  "contentSchema": {
    "description": "string",
    "fields": [ { "name": "string", "type": "string", "description": "string" } ]
  }
}
```

**Provider rule:** `apiSpec.provider` MUST always be `"mga"`. The platform never scaffolds
direct calls to OpenAI, Azure OpenAI, Anthropic, or any other external LLM. The built app's
backend proxies all LLM calls through the MGA completions endpoint using `MGA_API_KEY` from env.
The synthesis module must not override this even if the user's prompt mentions a different provider.

**Reconciliation target:** merged into `businessLogicContract` as:
- `llmIntegration` ← `promptTemplate`
- `llmApiSpec` ← `apiSpec`
- `contentSchema` ← `contentSchema`

**Failure behavior:** if output is null or JSON parse fails → module output is null →
completion-policy marks module failed → execution-router returns original contract unchanged.

---

### 3.2 `retrieval` — Domain Context Researcher

**Purpose:** Produces structured domain background that helps synthesis make better
architectural decisions. Fires when `has_exploratory_requirement: true`.
Always runs before `synthesis` when both are in modulePlan.

**Allowed tools / APIs:**
- `callMgaCompletions` via `/chat/completions` endpoint only
- Read access to `entry.input` (domain description, read-only)

**Input shape:**
```json
{
  "domain": "string — the application domain (e.g. 'healthcare scheduling')",
  "intent": "string — the application's purpose"
}
```

**Required output shape:**
```json
{
  "contextData": [
    { "topic": "string", "summary": "string", "relevance": "high" | "medium" | "low" }
  ]
}
```

Constraints:
- 3–6 items maximum in `contextData`
- No library or framework recommendations — domain facts only
- No code snippets

**Reconciliation target:** merged into `businessLogicContract.contextData`.

**Failure behavior:** same as synthesis — null output → original contract returned.

---

### 3.3 `policy-checker` — Compliance Flagger

**Purpose:** Identifies regulatory compliance concerns in the application domain
and category list. Fires when `has_compliance_risk: true`. Does NOT block
the build — it only surfaces flags for the team to review.

**Allowed tools / APIs:**
- `callMgaCompletions` via `/chat/completions` endpoint only
- Read access to `entry.input` (domain + category list, read-only)

**Input shape:**
```json
{
  "domain": "string",
  "intent": "string",
  "categories": [ "string" ]
}
```

**Required output shape:**
```json
{
  "flags": [
    {
      "category": "string — the feature or data category triggering this flag",
      "regulation": "string — e.g. HIPAA, COPPA, GDPR, CCPA, FINRA, PCI-DSS",
      "note": "string — one sentence: what to review and why (≤ 30 words)"
    }
  ]
}
```

Constraints:
- Empty `flags` array is valid (means no concerns found)
- Max 10 flags per run
- Notes must be factual and neutral — no legal advice, no "you must" language
- Only flag genuine regulatory exposure for recognised regulations

**Reconciliation target:** appended to `contract.complianceNotes` (array at contract root).
The concierge reads this to surface compliance notes to the user post-build.

**Failure behavior:** empty `flags` array on parse error (soft failure — the build
must not be blocked by a compliance-checker failure).

---

## 4. EXECUTION ORDER

When multiple modules are in `modulePlan`, handoff-engine runs them in this order:

```
retrieval  →  synthesis  →  policy-checker
```

Rationale:
- `retrieval` output feeds into `synthesis` input (contextData)
- `policy-checker` is independent and runs last (doesn't affect synthesis)
- Max 3 hops total: retrieval (1) + synthesis (2) + policy-checker (3) = exactly 3

If only a subset of modules is in the plan, the relative order above is preserved.

---

## 5. BUDGET AND LATENCY CAPS

| Module | Max completion tokens | Max wall time |
|---|---|---|
| `retrieval` | 800 | 30s |
| `synthesis` | 1 500 | 30s |
| `policy-checker` | 600 | 30s |
| **Total (all three)** | **2 900** | **90s** |

Override per-module timeout via `HYBRID_MODULE_TIMEOUT_MS` env var (applies to all modules equally).

---

## 6. TRACE REQUIREMENTS

Every specialist call MUST result in a trace entry in `session.hybridTrace[]` via
`appendTraceStep()` from `orchestrator/trace-store.js`:

```json
{
  "module": "synthesis | retrieval | policy-checker",
  "input": "string summary of what was sent (≤ 200 chars)",
  "output": "string summary of what was returned (≤ 500 chars, JSON.stringify truncated)",
  "durationMs": 1234,
  "status": "completed | failed | skipped",
  "ts": 1750000000000
}
```

Trace entries are written by `orchestrator/index.js` after each specialist returns,
not by the specialists themselves (specialists remain pure functions).

---

## 7. WHAT THIS POLICY IS NOT

- Not a rate-limiter — MGA platform enforces token quotas independently
- Not a security boundary — the MGA API key already scopes what the LLM can access
- Not a content filter — MGA platform enforces content policy at the API level
- Not a replacement for the contract validator — `hybrid-module-selection.schema.json`
  validates modulePlan shape before any module runs
