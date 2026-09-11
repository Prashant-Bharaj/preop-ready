/**
 * Re-engage helper for cross-scope mismatches.
 *
 * Dispatch-only by design — the retry budget lives in the caller's loop
 * (tryAutoStartApp's `while (attempt < 2)`). This helper builds a directive
 * with the full context the deviating scope needs to fix the mismatches
 * without introducing new drift, and dispatches a fresh subagent run.
 *
 * What's in the directive:
 *   - The mismatches themselves (with file:line, expected, actual).
 *   - The original task spec for this scope (lost when we start a fresh
 *     conversation — re-injecting prevents the agent from re-deriving the
 *     task from scratch and inventing new identifiers).
 *   - The FULL router contracts the scope cares about (data_model + api +
 *     ui). Sliced contracts caused t39 (2026-05-09) cascade: backend
 *     re-engaged to add missing routes, didn't see the data_model, invented
 *     `requester_id`/`details` columns instead of using `user_id`/`reason`
 *     from the contract — every new endpoint introduced new db drift.
 *   - The CURRENT WORKSPACE STATE for sibling scopes (current init.sql
 *     columns, current frontend fetch shapes, etc.) — so the agent writes
 *     code matching what already exists rather than guessing.
 *
 * Modeled on the `retryFalseRefusals` pattern from the retired JS-fanout
 * dispatcher (see docs/retired/RETIRED_JS_FANOUT.md) — fresh MGA
 * conversation, scope-locked, accumulate token totals.
 */

/**
 * Build the directive prompt for a single scope.
 * Public for unit testing — comparator can call this without dispatching.
 *
 * @param {string} scope
 * @param {Array}  mismatches — only those for THIS scope
 * @param {object} routerContracts — { dataModel, apiContract, uiContract,
 *                                      businessLogicContract, vectorEngine, tasks }
 * @param {object} [currentState] — extracted state of all scopes' current code:
 *                                  { extractedBackend, extractedFrontend, extractedDb }
 *                                  Used so the re-engaged agent sees what already
 *                                  exists instead of guessing identifiers.
 */
export function buildNarrowDirective(scope, mismatches, routerContracts = {}, currentState = null) {
  const lines = [
    `=== CROSS-SCOPE RECONCILER - ${scope.toUpperCase()} RE-ENGAGE ===`,
    '',
    `The deterministic comparator found ${mismatches.length} mismatch(es) where`,
    `your scope's output deviates from either the router contract or another`,
    `scope's output. Fix each one below, then emit attempt_completion.`,
    '',
    `Reconcile each mismatch by either (a) renaming/restructuring your code to`,
    `match the contract, or (b) explaining the deviation in a "Contract`,
    `deviations:" block in your completion report so the user understands why.`,
    '',
    '=== MISMATCHES ===',
    '',
  ];

  for (const m of mismatches) {
    const head = m.method && m.path
      ? `${m.method} ${m.path}`
      : (m.kind || 'mismatch');
    const loc = m.file
      ? `${m.file}${m.line ? ':' + m.line : ''}`
      : (m.evidence || '(no file location)');
    lines.push(`- ${head} at ${loc}`);
    if (m.contract) lines.push(`  expected: ${m.contract}`);
    if (m.actual)   lines.push(`  actual:   ${m.actual}`);
    lines.push('');
  }

  // Re-inject the original task for this scope. Without this the agent gets
  // a fresh conversation containing only the mismatch list and infers the
  // task from scratch — that's how cascades start (agent invents new
  // identifiers because it doesn't know the contract context).
  const originalTask = findOriginalTask(routerContracts, scope);
  if (originalTask) {
    lines.push('=== ORIGINAL TASK (this scope) ===');
    lines.push(originalTask);
    lines.push('');
  }

  // Full contracts the scope cares about. Backend writes routes referencing
  // db columns AND fetched body shapes — so it needs both api_contract +
  // data_model. Frontend reads api_contract + ui_contract. Always include
  // the full picture, not slices — slicing was the t39 cascade trigger.
  const contracts = scopeContracts(scope, routerContracts);
  if (Object.keys(contracts).length) {
    lines.push('=== ROUTER CONTRACTS (FULL - code in your scope must match these) ===');
    lines.push(JSON.stringify(contracts, null, 2));
    lines.push('');
  }

  // Current workspace state for sibling scopes — what already exists on
  // disk. Lets the re-engaged scope write code matching reality rather than
  // re-inventing names.
  const stateBlock = formatCurrentState(scope, currentState);
  if (stateBlock) {
    lines.push('=== CURRENT WORKSPACE STATE (sibling scopes - your code must match what exists) ===');
    lines.push(stateBlock);
    lines.push('');
  }

  lines.push('=== TASK ===');
  lines.push('Fix the mismatches above. Touch only files in your scope.');
  lines.push('When done, emit attempt_completion with a short report listing each');
  lines.push('mismatch and how you resolved it (renamed / explained as deviation).');
  return lines.join('\n');
}

/**
 * Pick the original router task text for a scope, if available.
 * routerContracts.tasks is an array of { scope, summary, task }.
 */
function findOriginalTask(routerContracts, scope) {
  const tasks = routerContracts.tasks;
  if (!Array.isArray(tasks)) return null;
  const t = tasks.find(t => t && t.scope === scope);
  if (!t) return null;
  return [
    t.summary ? `Summary: ${t.summary}` : null,
    t.task ? `Task:\n${t.task}` : null,
  ].filter(Boolean).join('\n\n');
}

/**
 * Decide which contract objects this scope needs in full.
 * - backend:  data_model (knows columns), api_contract (knows endpoints),
 *             business_logic_contract (knows rules)
 * - frontend: api_contract (knows endpoints), ui_contract (knows views/components)
 * - database: data_model (its single deliverable)
 * - vectordb: vector_engine + data_model
 * - integration: all of them
 */
function scopeContracts(scope, routerContracts) {
  const out = {};
  const wants = {
    backend:     ['dataModel', 'apiContract', 'businessLogicContract'],
    frontend:    ['apiContract', 'uiContract'],
    database:    ['dataModel'],
    vectordb:    ['vectorEngine', 'dataModel'],
    integration: ['dataModel', 'apiContract', 'uiContract', 'businessLogicContract', 'vectorEngine'],
  }[scope] || [];
  for (const k of wants) {
    if (routerContracts[k] != null) out[k] = routerContracts[k];
  }
  return out;
}

/**
 * Format the current workspace state for sibling scopes the re-engaged
 * scope needs to align with. Backend writing code needs to know the
 * actual init.sql columns + frontend fetch shapes; frontend needs to know
 * what backend actually exposes; etc.
 */
function formatCurrentState(scope, currentState) {
  if (!currentState) return null;
  const { extractedBackend = [], extractedFrontend = [], extractedDb = [] } = currentState;
  const blocks = [];

  if (scope === 'backend' || scope === 'integration') {
    if (extractedDb.length > 0) {
      const tables = extractedDb.map(t =>
        `  ${t.table}(${t.columns.map(c => c.name).join(', ')})`,
      ).join('\n');
      blocks.push(`Database init.sql declares:\n${tables}`);
    }
    if (extractedFrontend.length > 0) {
      const fetches = extractedFrontend.map(f =>
        `  ${f.method} ${f.path}${f.requestFields ? `  body: { ${f.requestFields.join(', ')} }` : ''}`,
      ).join('\n');
      blocks.push(`Frontend fetches your scope must serve:\n${fetches}`);
    }
  }

  if (scope === 'frontend' || scope === 'integration') {
    if (extractedBackend.length > 0) {
      const routes = extractedBackend.map(r =>
        `  ${r.method} ${r.path}${r.requestFields ? `  body: { ${r.requestFields.join(', ')} }` : ''}`,
      ).join('\n');
      blocks.push(`Backend exposes these routes (use these exact paths/shapes):\n${routes}`);
    }
  }

  if (scope === 'database' || scope === 'vectordb') {
    if (extractedBackend.length > 0) {
      const routes = extractedBackend.map(r => `  ${r.method} ${r.path}`).join('\n');
      blocks.push(`Backend uses these routes (their handlers reference your columns):\n${routes}`);
    }
  }

  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Dispatch a fresh run of the scope's phase agent with the directive.
 *
 * @param {string} scope
 * @param {Array} mismatches — only those for THIS scope
 * @param {object} session — passed through for runCustomAgent's session ID + token accounting
 * @param {object} opts
 * @param {object} [opts.routerContracts]
 * @param {object} [opts.currentState] — extracted workspace state (extractedBackend, extractedFrontend, extractedDb)
 * @param {Function} [opts.runCustomAgent] — injectable for tests
 * @param {Function} [opts.accumulateTotals] — injectable for tests; defaults to no-op
 * @returns {Promise<{reengagedTurns: number, exitCode: number, completionText: string|null, error?: string}>}
 */
export async function reengageScopeForMismatch(scope, mismatches, session, opts = {}) {
  if (!mismatches || mismatches.length === 0) {
    return { reengagedTurns: 0, exitCode: 0, completionText: null };
  }
  const routerContracts = opts.routerContracts || {};
  const currentState = opts.currentState || null;
  const runner = opts.runCustomAgent || (await loadDefaultRunner());
  const accumulate = opts.accumulateTotals || (() => {});

  const directive = buildNarrowDirective(scope, mismatches, routerContracts, currentState);

  let result;
  try {
    // Route through phase=SUBAGENT so the dispatch hits the scope-specific
    // MGA assistant (subagentBackendAssistantId, etc.) — that assistant has
    // the scope rules + canonical scaffold + copy_template guidance inlined
    // in its system prompt. After Phase C the SUBAGENT phase is mandatory
    // for any scope-tagged dispatch (the EXECUTING/Coder fall-through was
    // removed when the dual phase model was collapsed).
    const { PHASES } = await import('../agent/loop/phase.js');
    result = await runner(session.id, directive, {
      conversationId: null, // fresh conversation
      scope,
      phase: PHASES.SUBAGENT,
      priorTokenTotals: session.coderTokenTotals || null,
    });
  } catch (err) {
    return {
      reengagedTurns: 0,
      exitCode: 1,
      completionText: null,
      error: err.message,
    };
  }

  accumulate(session, result);
  if (result.conversationId) {
    session.coderConversationIds = session.coderConversationIds || {};
    session.coderConversationIds[scope] = result.conversationId;
  }

  return {
    reengagedTurns: result.runTokenTotals?.turns || 1,
    exitCode: result.exitCode ?? 0,
    completionText: result.completionText || null,
  };
}

async function loadDefaultRunner() {
  const mod = await import('../agent/agent.js');
  return mod.runCustomAgent;
}
