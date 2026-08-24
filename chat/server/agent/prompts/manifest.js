/**
 * Per-assistant prompt-composition manifest.
 *
 * Single source of truth shared by:
 *   - chat/scripts/upload-assistant-prompt.js  (maintainer-only: PATCHes
 *     each assistant's `instructions` field in MGA)
 *   - chat/server/agent/prompts/disk-prompt.js (runtime: composeAssistantPrompt
 *     produces the same bytes for /chat/completions calls)
 *
 * Each entry describes how an assistant's system-prompt text is assembled
 * from chat/prompts/*.md and (optionally) supporting files in this repo.
 *
 * Entry shape:
 *   src          : (required) primary prompt file (preamble stripped at compose)
 *   configKey    : (one of) name in chat/server/config/assistants.json
 *   secretsKey   : (one of) name in .chat/secrets.json
 *   envKey       : env-var override for the resolved assistant_id
 *   source       : 'config' | 'secrets' — which file holds the assistant_id
 *   base         : (optional) shared base file prepended (preamble stripped)
 *   inlineRules  : (optional) array of paths to inline as BASELINE PLATFORM
 *                  RULES (preamble stripped, prefixed with `<!-- inline: <rel> -->`)
 *   inlineCanonicalSnippet     : (optional) string OR string[] of snippet paths
 *                  to inline as CANONICAL SCAFFOLD (verbatim — no preamble strip)
 *   inlinePlatformConstraints  : (optional) string OR string[] of constraint
 *                  file paths to inline as PLATFORM CONSTRAINTS (verbatim)
 *   temperature  : (optional) per-assistant override of DEFAULT_TEMPERATURE
 *
 * All paths are RELATIVE TO THE SPIKE ROOT (the repo root), not the
 * chat/ subdirectory — same convention upload-assistant-prompt.js used.
 */

// Default sampling: temperature 0 across every assistant. Every prompt here
// emits structured output (JSON / code / scores) where deterministic sampling
// is correct. Override per-entry only when an assistant genuinely needs
// sampling diversity (none today).
export const DEFAULT_TEMPERATURE = 0;

// Subagent-base rules — only used by the unprovisioned subagent-nextjs entry
// today (the five active subagents have empty inlineRules; the upstream
// planner encodes platform invariants into the contract + task text the
// subagent receives in its per-spawn user message, and on-demand platform
// detail comes via the `get_rules` MCP).
export const SUBAGENT_BASE_RULES = [
  '.platform-rules/global.md',
  '.platform-rules/security.md',
];

export const ASSISTANTS = {
  // The legacy `router` (BD Task Router) entry was removed when
  // chat/prompts/router.md was retired (Phase B sub-segment 3c). The MGA
  // assistant id still lives in assistants.json:routerAssistantId for
  // auth.js's health probe + runs-report aggregation; the prompt source
  // no longer exists.
  summarizer: { src: 'chat/prompts/summarizer.md', configKey: 'summarizerAssistantId',  envKey: 'SUMMARIZER_ASSISTANT_ID', source: 'config' },
  // Track A (A5): router-output LLM-judge. Scores semantic-intent match
  // post-router, gate-time only. Smoke graceful-degrades when
  // JUDGE_ASSISTANT_ID is unset.
  judge:      { src: 'chat/prompts/router-judge.md', secretsKey: 'judgeAssistantId',   envKey: 'JUDGE_ASSISTANT_ID',     source: 'secrets' },
  // Cross-scope reconciler judge: classifies ambiguous extras the
  // deterministic comparator can't resolve (renames, conventional routes,
  // fabricated paths).
  'reconciler-judge': {
    src: 'chat/prompts/reconciler-judge.md',
    configKey: 'reconcilerJudgeAssistantId',
    envKey: 'RECONCILER_JUDGE_ASSISTANT_ID',
    source: 'config',
  },
  // Prompt-writer: writes user-app assistant `instructions` from intent +
  // tool list + router contracts during /confirm pre-stage. See
  // chat/server/agent/planner/prompt-writer.js for the call site.
  'prompt-writer': {
    src: 'chat/prompts/prompt-writer.md',
    configKey: 'promptWriterAssistantId',
    envKey: 'PROMPT_WRITER_ASSISTANT_ID',
    source: 'config',
  },

  // Phase-agent family — IDs live in chat/server/config/assistants.json
  // (tracked, shared across codespaces). The legacy LLM orchestrator was
  // retired in favour of the deterministic build-dispatcher
  // (chat/server/agent/coordinator/build-dispatcher.js).
  'subagent-database':    {
    src: 'chat/prompts/subagent-database.md',
    configKey: 'subagentDatabaseAssistantId',
    envKey: 'SUBAGENT_DATABASE_ASSISTANT_ID',
    source: 'config',
    base: 'chat/prompts/subagent-base.md',
    inlineRules: [],
    inlineCanonicalSnippet: 'snippets/database/Dockerfile.postgres',
  },
  'subagent-backend':     {
    src: 'chat/prompts/subagent-backend.md',
    configKey: 'subagentBackendAssistantId',
    envKey: 'SUBAGENT_BACKEND_ASSISTANT_ID',
    source: 'config',
    base: 'chat/prompts/subagent-base.md',
    inlineRules: [],
  },
  'subagent-frontend':    {
    src: 'chat/prompts/subagent-frontend.md',
    configKey: 'subagentFrontendAssistantId',
    envKey: 'SUBAGENT_FRONTEND_ASSISTANT_ID',
    source: 'config',
    base: 'chat/prompts/subagent-base.md',
    inlineRules: [],
  },
  'subagent-vectordb':    {
    src: 'chat/prompts/subagent-vectordb.md',
    configKey: 'subagentVectordbAssistantId',
    envKey: 'SUBAGENT_VECTORDB_ASSISTANT_ID',
    source: 'config',
    base: 'chat/prompts/subagent-base.md',
    inlineRules: [],
  },
  'subagent-integration': {
    src: 'chat/prompts/subagent-integration.md',
    configKey: 'subagentIntegrationAssistantId',
    envKey: 'SUBAGENT_INTEGRATION_ASSISTANT_ID',
    source: 'config',
    base: 'chat/prompts/subagent-base.md',
    inlineRules: [],
    inlinePlatformConstraints: 'snippets/integration/platform-constraints.md',
  },
  // W3.INVEST — read-only investigator agent. Triggered on router
  // `action: 'diagnose'`. Emits structured JSON report; never mutates
  // workspace (phase-gate enforces).
  investigator: {
    src: 'chat/prompts/investigator.md',
    configKey: 'investigatorAssistantId',
    envKey: 'INVESTIGATOR_ASSISTANT_ID',
    source: 'config',
  },
  // subagent-nextjs — not yet provisioned. Architecture-ready; create an
  // MGA assistant + add subagentNextjsAssistantId to
  // chat/server/config/assistants.json when ready.
  'subagent-nextjs':      {
    src: 'chat/prompts/subagent-nextjs.md',
    configKey: 'subagentNextjsAssistantId',
    envKey: 'SUBAGENT_NEXTJS_ASSISTANT_ID',
    source: 'config',
    base: 'chat/prompts/subagent-base.md',
    inlineRules: [...SUBAGENT_BASE_RULES, '.platform-rules/scope-nextjs.md'],
  },
  // Two-agent planner (Phase B). Replaces legacy `router` for end-user flows.
  'understanding-agent': {
    src: 'chat/prompts/understanding-agent.md',
    configKey: 'understandingAssistantId',
    envKey: 'UNDERSTANDING_ASSISTANT_ID',
    source: 'config',
  },
  'contract-agent': {
    src: 'chat/prompts/contract-agent.md',
    configKey: 'contractAssistantId',
    envKey: 'CONTRACT_ASSISTANT_ID',
    source: 'config',
  },
  // Concierge intentionally absent — it has always been disk-read (see
  // chat/server/agent/concierge/concierge.js). Adding it here would make
  // `prompt:upload --all` try to PATCH a conciergeAssistantId that most
  // workspaces don't have configured; runtime composition would gain
  // nothing because concierge.md has no base/inline parts to merge.
};
