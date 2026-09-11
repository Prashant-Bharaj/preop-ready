# Custom Agent

In-process LLM loop. Talks to MGA's `/chat/agent` assistant endpoint via `callMgaAssistant` (`llm/`), reuses `conversation_id` across turns so MGA holds the conversation history, and parses XML-in-text tool calls with the parser in `cline-derived/xml-parser.js` (Apache-2.0 port — see [`cline-derived/README.md`](./cline-derived/README.md) for attribution).

This is THE agent in the harness. There is no other dispatch target; `USE_CUSTOM_AGENT` is gone, the Cline subprocess integration is retired. For historical context on the prior Cline-based agent and why it was retired, see [`docs/retired/RETIRED_CLINE_INTEGRATION.md`](../../../docs/retired/RETIRED_CLINE_INTEGRATION.md).

## Where it fits in the harness flow

```
user prompt
  → Router (BD Task Router) — emits structured plan as JSON contract
  → Build dispatcher (deterministic JS — `coordinator/build-dispatcher.js`)
      → spawn_phase_agent / spawn_phase_agent_background → THIS agent (scope-specialised subagents)
  → Deterministic build summary (`coordinator/build-summary.js`) → state.md + build report
  → cross-scope reconciler (deterministic regex + targeted MGA judge for ambiguous extras)
  → tryAutoStartApp (`session/docker-orchestration.js`): `docker-compose build` → `up` → /health probes
```

The agent runs scope-tagged work via `runCustomAgent(sessionId, prompt, { phase: PHASES.SUBAGENT, scope, conversationId, ... })`. The build dispatcher's spawn handlers (in `tools/phase-tools.js`) invoke it with the scope-specialised subagent assistant (`subagentBackendAssistantId`, `subagentFrontendAssistantId`, etc. — see [`../config/assistants.json`](../config/assistants.json)). A "fallback" raw-message dispatch in `session/routes.js` runs the agent with the `coderAssistantId` when the router is unavailable. The legacy LLM orchestrator was retired in favour of the deterministic dispatcher; per-session conversational handling during a build runs through the concierge (`agent/concierge/`).

## Configuration

Assistant IDs are resolved from [`../config/assistants.json`](../config/assistants.json) (tracked, shared across codespaces) with env-var override per `loadAssistantIds()` in [`../config/assistant-ids.js`](../config/assistant-ids.js):

| Assistant | Env var | Purpose |
|---|---|---|
| `coderAssistantId` | `CODER_ASSISTANT_ID` | Generic single-scope fallback |
| `subagentBackendAssistantId` | `SUBAGENT_BACKEND_ASSISTANT_ID` | Backend phase agent |
| `subagentFrontendAssistantId` | `SUBAGENT_FRONTEND_ASSISTANT_ID` | Frontend phase agent |
| `subagentDatabaseAssistantId` | `SUBAGENT_DATABASE_ASSISTANT_ID` | Database phase agent |
| `subagentVectordbAssistantId` | `SUBAGENT_VECTORDB_ASSISTANT_ID` | Vectordb phase agent |
| `subagentIntegrationAssistantId` | `SUBAGENT_INTEGRATION_ASSISTANT_ID` | Integration phase agent |

Per-codespace credentials (`apiKey`, `baseUrl`) live in `.chat/secrets.json`.

## Files

```
agent/
├── README.md                  (this file)
├── BACKLOG.md                 (historical paper cuts — marked STALE; skim with skepticism)
├── TEST_PROMPTS.md            (smoke scenario prompts)
├── agent.js                   (1396 lines — main loop; monolithic by choice)
├── orchestration-stash.js     (per-session shared state across spawns)
├── prompt-builder/            (prompt assembly — core.js entry points + sections/)
├── context/                   (env + flag + frozen-endpoint history)
├── compaction/                (history + token + rotation, incl. run-logger)
├── llm/                       (MGA platform interaction — callMgaAssistant, ...)
├── loop/                      (phase gate + permission cascade)
├── planner/                   (planning-stage agents: router.js, router-judge.js, prompt-writer.js. Dir name reflects the planning STAGE; the routing agent itself is "router")
├── stop-hooks/                (post-completion validators + error formatting)
├── tools/                     (tool dispatch + handler implementations)
├── cline-derived/             (XML parser — Apache-2.0 port; sole consumer is agent.js)
├── __tests__/                 (unit tests)
└── run-logs/                  (structured per-scenario run logs)
```

Plus:
- [`../mcp/handlers.js`](../mcp/handlers.js) — pure-function MCP tool handlers, imported in-process.

## Smoke test (regression harness)

`tests/smoke/smoke.js` is a real-call regression script. Two modes mixed in one harness:

**Single-scope scenarios (t1–t5, etc.)** — call `runCustomAgent` directly, bypassing the router/clarify/plan/fan-out flow. Fast (~15-30s each), cheap (~20-35K tokens each). Cover the agent's per-turn mechanics (build, continuation, infeasible-task gracefulness, rotation, frontend scaffolding).

**Multi-scope scenarios (t6+, t11, t39, etc.)** — boot the chat server as a subprocess on a free port, drive the full pipeline via HTTP+Socket.IO (router → clarify → plan-confirm → parallel scope fan-out → cross-scope reconciler → `docker-compose up`). Realistic production-shape coverage. ~3-5 min each, ~150-300K tokens each.

Multi-scope scenarios auto-respond to clarification questions with "first option for everything" and confirm whatever plan the router produces. Pass criterion is `Auto-start: compose up (ok=true)` in the subprocess's stdout.

Run before landing changes to any of:

- `chat/server/agent/*`
- `chat/server/agent/prompt-builder/*` (entry: `prompt-builder/core.js`)
- `chat/server/session/*` (entry: `session/routes.js`)
- The Coder / Summarizer / Orchestrator / Subagent MGA system prompts

```sh
cd chat
npm run smoke                          # all scenarios (~10+ min, ~1M+ tokens)
npm run smoke -- --only=t1-backend-health        # fast single-scope
npm run smoke -- --only=t11-backend-db-multi     # one multi-scope
npm run smoke -- --list                          # list all scenarios
```

Credentials auto-load from `.chat/secrets.json` if env vars aren't set. Single-scope scenarios share a temp workspace; multi-scope scenarios mint their own per-scenario workspace because each spawns its own server instance. Exit code equals the number of failing scenarios.

## Debugging

- Logs from the agent are prefixed with `[agent]` or `[agent:<scope>]`.
- MCP handler calls go through the main backend log (in-process import — no stdio subprocess).
- If the agent returns an empty response, check: (a) is the assistant ID set (env var or `config/assistants.json`)? (b) is the MGA assistant's system prompt populated? (c) does `/chat/agent` work for you via `curl`?
- Structured per-call request/response logs land in `run-logs/<scenario>/<ts>/<PHASE>/llm-calls.jsonl`.
