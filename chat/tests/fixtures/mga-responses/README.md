# MGA response fixtures

Canonical recorded responses from each MGA assistant for the integration
tier. Loaded by `tests/util/mga-mock.js` to stub `callMgaAssistant`.

## Fixture file shape

```json
{
  "assistantKey": "router|orchestrator|investigator|subagent-<scope>|...",
  "scenarioName": "iterate-cosmetic-frontend",
  "schemaVersion": 1,
  "response": {
    "completionText": "...",
    "usage": { "promptTokens": N, "completionTokens": N, "cachedTokens": N },
    "model": "claude-opus-4-7",
    "conversationId": "<deterministic-uuid>"
  },
  "capturedFrom": "manual|live|run-log",
  "capturedAt": "2026-05-17T..."
}
```

## Field-usage subset — what the harness actually reads

The mock layer returns `response.*` directly to the harness's downstream
code. The harness consumes only:

- **`response.completionText`** — surfaced as `content` from
  `callMgaAssistant`. Every downstream parser (router JSON validator,
  subagent XML tool extractor, investigator JSON extractor) reads this.
- **`response.conversationId`** — surfaced as `conversationId`. Used by the
  harness to thread continuation across turns.
- **`response.usage`** — surfaced as `usage`. Telemetry layer reads
  `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`
  for cost accounting. Fixtures emit the OpenAI-shape `prompt_tokens` /
  `completion_tokens` keys (the live MGA endpoint emits this shape too).
- **`response.model`** — surfaced as `model`. Cost ledger uses for pricing
  lookup; fine to keep as a string label that matches `chat/server/util/pricing.js`.

Other top-level fields (`assistantKey`, `scenarioName`, `schemaVersion`,
`capturedFrom`, `capturedAt`) are documentation for operators and the drift
detector. The runtime never reads them.

## Authoring rules

- **Don't fabricate fields the harness doesn't use.** Keep the response
  object lean — only the four read-keys above.
- **Match downstream parser expectations.** Router fixtures emit the
  4-action JSON envelope (`{action, ...}`) verbatim because
  `chat/server/agent/planner/router.js` runs `JSON.parse` on it. Subagent
  fixtures emit XML tool calls + `<attempt_completion>` because the
  agent loop's XML extractor (chat/server/agent/cline-derived/) parses
  exactly that.
- **Keep scenarios self-describing in the filename.** Drift detection
  in `chat/scripts/refresh-mga-fixtures.js --check` reports per-fixture;
  a name like `iterate-cosmetic-frontend.json` is searchable.
- **Don't capture from prod.** Run captures against the dev/spike MGA
  tenant only — production tenant has real user data in conversation
  histories.

## Refresh workflow

```bash
# Check whether checked-in fixtures still match what MGA emits today:
npm run fixtures:check

# Intentionally refresh after prompt changes:
npm run fixtures:refresh   # writes new responses to fixture files
git diff chat/tests/fixtures/mga-responses/  # inspect
# commit when satisfied
```

See `chat/scripts/refresh-mga-fixtures.js` header for the full operator
workflow + drift-detection rules.
