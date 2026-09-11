/**
 * Two-agent contract validator.
 *
 * Parses + validates the JSON contract emitted by chat/prompts/contract-agent.md
 * against the rules in chat/server/agent/planner/contract-graph.js. Every check
 * here corresponds to an explicit rule in the prompt (cited as `CA Lnnn`).
 *
 * Return shape:
 *   { ok: true,  contract, softCorrects, mode }   on success
 *   { ok: false, violations, parsed, mode }       on failure
 *
 * `contract` on success is a normalized object shaped like parseRouterJSON's
 * legacy return (camelCase fields), so downstream consumers don't need to
 * change when Phase B wires this into the runtime path.
 *
 * Soft-corrects vs violations:
 *   - softCorrects: non-canonical flag NAMES dropped (telemetry-bearing).
 *   - violations: every other rule failure (structural, semantic, enum). Each
 *     violation is unrecoverable inside the validator — the retry wrapper
 *     decides whether to retry the contract-agent call or surface to the user.
 */

import { CONTRACT_GRAPH as GRAPH } from './contract-graph.js';

// -----------------------------------------------------------------------------
// JSON extraction (mirror of router.js tryParseJSON; duplicated rather than
// imported to keep two-agent path independent of the legacy router file).
// -----------------------------------------------------------------------------
function tryParseJSON(content) {
  if (!content || !content.trim()) return null;
  try { return JSON.parse(content.trim()); } catch { /* fall through */ }

  const codeBlock = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* fall through */ }
  }

  const firstBrace = content.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0, inString = false, escape = false;
    for (let i = firstBrace; i < content.length; i++) {
      const ch = content[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(content.substring(firstBrace, i + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

// Stable scope order (CA L173) — the validator asserts tasks[] matches this.
const SCOPE_ORDER = ['database', 'vectordb', 'backend', 'frontend', 'integration'];

// MGA models that must NOT appear as mga_assistants[].model — they're
// embedding-only endpoints (CA L260, L334).
const EMBEDDING_MODELS = new Set(['text-embedding-3-large', 'text-embedding-3-small']);

// -----------------------------------------------------------------------------
// Main entry
// -----------------------------------------------------------------------------
export function parseAndValidateContract(content, conversationId, opts = {}) {
  const parsed = tryParseJSON(content);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      parsed: null,
      mode: opts.mode || 'unknown',
      violations: ['response did not parse as JSON'],
    };
  }

  // Mode detection: explicit opts.mode wins; otherwise infer from shape.
  const mode = opts.mode
    || (Array.isArray(parsed.affected_scopes) ? 'iterate' : 'execute');

  const violations = [];
  const softCorrects = [];

  // ── Action enum (CA L150, L308, L332) ──
  if (!GRAPH.actions.includes(parsed.action)) {
    violations.push(`action "${parsed.action}" is not in {${GRAPH.actions.join(', ')}}`);
  }
  if (mode === 'execute' && parsed.action !== 'execute') {
    violations.push(`execute mode requires action="execute", got "${parsed.action}"`);
  }
  if (mode === 'iterate' && parsed.action !== 'iterate') {
    violations.push(`iterate mode requires action="iterate", got "${parsed.action}"`);
  }

  // ── Flags: filter non-canonical (soft-correct), keep order (CA L78-79, L311) ──
  const rawFlags = Array.isArray(parsed.flags) ? parsed.flags : [];
  const flags = [];
  for (const f of rawFlags) {
    if (typeof f !== 'string') {
      softCorrects.push({ field: 'flags', from: f, to: null, reason: 'non-string' });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(GRAPH.flags, f)) {
      softCorrects.push({ field: 'flags', from: f, to: null, reason: 'non-canonical' });
      continue;
    }
    if (!flags.includes(f)) flags.push(f);
  }

  // Branch on mode — iterate has a much smaller validation surface than execute.
  if (mode === 'iterate') {
    validateIterate(parsed, flags, violations);
    if (violations.length > 0) return { ok: false, mode, parsed, violations };
    return { ok: true, mode, softCorrects, contract: normalizeIterate(parsed, flags, conversationId, softCorrects) };
  }

  // ── execute mode from here ──

  // Vectordb post-filter (CA L165): no archetype requires vectordb
  // unconditionally anymore — drop the task when the understanding agent
  // explicitly said no RAG pattern and no ai-rag flag survived. Explicit
  // false only: briefs without hybrid_signals are never filtered.
  dropVectordbWithoutRagSignal(parsed, flags, opts.hybridSignals, softCorrects);

  validateExecute(parsed, flags, violations, softCorrects);

  if (violations.length > 0) return { ok: false, mode, parsed, violations };

  return {
    ok: true,
    mode,
    softCorrects,
    contract: normalizeExecute(parsed, flags, conversationId, softCorrects),
  };
}

// -----------------------------------------------------------------------------
// Execute-mode validation
// -----------------------------------------------------------------------------
function hasFileConsumingEndpoint(apiContract) {
  const endpoints = Array.isArray(apiContract?.endpoints) ? apiContract.endpoints : [];
  return endpoints.some((e) => {
    if (/upload/i.test(e?.path || '')) return true;
    const req = e?.request;
    if (!req || typeof req !== 'object') return false;
    return Object.values(req).some((spec) => {
      const type = typeof spec === 'string' ? spec : (spec && typeof spec === 'object' ? String(spec.type || '') : '');
      return /\b(file|binary|multipart)\b/i.test(type);
    });
  });
}

function dropVectordbWithoutRagSignal(parsed, flags, hybridSignals, softCorrects) {
  if (hybridSignals?.has_rag_pattern !== false) return;
  if (flags.includes('ai-rag')) return;
  if (!Array.isArray(parsed.tasks)) return;
  const archDef = GRAPH.archetypes[parsed.archetype];
  if (Array.isArray(archDef?.scopes) && archDef.scopes.includes('vectordb')) return;
  if (!parsed.tasks.some(t => t?.scope === 'vectordb')) return;

  parsed.tasks = parsed.tasks.filter(t => t?.scope !== 'vectordb');
  parsed.vector_engine = null;
  softCorrects.push({ field: 'tasks', from: 'vectordb', to: null, reason: 'no-rag-signal' });
  console.log('[two-agent-parser] soft-correct: dropped vectordb task (has_rag_pattern=false, no ai-rag flag)');
}

function validateExecute(parsed, flags, violations, softCorrects) {
  // ── Archetype (CA L64, L309) ──
  if (!parsed.archetype || typeof parsed.archetype !== 'string') {
    violations.push('archetype is required and must be a string');
    return; // can't do archetype-derived checks without it
  }
  const archDef = GRAPH.archetypes[parsed.archetype];
  if (!archDef) {
    violations.push(`archetype "${parsed.archetype}" is not in canonical 9 {${Object.keys(GRAPH.archetypes).join(', ')}}`);
    return;
  }

  // ── tasks[] structure + per-task scope (CA L131-141, L173, L333) ──
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    violations.push('tasks[] is required and must be non-empty for execute');
    return;
  }

  const scopesSeen = [];
  for (let i = 0; i < parsed.tasks.length; i++) {
    const t = parsed.tasks[i];
    if (!t || typeof t !== 'object') {
      violations.push(`tasks[${i}] is not an object`);
      continue;
    }
    if (typeof t.scope !== 'string') {
      violations.push(`tasks[${i}].scope is missing or not a string`);
      continue;
    }
    if (GRAPH.forbiddenScopes.includes(t.scope)) {
      violations.push(`tasks[${i}].scope="${t.scope}" is forbidden`);
      continue;
    }
    if (!GRAPH.scopes[t.scope]) {
      violations.push(`tasks[${i}].scope="${t.scope}" is not in canonical {${Object.keys(GRAPH.scopes).join(', ')}}`);
      continue;
    }
    if (scopesSeen.includes(t.scope)) {
      violations.push(`duplicate scope "${t.scope}" in tasks[]`);
      continue;
    }
    scopesSeen.push(t.scope);
  }

  // Tasks ordering (CA L173, L318): must follow database → vectordb → backend → frontend → integration
  const orderedSubset = SCOPE_ORDER.filter(s => scopesSeen.includes(s));
  if (orderedSubset.join(',') !== scopesSeen.filter(s => SCOPE_ORDER.includes(s)).join(',')) {
    violations.push(`tasks[] not in canonical order; expected [${orderedSubset.join(', ')}], got [${scopesSeen.join(', ')}]`);
  }

  // ── Archetype → required scopes (CA L156-166) ──
  // For most archetypes scopes is a list; 'migration' is "match-notes" (skip).
  // form-tool + search-tool have conditional additions handled below.
  if (Array.isArray(archDef.scopes)) {
    for (const reqScope of archDef.scopes) {
      if (!scopesSeen.includes(reqScope)) {
        violations.push(`archetype "${parsed.archetype}" requires scope "${reqScope}"`);
      }
    }
  }

  // form-tool: + database when entities non-empty (CA L162). entities is in the
  // brief, not the contract output, so we cannot validate this conditional from
  // the contract alone — we accept whatever the contract emits for database.
  // (No violation, no soft-correct — documented limitation.)

  // conditional vectordb: archetypes with addVectordbIfFlag require the scope
  // only when the flag is present (CA L164, L165)
  if (archDef.addVectordbIfFlag && flags.includes(archDef.addVectordbIfFlag) && !scopesSeen.includes('vectordb')) {
    violations.push(`archetype "${parsed.archetype}" with flag "${archDef.addVectordbIfFlag}" requires scope "vectordb"`);
  }

  // ── Flag obligations (CA L169, L248) ──
  for (const flag of flags) {
    const def = GRAPH.flags[flag];
    if (!def) continue; // shouldn't happen — we filtered above
    for (const reqScope of def.requiredScopes || []) {
      if (!scopesSeen.includes(reqScope)) {
        violations.push(`flag "${flag}" requires scope "${reqScope}"`);
      }
    }
    if (def.requireAssistants) {
      if (!Array.isArray(parsed.mga_assistants) || parsed.mga_assistants.length === 0) {
        violations.push(`flag "${flag}" requires non-empty mga_assistants[]`);
      }
    }
    // The flag must materialize as an actual file-consuming endpoint —
    // observed drift: "upload documents" flattened into a paste-text field,
    // silently dropping the requirement before any downstream layer looks.
    if (def.requiresUploadEndpoint && !hasFileConsumingEndpoint(parsed.api_contract)) {
      violations.push(`flag "${flag}" requires api_contract to contain a file-consuming endpoint (multipart upload or a request field of type "file")`);
    }
  }

  // ── Scope obligations (CA L171, L190, L217, L230, L246) ──
  for (const scope of scopesSeen) {
    const def = GRAPH.scopes[scope];
    if (!def) continue;
    if (def.requiredContract && !isNonEmptyObject(parsed[def.requiredContract])) {
      violations.push(`scope "${scope}" requires "${def.requiredContract}" contract`);
    }
    if (def.alsoRequiresScope && !scopesSeen.includes(def.alsoRequiresScope)) {
      violations.push(`scope "${scope}" requires scope "${def.alsoRequiresScope}"`);
    }
    if (def.requiredEngine) {
      if (parsed.vector_engine !== def.requiredEngine) {
        violations.push(`scope "${scope}" requires vector_engine === "${def.requiredEngine}", got ${JSON.stringify(parsed.vector_engine)}`);
      }
    }
  }

  // ── Cross-scope rules (CA L170, L319) ──
  const serviceCount = GRAPH.scopeRules.serviceScopes.filter(s => scopesSeen.includes(s)).length;
  if (serviceCount >= GRAPH.scopeRules.integrationRequiredWhenServiceScopesAtLeast
      && !scopesSeen.includes('integration')) {
    violations.push(`${serviceCount} service scopes present; integration scope required (CA L170)`);
  }

  // ── Conditional contracts (CA L203) ──
  for (const [contractName, rule] of Object.entries(GRAPH.conditionalContracts)) {
    if (rule.requiredIfAll && rule.requiredIfAll.every(s => scopesSeen.includes(s))) {
      if (!isNonEmptyObject(parsed[contractName])) {
        violations.push(`${contractName} required when scopes include all of [${rule.requiredIfAll.join(', ')}]`);
      }
    }
  }

  // ── Per-contract structural checks ──
  if (parsed.data_model && !Array.isArray(parsed.data_model.tables)) {
    violations.push('data_model.tables must be an array');
  }
  if (parsed.api_contract && !Array.isArray(parsed.api_contract.endpoints)) {
    violations.push('api_contract.endpoints must be an array');
  }
  if (parsed.ui_contract) {
    if (typeof parsed.ui_contract.primary_view !== 'string' || !parsed.ui_contract.primary_view.trim()) {
      violations.push('ui_contract.primary_view must be a non-empty string');
    }
    if (typeof parsed.ui_contract.primary_action !== 'string' || !parsed.ui_contract.primary_action.trim()) {
      violations.push('ui_contract.primary_action must be a non-empty string');
    }
  }

  // ── mga_assistants content (CA L260, L325) ──
  if (Array.isArray(parsed.mga_assistants)) {
    for (let i = 0; i < parsed.mga_assistants.length; i++) {
      const a = parsed.mga_assistants[i];
      if (!a || typeof a !== 'object') {
        violations.push(`mga_assistants[${i}] is not an object`);
        continue;
      }
      if (i === 0 && a.key !== 'default') {
        violations.push(`mga_assistants[0].key must be "default", got ${JSON.stringify(a.key)}`);
      }
      if (typeof a.model !== 'string' || !a.model) {
        violations.push(`mga_assistants[${i}].model is required`);
      } else if (EMBEDDING_MODELS.has(a.model)) {
        violations.push(`mga_assistants[${i}].model="${a.model}" is an embedding-only model; use a chat model (CA L260)`);
      }
    }
  }

  // ── Contract self-sufficiency: required FKs must be creatable ──
  // A REQUIRED *_id in a POST body references rows someone must be able to
  // create — the platform seeds NO data (init SQL is schema-only), so a
  // contract without a POST for the referenced entity ships an app whose
  // core flow can never run (observed live: POST /downtime-events required
  // machine_id, the contract only had GET /machines, machines list was
  // empty forever). Identity-sourced fields are exempt — users come from
  // OIDC first-login, not an endpoint.
  // Exemptions keep the rule from restricting legitimate shapes (audited
  // against the fixture corpus):
  //   - identity-family fields: users come from OIDC login (manager_user_id
  //     included — a manager IS a user)
  //   - entities WITHOUT a data_model table: served from code constants, no
  //     DB-enforced FK to satisfy
  //   - nested creators: POST /evidence-packages/:id/items creates
  //     evidence_items — the LAST noun part matches even when the full noun
  //     doesn't
  //   - ingestion apps: a sync/import/ingest/upload POST populates
  //     table-backed entities wholesale (documents via /sharepoint/sync)
  const IDENTITY_FIELD_RE = /(^|_)(user|owner|author|creator|reporter|assignee)_id$|^(assigned_to|created_by|updated_by|closed_by)_id$/i;
  const endpoints = Array.isArray(parsed.api_contract?.endpoints) ? parsed.api_contract.endpoints : [];
  const postPaths = endpoints.filter((e) => e && String(e.method).toUpperCase() === 'POST').map((e) => String(e.path || ''));
  const tableNames = (parsed.data_model?.tables || []).map((t) => String(t?.name || '').toLowerCase());
  const hasIngestion = postPaths.some((p) => /sync|import|ingest|upload/i.test(p));
  for (const ep of endpoints) {
    if (!ep || String(ep.method).toUpperCase() !== 'POST' || !ep.request || typeof ep.request !== 'object') continue;
    for (const [field, desc] of Object.entries(ep.request)) {
      if (!/_id$/.test(field) || IDENTITY_FIELD_RE.test(field)) continue;
      if (typeof desc !== 'string' || !/required/i.test(desc) || /optional/i.test(desc)) continue;
      const parts = field.replace(/_id$/, '').split('_');
      const lastStem = parts[parts.length - 1].replace(/y$/, '');
      parts[parts.length - 1] = lastStem;
      const nounRe = new RegExp(parts.join('[-_]?'), 'i');
      const tableRe = new RegExp(`^${parts.join('_?')}`, 'i');
      if (!tableNames.some((t) => tableRe.test(t))) continue; // code-served lookup
      const lastRe = lastStem.length >= 4 ? new RegExp(lastStem, 'i') : nounRe;
      if (postPaths.some((p) => nounRe.test(p) || lastRe.test(p))) continue;
      if (hasIngestion) continue;
      violations.push(
        `api_contract: ${ep.method} ${ep.path} requires "${field}" but no POST endpoint creates that entity — `
        + `the platform seeds no data, so add a create endpoint for it (admin-gated is fine) or make the field optional`);
    }
  }
}

// -----------------------------------------------------------------------------
// Iterate-mode validation
// -----------------------------------------------------------------------------
function validateIterate(parsed, flags, violations) {
  if (!Array.isArray(parsed.affected_scopes) || parsed.affected_scopes.length === 0) {
    violations.push('iterate requires non-empty affected_scopes[]');
    return;
  }
  for (const s of parsed.affected_scopes) {
    if (typeof s !== 'string' || !GRAPH.scopes[s]) {
      violations.push(`affected_scopes contains invalid scope ${JSON.stringify(s)}`);
    }
  }
  if (!parsed.contract_diffs || typeof parsed.contract_diffs !== 'object' || Array.isArray(parsed.contract_diffs)) {
    violations.push('iterate requires contract_diffs object');
    return;
  }
  // contract_diffs keys must be a subset of affected_scopes
  for (const k of Object.keys(parsed.contract_diffs)) {
    if (!parsed.affected_scopes.includes(k)) {
      violations.push(`contract_diffs has key "${k}" not in affected_scopes`);
    }
  }
}

// -----------------------------------------------------------------------------
// Normalize to downstream-compatible shape (mirrors parseRouterJSON return)
// -----------------------------------------------------------------------------
function normalizeExecute(parsed, flags, conversationId, softCorrects) {
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(t => ({
    scope: t.scope,
    summary: typeof t.summary === 'string' ? t.summary : '',
    task: typeof t.task === 'string' ? t.task : '',
    rules: Array.isArray(t.rules) ? t.rules : [],
    snippets: Array.isArray(t.snippets) ? t.snippets : [],
    primarySnippet: typeof t.primarySnippet === 'string' ? t.primarySnippet : null,
    dockerfile: typeof t.dockerfile === 'string' ? t.dockerfile : null,
  })) : [];

  // Hybrid planning fields are optional but must be preserved when present,
  // otherwise downstream logs/gates see defaults (n/a/null) even if the
  // contract-agent emitted them.
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;
  const reasonCodes = Array.isArray(parsed.reasonCodes) ? parsed.reasonCodes : undefined;
  const modulePlan = Array.isArray(parsed.modulePlan)
    ? parsed.modulePlan.map((m) => ({
      module: m?.module,
      trigger: m?.trigger,
      input: typeof m?.input === 'string' ? m.input : '',
      output: typeof m?.output === 'string' ? m.output : '',
    }))
    : (parsed.modulePlan === null ? null : undefined);
  const aiNeed = normalizeAiNeed(parsed.aiNeed);
  const aiEvidence = Array.isArray(parsed.aiEvidence)
    ? parsed.aiEvidence.filter((e) => typeof e === 'string')
    : [];

  const aiGuarded = applyAiConsistencyGuards({
    confidence,
    reasonCodes,
    modulePlan,
    aiNeed,
    aiEvidence,
  });

  return {
    action: 'execute',
    archetype: parsed.archetype,
    message: typeof parsed.message === 'string' ? parsed.message : '',
    tasks,
    flags,
    dataModel: isNonEmptyObject(parsed.data_model) ? parsed.data_model : null,
    apiContract: isNonEmptyObject(parsed.api_contract) ? parsed.api_contract : null,
    uiContract: isNonEmptyObject(parsed.ui_contract) ? parsed.ui_contract : null,
    businessLogicContract: isNonEmptyObject(parsed.business_logic_contract) ? parsed.business_logic_contract : null,
    vectorEngine: typeof parsed.vector_engine === 'string' ? parsed.vector_engine : null,
    mgaAssistants: Array.isArray(parsed.mga_assistants) ? parsed.mga_assistants : [],
    contractDiffs: null,
    affectedScopes: [],
    symptom: null,
    suspectedScope: null,
    confidence: aiGuarded.confidence,
    reasonCodes: aiGuarded.reasonCodes,
    modulePlan: aiGuarded.modulePlan,
    aiNeed: aiGuarded.aiNeed,
    aiEvidence: aiGuarded.aiEvidence,
    conversationId,
    softCorrects,
  };
}

function normalizeIterate(parsed, flags, conversationId, softCorrects) {
  return {
    action: 'iterate',
    archetype: typeof parsed.archetype === 'string' ? parsed.archetype : null,
    message: typeof parsed.message === 'string' ? parsed.message : '',
    tasks: [],
    flags,
    dataModel: null,
    apiContract: null,
    uiContract: null,
    businessLogicContract: null,
    vectorEngine: null,
    mgaAssistants: [],
    contractDiffs: parsed.contract_diffs,
    affectedScopes: parsed.affected_scopes,
    symptom: null,
    suspectedScope: null,
    conversationId,
    softCorrects,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function isNonEmptyObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeAiNeed(value) {
  if (value === 'required' || value === 'optional' || value === 'not-needed') {
    return value;
  }
  return 'optional';
}

function applyAiConsistencyGuards({ confidence, reasonCodes, modulePlan, aiNeed, aiEvidence }) {
  const deterministicEvidence = new Set(['rule-based-sufficient', 'template-based-sufficient']);
  const aiRequiredEvidence = new Set([
    'llm-runtime-generation',
    'semantic-retrieval',
    'open-ended-classification',
    'dynamic-personalization',
  ]);

  let nextConfidence = confidence;
  let nextReasonCodes = Array.isArray(reasonCodes) ? reasonCodes : [];
  let nextModulePlan = modulePlan;
  let nextAiNeed = aiNeed;
  const nextAiEvidence = Array.isArray(aiEvidence) ? aiEvidence : [];

  const hasDeterministicEvidence = nextAiEvidence.some((e) => deterministicEvidence.has(e));
  const hasRequiredAiEvidence = nextAiEvidence.some((e) => aiRequiredEvidence.has(e));

  // Hard safety rail: no module execution when model claims deterministic need.
  if (nextAiNeed === 'not-needed' || hasDeterministicEvidence) {
    nextModulePlan = null;
    nextReasonCodes = [];
    nextConfidence = 1.0;
    nextAiNeed = 'not-needed';
  }

  // If hybrid fields look inconsistent, force deterministic fallback.
  if (Array.isArray(nextModulePlan) && nextModulePlan.length > 0) {
    if (typeof nextConfidence !== 'number' || nextConfidence < 0.75 || !hasRequiredAiEvidence) {
      nextModulePlan = null;
      if (typeof nextConfidence !== 'number') nextConfidence = 1.0;
      nextReasonCodes = [];
      if (!hasRequiredAiEvidence) nextAiNeed = 'optional';
    }
  }

  // Normalize missing confidence after guardrails.
  if (typeof nextConfidence !== 'number') {
    nextConfidence = 1.0;
  }

  return {
    confidence: nextConfidence,
    reasonCodes: nextReasonCodes,
    modulePlan: nextModulePlan,
    aiNeed: nextAiNeed,
    aiEvidence: nextAiEvidence,
  };
}
