/**
 * Code-only dependency graph for the two-agent contract.
 *
 * Canonical source of validation rules for the contract emitted by
 * chat/prompts/contract-agent.md. The validator in two-agent-parser.js iterates
 * this graph; the prompt itself keeps its human-authored rule sections. A
 * drift-detector test (contract-graph-drift.test.js) catches divergence.
 *
 * Every rule encoded here is traceable to a specific line in contract-agent.md.
 * If a rule isn't in the prompt, it isn't in the graph — tightening is a
 * separate prompt-design discussion, not this segment's job.
 *
 * Citation format: `(CA Lnnn)` = contract-agent.md line nnn.
 */

export const CONTRACT_GRAPH = Object.freeze({
  // Archetype -> default scope set (CA L156-166)
  // Conditional additions encoded as separate fields the validator can apply.
  archetypes: {
    'landing':      { scopes: ['frontend', 'integration'] },                                                     // CA L158
    'crud-app':     { scopes: ['database', 'backend', 'frontend', 'integration'] },                              // CA L159
    'content-site': { scopes: ['database', 'backend', 'frontend', 'integration'] },                              // CA L160
    'dashboard':    { scopes: ['database', 'backend', 'frontend', 'integration'] },                              // CA L161
    'form-tool':    { scopes: ['backend', 'frontend', 'integration'], addDatabaseIfEntitiesNonEmpty: true },     // CA L162
    'collab-tool':  { scopes: ['database', 'backend', 'frontend', 'integration'] },                              // CA L163
    'search-tool':  { scopes: ['database', 'backend', 'frontend', 'integration'], addVectordbIfFlag: 'ai-rag' }, // CA L164
    'ai-tool':      { scopes: ['database', 'backend', 'frontend', 'integration'], addVectordbIfFlag: 'ai-rag' }, // CA L165
    'migration':    { scopes: 'match-notes' },                                                                   // CA L166
  },

  // Canonical 16-flag enum (CA L78-79). Only flags with explicit downstream
  // rules carry non-empty entries. The other 14 are membership-only — present
  // here so the validator can drop non-canonical flag names while accepting
  // these as valid (the prompt delivers their behavior via existing scopes).
  flags: {
    'ai-rag':              { requiredScopes: ['vectordb', 'database'], requireAssistants: true }, // CA L169 + L248
    'ai-chat':             { requireAssistants: true },                                           // CA L248

    // Canonical-enum-only (no extra scope/contract rules in CA prompt)
    'has-users':           {},
    'has-admin':           {},
    'long-form-content':   {},
    'search-ui':           {},
    'search-external':     {},
    'real-time':           {},
    'file-uploads':        { requiresUploadEndpoint: true }, // CA §4a — flag must materialize as a file-consuming endpoint
    'notifications-email': {},
    'exports-csv':         {},
    'sharepoint':          {},
    'snowflake':           {},
    'app-settings':        {},
    'cors-proxy':          {},
    'migration':           {},
  },

  // Scope -> required contracts / engine values
  scopes: {
    database:    { requiredContract: 'data_model', alsoRequiresScope: 'backend' }, // CA L190 + L171
    backend:     { requiredContract: 'business_logic_contract' },                  // CA L230
    frontend:    { requiredContract: 'ui_contract' },                              // CA L217
    vectordb:    { requiredEngine: 'pgvector' },                                   // CA L246
    integration: {},
  },

  // Cross-scope rules
  scopeRules: {
    serviceScopes: ['database', 'vectordb', 'backend', 'frontend'],
    integrationRequiredWhenServiceScopesAtLeast: 2, // CA L170, L319
  },

  // Conditional cross-scope contracts
  conditionalContracts: {
    api_contract: { requiredIfAll: ['backend', 'frontend'] }, // CA L203
  },

  // Action enum — contract-agent only emits 'execute' today (CA L150).
  // 'iterate' added by Step 5 of the current segment (Mode 2 in CA prompt).
  // 'clarify' / 'diagnose' are explicitly forbidden (CA L150, L332).
  actions: ['execute', 'iterate'],

  // Vector engine — only pgvector allowed (CA L246).
  validVectorEngines: ['pgvector'],

  // Forbidden scope (CA L333)
  forbiddenScopes: ['fullstack'],
});
