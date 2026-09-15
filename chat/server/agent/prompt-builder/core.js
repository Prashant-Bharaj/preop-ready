/**
 * Prompt Builder — assembles an enriched prompt from:
 *   - Environment context (env-context.js)
 *   - Selected rules + snippets (from router specification)
 *   - Task description (from router or raw user message)
 *
 * ── Three-tier prompt-injection classification (W4.BUDGET, HARNESS_EVOLUTION §H) ──
 *
 * TIER 1 — ALWAYS inline (safety surface; never gated, never moved):
 *   - .platform-rules/global.md           (always-on platform rules)
 *   - .platform-rules/security.md         (non-negotiable security rules)
 *   - .platform-rules/common.md           (cross-scope patterns)
 *   - .platform-rules/scope-<scope>.md    (scope identity rule)
 *
 * TIER 2 — inline when present (current-state context, fast-path):
 *   - .harness/contracts.json slice (scope-gated by orchestration-stash)
 *   - .harness/state.md (router-emitted, lives on session)
 *   - amend / iterate contract-diff block (W2.DISPATCH; layered via
 *     orchestratorContext in buildSpawnUserMessage)
 *
 * TIER 3 — fetch-on-demand via MCP (variable / not-always-needed):
 *   - Secondary snippets (router-listed, not the canonical scaffold)
 *   - Feature-flag-specific helper rules
 *   - Canonical scaffolds — historically always inlined; now fs-conditional:
 *     only inlined when the scope's canonical entry file does NOT yet exist
 *     in the workspace (new-file scenario). On iterate / amend dispatches,
 *     the agent fetches via get_snippet only if it actually needs it.
 *
 * The classification is enforced in code by the TIER_1_SECTIONS /
 * TIER_2_SECTIONS / TIER_3_HINTS arrays below — a future maintainer can
 * reason about prompt budget by section without re-reading every helper.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { readEnvFile } from '../../core/workspace-env.js';

import { buildWorkspaceSnapshot } from './sections/workspace-snapshot.js';
import { buildAttachedFilesSection } from './sections/attached-files-section.js';
import { buildPreStagedFilesSection } from './sections/pre-staged-files-section.js';
import { buildDataModelSection } from './sections/data-model-section.js';
import { buildApiContractSection } from './sections/api-contract-section.js';
import { buildUiContractSection } from './sections/ui-contract-section.js';
import { buildBusinessLogicSection } from './sections/business-logic-section.js';
import { buildRequiredServicesSection } from './sections/required-services-section.js';
import { buildVectorEngineSection } from './sections/vector-engine-section.js';
import { buildDefinitionOfDone } from './sections/definition-of-done.js';
import { buildInlinedSnippetsSection } from './sections/inlined-snippets-section.js';
import { buildMcpHintSection } from './sections/mcp-hint-section.js';
import { buildEnvSection } from './sections/env-section.js';
import { buildRulesSection } from './sections/rules-section.js';

const PLATFORM_RULES_DIR = path.join(WORKSPACE_DIR, '.platform-rules');
const SNIPPETS_DIR = path.join(WORKSPACE_DIR, 'snippets');

// ── TIER 1: ALWAYS inline (safety surface, never gated) ──────────────────
// Files under .platform-rules/ that ship with every spawn, every agent.
// Touching this list is a safety-surface change — review with care. Adding
// to it grows the always-on prompt floor; removing weakens the rule
// guarantee the agent operates under.
const TIER_1_RULE_FILES = [
  'global.md',     // architecture, ports, scopes, deploy workflow
  'security.md',   // non-negotiable security rules
  'common.md',     // cross-scope patterns referenced by scope rules
];

// Scope → scope-identity rule filename. Also TIER 1: inlined per-spawn for
// the active scope so the agent never has to spend a turn calling
// get_rules("<scope>") for the most-relevant rule. Same list as
// mcp/handlers.js RULE_FILE_MAP for scope keys.
const SCOPE_TO_RULE_FILE = {
  backend:     'scope-backend.md',
  frontend:    'scope-frontend.md',
  database:    'scope-database.md',
  vectordb:    'scope-vectordb.md',
  integration: 'scope-integration.md',
};

// ── TIER 2: inline when present (current-state context) ──────────────────
// Section helpers that contribute current-state context — assembled at
// spawn time, only emitted when the relevant data is present. Not safety-
// critical; they're optimisation for "the agent shouldn't have to re-derive
// what the planner already computed."
//   - dataModelSection / apiContractSection / uiContractSection /
//     businessLogicSection / vectorEngineSection / requiredServicesSection:
//     scope-gated contracts slice (see orchestration-stash.js for gating)
//   - the iterate-diff block: layered through orchestratorContext by
//     phase-tools.js → buildIterateDiffsBlockForScope (W2.DISPATCH)
//   - .harness/state.md: emitted into the spawn context by the orchestrator
const TIER_2_SECTION_NAMES = [
  'data_model_section',
  'api_contract_section',
  'ui_contract_section',
  'business_logic_section',
  'vector_engine_section',
  'required_services_section',
  'iterate_diffs_block',          // via orchestratorContext
  'workspace_snapshot',            // ground truth on file layout
];

// ── TIER 3: fetch on demand via MCP ──────────────────────────────────────
// Names listed here are pointers — the agent fetches the actual content
// via get_rules() / get_snippet() only when it decides it needs them.
// Includes: secondary snippets, feature-flag-specific helper rules, and
// canonical scaffolds (the latter inlined ONLY when the scope's canonical
// entry file does NOT exist in the workspace; on iterate dispatches where
// the entry file is present, the scaffold is Tier-3 — fetch-on-demand).
const TIER_3_HINT_KINDS = [
  'router_secondary_snippets',
  'router_feature_flag_rules',
  'canonical_scaffold_fs_conditional',
];

// Canonical primary snippet per scope — the scaffold the model should write
// FIRST as the basis of the implementation. Used as a fallback when the
// router didn't emit `task.primarySnippet` and the snippet list contains
// the canonical. Without this, the scope-prefix heuristic picks whichever
// `<scope>/...` snippet the router happened to list first — observed
// failure: frontend tasks getting `Dockerfile.react` inlined instead
// of `AppScaffold.jsx`, costing extra turns spent fetching the real
// scaffold via MCP. Backend was already correct via prefix-alphabetical
// luck; including it here makes the behavior intentional rather than
// incidental.
//
// W4.BUDGET (Section H Tier-3 move): historically these snippets were
// ALWAYS inlined when present in the router's snippet list. Now they're
// fs-conditional: only inlined when the scope's canonical entry file
// does NOT yet exist in the workspace (new-file scenario). On iterate /
// amend dispatches where the entry file already exists, the agent
// fetches via get_snippet only if it actually needs it — typical iterate
// runs touch existing files where the scaffold is irrelevant. See
// canonicalEntryFileExists() below for the fs check.
const CANONICAL_PRIMARY_SNIPPET = {
  backend:  'backend/express-server-template.ts',
  frontend: 'frontend/AppScaffold.tsx',
  // database canonical = postgres template; model overrides for MySQL based
  // on the user prompt, same as backend(Express) → switching to FastAPI.
  database: 'database/Dockerfile.postgres',
  // No canonical for `vectordb` — the engine choice (pgvector / chroma /
  // qdrant) must come from the router's VECTOR ENGINE block, not a fixed
  // default. The fall-through logic below returns [] when there's no
  // canonical AND no scope-prefix match — strictly preferable to inlining
  // a wrong-scope snippet (observed failure: vectordb prompt previously
  // got `backend/vectordb-connections.js` inlined via the snippets[0]
  // fall-through).
};

// Scope → canonical entry-file path (relative to WORKSPACE_DIR). When this
// file already exists on disk, the canonical scaffold is Tier-3 (fetch on
// demand) — the scope has an existing implementation the agent should edit
// rather than re-stamp from the template. When the file is absent, the
// scaffold is inlined (Tier-1 effective behaviour for new-file dispatches)
// so the agent has the template in context without an extra MCP round-trip.
const SCOPE_CANONICAL_ENTRY_FILE = {
  backend:  'backend/src/index.ts',
  frontend: 'frontend/src/App.tsx',
  database: 'database/Dockerfile',
  // vectordb / integration: no single canonical entry-file; the scaffold
  // gating falls through to "no canonical to inline" — same as today.
};

/**
 * Tier-3 gate for canonical scaffolds: returns true when the scope's
 * canonical entry file already exists on disk (i.e. iterate / amend
 * dispatch on an existing implementation). When true the caller should
 * SKIP inlining the canonical snippet — let the agent fetch via MCP only
 * if needed. When false (or no canonical entry mapped), inlining the
 * scaffold is still useful — new-file dispatch with no existing code to
 * pivot off.
 */
function canonicalEntryFileExists(scope) {
  const rel = SCOPE_CANONICAL_ENTRY_FILE[scope];
  if (!rel) return false;
  try {
    return existsSync(path.join(WORKSPACE_DIR, rel));
  } catch {
    return false;
  }
}

// ── Benchmarking ──

function estimateTokens(text) {
  // ~4 chars per token is a rough but useful estimate
  return Math.ceil(text.length / 4);
}

function logPromptBenchmark(label, prompt, { rulesInlined = [], snippetsInlined = [], rulesHinted = [], snippetsHinted = [], tier3FsConditional = null } = {}) {
  const chars = prompt.length;
  const tokens = estimateTokens(prompt);

  const inlinedAll = [...rulesInlined, ...snippetsInlined];
  const tier3Note = tier3FsConditional
    ? ` | tier3-fs-conditional: ${tier3FsConditional}`
    : '';
  console.log(
    '[prompt-builder] %s: %d chars (~%d tokens) | inlined: %d (%s) | MCP hints: %d (%s)%s',
    label, chars, tokens, inlinedAll.length,
    inlinedAll.join(', ') || 'none',
    rulesHinted.length + snippetsHinted.length,
    rulesHinted.concat(snippetsHinted).join(', ') || 'none',
    tier3Note,
  );
}

// Safety-critical rules — always injected inline (TIER 1). Sourced from
// TIER_1_RULE_FILES at the top of the file so the classification stays in
// one place.
const ALWAYS_INLINE_RULES = TIER_1_RULE_FILES;

// Scope → rule name mapping for MCP hints
const SCOPE_RULE_NAMES = {
  database:    ['database'],
  vectordb:    ['vectordb'],
  backend:     ['backend'],
  frontend:    ['frontend'],
  integration: ['integration'],
};

/**
 * Build an enriched prompt from a router task specification.
 *
 * @param {{ tasks: Array<{scope, task, rules, snippets}>, message: string }} routerSpec
 * @param {object} envContext - From env-context.js
 * @param {{ uploads?: Array }} [opts] - Files the user attached to this turn
 * @returns {string} The enriched prompt for Cline
 */
export function buildPromptFromSpec(routerSpec, envContext, { uploads = null } = {}) {
  const tasks = routerSpec.tasks || [];

  // Build task description — join scoped tasks with headers
  let taskText;
  if (tasks.length === 1) {
    taskText = tasks[0].task;
  } else if (tasks.length > 1) {
    taskText = tasks.map(t => `[${t.scope.toUpperCase()}]\n${t.task}`).join('\n\n');
  } else {
    taskText = routerSpec.message || '';
  }

  // Inline the scope rule + the primary scope-specific snippet for each task.
  // The router already committed to these as "this task's main scaffold" —
  // making the model re-fetch them via MCP wastes a turn.
  //
  // Primary snippet selection:
  //   1. If the task carries an explicit `primarySnippet` field (from the
  //      upgraded router — see chat/prompts/router.md v4.4+), use that.
  //   2. Otherwise fall back to the scope-prefix heuristic (first snippet
  //      whose path starts with `<scope>/`). This misbehaves on frontend
  //      tasks when the router lists the Dockerfile before the React
  //      scaffold — hence the explicit-field escape hatch at step 1.
  //   3. Final fallback: snippets[0]. Imperfect when flag-resolver prepends
  //      feature snippets (auth/*) for has-users tasks, but better than
  //      nothing.
  //
  // Docs-only and fullstack tasks are explicitly opted out of snippet
  // inlining — no React or Express scaffold belongs in a markdown-only or
  // unscoped prompt.
  const taskScopes = [...new Set(tasks.map(t => t.scope).filter(s => s && SCOPE_TO_RULE_FILE[s]))];
  const scopeRuleFiles = taskScopes.map(s => SCOPE_TO_RULE_FILE[s]);
  // W4.BUDGET — TIER-3 fs-conditional canonical scaffold. When the
  // canonical entry file already exists on disk for a scope, skip the
  // scaffold inline; the agent will fetch via get_snippet only if it
  // actually needs the template (iterate dispatches usually don't).
  const primarySnippetPaths = [...new Set(
    tasks.flatMap(t => {
      if (t.scope === 'docs' || t.scope === 'fullstack') return [];
      if (typeof t.primarySnippet === 'string' && t.primarySnippet) return [t.primarySnippet];
      const all = t.snippets || [];
      const canonical = CANONICAL_PRIMARY_SNIPPET[t.scope];
      if (canonical && all.includes(canonical)) {
        if (canonicalEntryFileExists(t.scope)) return []; // Tier-3 fetch-on-demand
        return [canonical];
      }
      const scopeMatch = all.find(s => typeof s === 'string' && s.startsWith(`${t.scope}/`));
      if (scopeMatch) return [scopeMatch];
      // No fall-through to all[0]: a wrong-scope snippet (e.g. inlining
      // `backend/vectordb-connections.js` into a vectordb prompt) is worse
      // than inlining nothing. Observed empirically — t6 vectordb scope
      // got the backend connection helper inlined and tried to write JS
      // code in vectordb/.
      return [];
    }).filter(Boolean)
  )];

  const inlinedRuleFiles = [...ALWAYS_INLINE_RULES, ...scopeRuleFiles];
  const rulesContent = readRuleFiles(inlinedRuleFiles);
  const inlinedSnippets = primarySnippetPaths
    .map(p => ({ path: p, content: readSnippetFile(p) }))
    .filter(s => s.content);

  // Drop whatever we've already inlined from the MCP hint list so the model
  // doesn't re-fetch what it already has in context.
  const inlinedRuleHintNames = new Set([
    ...taskScopes,                                              // e.g. "backend"
    ...scopeRuleFiles,                                          // e.g. "scope-backend.md"
    ...scopeRuleFiles.map(f => f.replace(/\.md$/, '')),         // e.g. "scope-backend"
  ]);
  const routerRules = [...new Set([
    ...tasks.flatMap(t => t.rules || []),
    'subagents',
  ])].filter(r => !inlinedRuleHintNames.has(r));
  const routerSnippets = [...new Set(tasks.flatMap(t => t.snippets || []))]
    .filter(s => !primarySnippetPaths.includes(s));

  // Scope list for the workspace snapshot. Deduped, filtered to scopes whose
  // folders exist or are candidates for creation.
  const scopes = [...new Set(tasks.map(t => t.scope).filter(s => s && s !== 'fullstack'))];
  const prompt = buildPrompt(taskText, envContext, {
    rulesContent,
    inlinedSnippets,
    mcpHints: { rules: routerRules, snippets: routerSnippets },
    scopes,
    uploads,
  });
  // Telemetry: which scopes had the canonical scaffold dropped to Tier-3
  // (fs-conditional skip — entry file exists, agent fetches via MCP).
  const tier3Skipped = taskScopes
    .filter((s) => CANONICAL_PRIMARY_SNIPPET[s] && canonicalEntryFileExists(s))
    .map((s) => `${s}:${CANONICAL_PRIMARY_SNIPPET[s]}`)
    .join(',') || null;
  logPromptBenchmark('buildPromptFromSpec', prompt, {
    rulesInlined: inlinedRuleFiles,
    snippetsInlined: inlinedSnippets.map(s => s.path),
    rulesHinted: routerRules,
    snippetsHinted: routerSnippets,
    tier3FsConditional: tier3Skipped,
  });
  return prompt;
}

/**
 * Build an enriched prompt for a regular user message.
 *
 * `selectedContext.scopes` (optional) is an array of scope names to include
 * workspace snapshots for. Snapshots counteract model hallucinations about
 * file layout — the model sees ground truth on every task.
 */
function buildPrompt(userMessage, envContext, selectedContext) {
  const sections = [];

  // ── Environment section ──
  sections.push(buildEnvSection(envContext));

  // ── Rules section ──
  if (selectedContext.rulesContent && Object.keys(selectedContext.rulesContent).length > 0) {
    sections.push(buildRulesSection(selectedContext));
  }

  // ── Inlined primary snippets — the one-per-scope the router committed to
  if (Array.isArray(selectedContext.inlinedSnippets) && selectedContext.inlinedSnippets.length > 0) {
    sections.push(buildInlinedSnippetsSection(selectedContext.inlinedSnippets));
  }

  // ── MCP tools hint ──
  if (selectedContext.mcpHints) {
    sections.push(buildMcpHintSection(selectedContext.mcpHints));
  }

  // ── Workspace snapshot — ground truth against model memory of file layout
  if (Array.isArray(selectedContext.scopes) && selectedContext.scopes.length > 0) {
    const snap = buildWorkspaceSnapshot(selectedContext.scopes);
    if (snap) sections.push(snap);
  }

  // ── Attached files section (if user dropped files into chat) ──
  const attachedSection = buildAttachedFilesSection(selectedContext.uploads);
  if (attachedSection) sections.push(attachedSection);

  // ── User request ──
  sections.push(`=== USER REQUEST ===\n${userMessage}`);

  // ── Definition of done (always last — closes the loop) ──
  // Without this, the model keeps inventing "better" verification scripts and
  // never emits attempt_completion. Observed empirically: it'll spin 10+ turns
  // writing more elaborate runtime checks when a basic "server starts" is
  // already good enough for simple endpoint additions.
  sections.push(buildDefinitionOfDone(selectedContext.scopes));

  return sections.join('\n\n');
}

// Scope → allowed folder mapping for parallel execution
const SCOPE_FOLDERS = {
  database:    ['database/'],
  vectordb:    ['vectordb/'],
  backend:     ['backend/'],
  frontend:    ['frontend/'],
  nextjs:      ['nextjs/'],
  integration: ['docker-compose.yml', 'frontend/nginx.conf', 'frontend/nginx.local.conf', 'docs/'],
  docs:        ['docs/'],
};

/**
 * Build an enriched prompt for a SINGLE scoped task.
 * Used in parallel execution — each Cline instance gets its own scoped prompt
 * with folder restrictions to prevent file conflicts.
 *
 * @param {{ scope: string, task: string, rules: string[], snippets: string[] }} task
 * @param {object} envContext - From env-context.js
 * @param {{ allTasks: Array }} opts - Full task list for context
 * @returns {string} The enriched prompt for one Cline instance
 */
export function buildScopedPrompt(task, envContext, { allTasks = [], completionReports = {}, uploads = null, dataModel = null, apiContract = null, vectorEngine = null, uiContract = null, businessLogicContract = null } = {}) {
  // Inline scope rule + scope-specific primary snippet — mirrors the logic
  // in buildPromptFromSpec. The router already committed to these as this
  // scope's main scaffold; making the model re-fetch via MCP wastes a turn.
  const scopeRuleFile = SCOPE_TO_RULE_FILE[task.scope];
  const inlinedRuleFiles = scopeRuleFile
    ? [...ALWAYS_INLINE_RULES, scopeRuleFile]
    : [...ALWAYS_INLINE_RULES];
  const rulesContent = readRuleFiles(inlinedRuleFiles);

  // Primary snippet selection. Same precedence as buildPromptFromSpec:
  //   1. Explicit task.primarySnippet (from the upgraded router — see
  //      chat/prompts/router.md v4.4+)
  //   2. Scope-prefix heuristic (first snippet starting with `<scope>/`)
  //   3. No further fallback — inlining a wrong-scope snippet is worse than
  //      inlining nothing (the model will fetch what it needs via MCP).
  // Docs-only and fullstack get no primary inline.
  //
  // W4.BUDGET — TIER-3 fs-conditional canonical scaffold: when the scope's
  // canonical entry file already exists on disk, the scaffold drops to
  // Tier-3 fetch-on-demand (returns null here, then surfaces via mcpHints
  // below for the agent to optionally fetch via get_snippet).
  const allSnippets = task.snippets || [];
  let primarySnippet = null;
  if (task.scope !== 'docs' && task.scope !== 'fullstack') {
    if (typeof task.primarySnippet === 'string' && task.primarySnippet) {
      primarySnippet = task.primarySnippet;
    } else {
      const canonical = CANONICAL_PRIMARY_SNIPPET[task.scope];
      if (canonical && allSnippets.includes(canonical)) {
        primarySnippet = canonicalEntryFileExists(task.scope) ? null : canonical;
      } else {
        primarySnippet = allSnippets.find(s => typeof s === 'string' && s.startsWith(`${task.scope}/`))
          || null;
      }
    }
  }
  const primarySnippetContent = primarySnippet ? readSnippetFile(primarySnippet) : null;
  const inlinedSnippets = primarySnippetContent
    ? [{ path: primarySnippet, content: primarySnippetContent }]
    : [];

  // Build MCP hints excluding what we just inlined.
  const inlinedRuleHintNames = new Set([
    task.scope,
    ...(scopeRuleFile ? [scopeRuleFile, scopeRuleFile.replace(/\.md$/, '')] : []),
  ]);
  const hintRules = [
    ...(SCOPE_RULE_NAMES[task.scope] || []),
    ...(task.rules || []),
    'subagents',
  ].filter(r => !inlinedRuleHintNames.has(r));
  // Language filter: a Node task never needs .py/.rs snippet hints and vice
  // versa — the unfiltered list shipped 55 hints (28k chars) to the backend
  // spawn, nearly half for the wrong stack.
  const isPython = /python/i.test(task.dockerfile || '');
  const wrongStack = isPython ? /\.(ts|tsx|js|rs)$/ : /\.(py|rs)$/;
  const hintSnippets = allSnippets.filter(s =>
    s !== primarySnippet && !(typeof s === 'string' && wrongStack.test(s)));
  const mcpHints = { rules: hintRules, snippets: hintSnippets };

  const sections = [];

  // ── Environment section ──
  sections.push(buildEnvSection(envContext));

  // ── Scope restriction ──
  const folders = SCOPE_FOLDERS[task.scope];
  if (folders) {
    const folderList = folders.join(', ');
    sections.push(
      `=== SCOPE RESTRICTION ===\n` +
      `You are working on the ${task.scope.toUpperCase()} scope.\n` +
      `ONLY create or modify files in: ${folderList}\n` +
      `Do NOT touch files outside these paths — other scopes are handled by parallel workers.\n` +
      `Do NOT run docker-compose, docker build, or test the application. Only create and modify source files. Testing will be done after all scopes complete.\n` +
      `Emit attempt_completion as soon as your write_to_file / replace_in_file calls have succeeded. Do NOT re-read, re-list, or re-verify — verification happens in a separate post-phase step, not in your scope.\n` +
      `Use subagents (new_task) for independent reads and any task whose intermediate output would pollute this context. See get_rules("subagents") for when it's worth the overhead.`
    );
  }

  // ── Step 7d/7e: router-emitted cross-scope contracts (scope-gated) ──
  // data_model: database + backend; api_contract: backend + frontend;
  // vector_engine: vectordb + backend + integration;
  // required_services: integration only (deterministic from allTasks).
  // Each helper returns null when out of scope — section silently omitted.
  const dataModelSection = buildDataModelSection(dataModel, task.scope);
  if (dataModelSection) sections.push(dataModelSection);
  const apiContractSection = buildApiContractSection(apiContract, task.scope);
  if (apiContractSection) sections.push(apiContractSection);
  const uiContractSection = buildUiContractSection(uiContract, task.scope);
  if (uiContractSection) sections.push(uiContractSection);
  const businessLogicSection = buildBusinessLogicSection(businessLogicContract, task.scope);
  if (businessLogicSection) sections.push(businessLogicSection);
  const vectorEngineSection = buildVectorEngineSection(vectorEngine, task.scope);
  if (vectorEngineSection) sections.push(vectorEngineSection);
  const requiredServicesSection = buildRequiredServicesSection(allTasks.map(t => t.scope), task.scope);
  if (requiredServicesSection) sections.push(requiredServicesSection);

  // ── Context: what other scopes are building ──
  const reportEntries = Object.entries(completionReports);
  if (reportEntries.length > 0) {
    const reports = reportEntries
      .map(([scope, text]) => `=== COMPLETED: ${scope.toUpperCase()} ===\n${text}`)
      .join('\n\n');
    sections.push(
      `=== IMPLEMENTATION REPORTS FROM COMPLETED SCOPES ===\n` +
      `Use these reports to understand exactly what was built. Wire your integration based on the files, endpoints, tables, and config listed below.\n\n` +
      reports
    );
    const pendingScopes = allTasks
      .filter(t => t.scope !== task.scope && !completionReports[t.scope])
      .map(t => `- [${t.scope.toUpperCase()}]: ${t.task.slice(0, 150)}`);
    if (pendingScopes.length > 0) {
      sections.push(
        `=== PENDING SCOPES (not yet completed) ===\n${pendingScopes.join('\n')}`
      );
    }
  } else if (allTasks.length > 1) {
    const otherScopes = allTasks
      .filter(t => t.scope !== task.scope)
      .map(t => `- [${t.scope.toUpperCase()}]: ${t.task.slice(0, 150)}`)
      .join('\n');
    sections.push(
      `=== OTHER SCOPES (for reference only — do NOT implement these) ===\n${otherScopes}`
    );
  }

  // ── Rules section (always-inline safety rules + scope rule) ──
  if (Object.keys(rulesContent).length > 0) {
    sections.push(buildRulesSection({ rulesContent }));
  }

  // ── Inlined primary snippet (scope's main scaffold) ──
  if (inlinedSnippets.length > 0) {
    sections.push(buildInlinedSnippetsSection(inlinedSnippets));
  }

  // ── MCP tools hint (secondary rules / snippets only) ──
  sections.push(buildMcpHintSection(mcpHints));

  // ── Workspace snapshot — ground truth for this scope's folder ──
  if (task.scope && task.scope !== 'fullstack') {
    const snap = buildWorkspaceSnapshot([task.scope]);
    if (snap) sections.push(snap);
  }

  // ── Attached files (user-dropped into chat) ──
  const attachedSection = buildAttachedFilesSection(uploads);
  if (attachedSection) sections.push(attachedSection);

  // ── Task ──
  sections.push(`=== YOUR TASK (${task.scope.toUpperCase()} scope) ===\n${task.task}`);

  // ── Implementation report request (always last) ──
  // Explicit markdown formatting — every scope must emit bulleted lists and
  // bold section headers. The previous loose "one per line" hint was
  // inconsistent: database scope produced markdown bullets (rendered cleanly),
  // backend + frontend scopes space-concatenated items into a run-on paragraph.
  const reportSections = [
    `**Files:**\n- <each file created or modified on its own line, prefixed with "- ">`,
  ];
  if (task.scope === 'backend') {
    reportSections.push(
      `**API endpoints:**\n- <METHOD> <path> — <purpose> (one bullet per endpoint)`
    );
  }
  if (task.scope === 'database') {
    reportSections.push(
      `**Tables:**\n- <table name>: <key columns with types> (one bullet per table)`
    );
  }
  if (task.scope === 'frontend') {
    reportSections.push(
      `**Components:**\n- <component name>: <what it renders> (one bullet per component)`,
      `**API calls:**\n- <METHOD> <path> — <purpose> (one bullet per call)`
    );
  }
  reportSections.push(
    `**Config:**\n- <each env var, port, service name, or setting other scopes need, one bullet per item>`
  );

  sections.push(
    `=== IMPLEMENTATION REPORT (required) ===\n` +
    `When you complete your task, end your final message with a structured markdown report in EXACTLY this format:\n` +
    `\n` +
    `--- IMPLEMENTATION REPORT ---\n` +
    reportSections.join('\n\n') +
    `\n--- END REPORT ---\n` +
    `\n` +
    `Formatting rules (MANDATORY):\n` +
    `- Use markdown bullets ("- item") — never comma-separate or space-concatenate items.\n` +
    `- Every section header must be **bold** as shown above.\n` +
    `- Leave a blank line between sections so the renderer treats them as separate blocks.\n` +
    `\n` +
    `This report will be passed to the integration scope so it can wire everything correctly. Be precise and complete.`
  );

  const prompt = sections.join('\n\n');
  const tier3Skipped = CANONICAL_PRIMARY_SNIPPET[task.scope] && canonicalEntryFileExists(task.scope)
    ? `${task.scope}:${CANONICAL_PRIMARY_SNIPPET[task.scope]}`
    : null;
  logPromptBenchmark(`buildScopedPrompt[${task.scope}]`, prompt, {
    rulesInlined: inlinedRuleFiles,
    snippetsInlined: inlinedSnippets.map(s => s.path),
    rulesHinted: mcpHints.rules,
    snippetsHinted: mcpHints.snippets,
    tier3FsConditional: tier3Skipped,
  });
  return prompt;
}

/**
 * Build the user message for an orchestrator-dispatched phase agent (Part B).
 *
 * Counterpart to `buildScopedPrompt`, but lean. The phase agent's MGA system
 * prompt already carries the static-per-scope context (folder lockdown,
 * always-inline rules, scope rule, canonical scaffold) — see
 * chat/scripts/upload-assistant-prompt.js → ASSISTANTS[subagent-*].
 * This helper only contributes the per-task dynamics:
 *
 *   1. ENVIRONMENT
 *   2. CROSS-SCOPE COORDINATION (sibling completion reports + orchestrator's <context>)
 *   3. EXTRA RULES / SNIPPETS (per-flag additions, minus baselines now in system prompt)
 *   4. ATTACHED FILES (uploads)
 *   5. YOUR TASK (orchestrator's <task> text, verbatim)
 *
 * Sibling reports auto-inject. The orchestrator's <context> is appended as a
 * refinement after the auto-injected reports.
 *
 * @param {{scope, task, rules?, snippets?, primarySnippet?}} task
 * @param {object} envContext
 * @param {object} opts
 * @param {string} [opts.orchestratorContext] - free-form note from <spawn>'s <context>
 * @param {Object<string,string>} [opts.completionReports] - scope → report text
 * @param {Array} [opts.uploads] - user-attached files
 * @returns {string}
 */
export function buildSpawnUserMessage(task, envContext, {
  orchestratorContext = '',
  completionReports = {},
  uploads = null,
  dataModel = null,
  apiContract = null,
  vectorEngine = null,
  uiContract = null,
  businessLogicContract = null,
  allTaskScopes = [],
  preStagedFiles = [],
} = {}) {
  const sections = [];

  // ── 1. Environment ──
  sections.push(buildEnvSection(envContext));

  // ── 2. Cross-scope coordination ──
  // Auto-inject sibling phase-agent completion reports the runtime captured
  // before this spawn fired. The orchestrator's <context> is a refinement
  // layered on top — never the only source of cross-scope info.
  const reportEntries = Object.entries(completionReports).filter(([s]) => s !== task.scope);
  const coordParts = [];
  if (reportEntries.length > 0) {
    const reports = reportEntries
      .map(([scope, text]) => `=== COMPLETED: ${scope.toUpperCase()} ===\n${text}`)
      .join('\n\n');
    coordParts.push(
      `Sibling phase agents already completed. Wire your work to match the contracts they reported below.\n\n${reports}`
    );
  }
  if (orchestratorContext && orchestratorContext.trim()) {
    coordParts.push(
      `=== ORCHESTRATOR REFINEMENT ===\n` +
      `The orchestrator added this note (treat as override or addendum to the planning spec):\n\n${orchestratorContext.trim()}`
    );
  }
  if (coordParts.length > 0) {
    sections.push(`=== CROSS-SCOPE COORDINATION ===\n\n${coordParts.join('\n\n')}`);
  }

  // ── Step 7d/7e: router-emitted cross-scope contracts (scope-gated) ──
  // Inlined into every consuming agent's spawn message. Mechanical agreement
  // at the source — consuming agents read the SAME structured value,
  // independent of execution order (parallel dispatch defeats completion-report
  // coordination, but contracts are available at dispatch time always).
  const dataModelSection = buildDataModelSection(dataModel, task.scope);
  if (dataModelSection) sections.push(dataModelSection);
  const apiContractSection = buildApiContractSection(apiContract, task.scope);
  if (apiContractSection) sections.push(apiContractSection);
  const uiContractSection = buildUiContractSection(uiContract, task.scope);
  if (uiContractSection) sections.push(uiContractSection);
  const businessLogicSection = buildBusinessLogicSection(businessLogicContract, task.scope);
  if (businessLogicSection) sections.push(businessLogicSection);
  const vectorEngineSection = buildVectorEngineSection(vectorEngine, task.scope);
  if (vectorEngineSection) sections.push(vectorEngineSection);
  const requiredServicesSection = buildRequiredServicesSection(allTaskScopes, task.scope);
  if (requiredServicesSection) sections.push(requiredServicesSection);

  // ── 2c. Workspace env file (integration scope only) ──
  // Runtime fact, not sibling-report faith: the harness writes the workspace
  // .env (DATABASE_* / VECTORDB_* at pre-stage, MGA_* at confirm time). When
  // it exists, the integration agent MUST wire it by reference — env_file on
  // the backend, ${VAR} on the db services — even if no sibling report
  // mentions the vars: a report that omits them must not be able to leave
  // the stack unconfigured, and a literal value in compose is blocked at
  // commit time.
  const envFileSection = buildWorkspaceEnvFileSection(task.scope);
  if (envFileSection) sections.push(envFileSection);

  // ── 3. Extra hints — per-flag rules/snippets that aren't already in the
  // system prompt's baselines. The deployed subagent system prompt inlines
  // global, security, scope-<scope>, and (for BE/FE/DB) the canonical
  // scaffold. Anything else from the task's resolved arrays is genuinely
  // optional supplemental context the agent can fetch via MCP.
  const baselineRuleNames = new Set([
    'global', 'global.md',
    'security', 'security.md',
    `scope-${task.scope}`, `scope-${task.scope}.md`,
    task.scope, // bare scope name, used by the get_rules MCP tool
  ]);
  const canonicalSnippet = CANONICAL_PRIMARY_SNIPPET[task.scope] || null;
  const extraRules = (task.rules || []).filter((r) => {
    if (typeof r !== 'string') return false;
    const stem = r.replace(/^\.platform-rules\//, '').replace(/\.md$/, '');
    return !baselineRuleNames.has(r) && !baselineRuleNames.has(stem);
  });
  const extraSnippets = (task.snippets || []).filter((s) =>
    typeof s === 'string' && s !== canonicalSnippet
  );
  if (extraRules.length > 0 || extraSnippets.length > 0) {
    sections.push(buildMcpHintSection({ rules: extraRules, snippets: extraSnippets }));
  }

  // ── 4. Uploads ──
  const attachedSection = buildAttachedFilesSection(uploads);
  if (attachedSection) sections.push(attachedSection);

  // ── 4b. Pre-staged files (scaffold-first) ──
  // Files the runtime wrote to the workspace BEFORE this spawn fired —
  // contract types, route stubs, component stubs, helpers, schema, etc.
  // Inlining their CURRENT content gives the LLM authoritative source for
  // replace_in_file SEARCH blocks (instead of imagining content from
  // microcompact stubs or earlier-turn memory).
  // Scope-filtered: only include files under this scope's directory + the
  // generated contracts.ts (shared types). Skip the integration scope which
  // doesn't have pre-staged files today.
  const preStagedSection = buildPreStagedFilesSection(preStagedFiles, task.scope);
  if (preStagedSection) sections.push(preStagedSection);

  // ── 5. Task ──
  // The orchestrator's <task> text is the source of truth; it may have been
  // refined from the planning spec based on user clarifications.
  sections.push(`=== YOUR TASK (${(task.scope || 'unknown').toUpperCase()} scope) ===\n${task.task || ''}`);

  const prompt = sections.join('\n\n');
  logPromptBenchmark(`buildSpawnUserMessage[${task.scope}]`, prompt, {
    rulesInlined: [],
    snippetsInlined: [],
    rulesHinted: extraRules,
    snippetsHinted: extraSnippets,
  });
  return prompt;
}

/**
 * Section emitted into integration spawn messages when the harness-written
 * workspace .env exists on disk. Lists the actual keys (DATABASE_*,
 * VECTORDB_*, MGA_* including namespaced assistant ids) and states how each
 * group is wired: compose only ever REFERENCES the file — the values never
 * appear in docker-compose.yml. Returns null for other scopes / no file /
 * no keys.
 */
export function buildWorkspaceEnvFileSection(scope) {
  if (scope !== 'integration') return null;
  const keys = Object.keys(readEnvFile(path.join(WORKSPACE_DIR, '.env')));
  if (keys.length === 0) return null;
  const db = keys.filter((k) => k.startsWith('DATABASE_'));
  const vdb = keys.filter((k) => k.startsWith('VECTORDB_'));
  const mga = keys.filter((k) => k.startsWith('MGA_'));
  const lines = [
    '=== WORKSPACE ENV FILE ===',
    `The workspace-root .env exists (written by the harness, gitignored) and defines: ${keys.join(', ')}.`,
    'It is the ONLY place credential values live. docker-compose.yml is tracked and must only reference them:',
    '- backend service: `env_file:` listing `.env` (the path is relative to docker-compose.yml, which sits next to .env at workspace root) — always.',
  ];
  if (db.length) {
    lines.push('- db service `environment:` → `POSTGRES_DB: ${DATABASE_NAME}`, `POSTGRES_USER: ${DATABASE_USER}`, `POSTGRES_PASSWORD: ${DATABASE_PASSWORD}`; the backend keeps only `DATABASE_HOST=database` and `DATABASE_PORT=5432` inline.');
  }
  if (vdb.length) {
    lines.push('- vectordb service `environment:` → `POSTGRES_DB: ${VECTORDB_NAME}`, `POSTGRES_USER: ${VECTORDB_USER}`, `POSTGRES_PASSWORD: ${VECTORDB_PASSWORD}`; the backend keeps only `VECTORDB_HOST=vectordb` and `VECTORDB_PORT=5432` inline.');
  }
  if (mga.length) {
    lines.push(`- backend \`environment:\` passthrough entries for each MGA var (${mga.map((k) => `${k}=\${${k}}`).join(', ')}) — even if no sibling report mentions them.`);
  }
  lines.push('Never write a credential value into docker-compose.yml and never create .env.example.');
  return lines.join('\n');
}

// ── File reading helpers ──

function readRuleFiles(files) {
  const contents = {};
  for (const file of files) {
    const filePath = path.join(PLATFORM_RULES_DIR, file);
    if (existsSync(filePath)) {
      try { contents[file] = readFileSync(filePath, 'utf-8'); } catch { /* skip */ }
    }
  }
  return contents;
}

function readSnippetFile(snippetPath) {
  if (!snippetPath) return null;
  const normalized = path.normalize(snippetPath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  const filePath = path.join(SNIPPETS_DIR, normalized);
  if (!existsSync(filePath)) return null;
  try { return readFileSync(filePath, 'utf-8'); } catch { return null; }
}
