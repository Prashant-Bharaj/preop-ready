/**
 * PhaseStateMachine — phase gate for runCustomAgent.
 *
 * An agent run executes in a single phase for its entire lifetime.
 * After Phase C's collapse there are three live phases:
 *   - ORCHESTRATING: top-level LLM agent that dispatches phase agents.
 *     No direct file writes; only spawn_phase_agent family + read-only orient.
 *   - SUBAGENT: a phase agent doing narrow work (one scope). Full tool
 *     access; the scope discriminator picks which MGA assistant to route to.
 *   - INVESTIGATING: read-only diagnostic agent (W3.INVEST). Triggered on
 *     router `action: 'diagnose'`. Emits a structured JSON report; NEVER
 *     mutates the workspace or dispatches subagents. Hard-gated by the
 *     INVESTIGATING_ALLOWED_TOOLS whitelist below — any write / exec /
 *     spawn attempt produces a synthetic deny result.
 * PLANNING and DONE remain in the enum as type-space markers but have no
 * runtime consumers.
 *
 * The phase drives two behaviours:
 *   1. Assistant selection: ORCHESTRATING uses orchestratorAssistantId,
 *      SUBAGENT uses subagent<Scope>AssistantId, INVESTIGATING uses
 *      investigatorAssistantId. (agent.js consumes `resolvePhaseAssistant()`.)
 *   2. Tool whitelist: ORCHESTRATING / INVESTIGATING gate against per-phase
 *      allowed sets; SUBAGENT (and PLANNING/DONE) allow every tool. Any
 *      tool outside the whitelist gets a synthetic error result.
 */

export const PHASES = Object.freeze({
  PLANNING: 'PLANNING',
  ORCHESTRATING: 'ORCHESTRATING',
  SUBAGENT: 'SUBAGENT',
  INVESTIGATING: 'INVESTIGATING',
  DONE: 'DONE',
});

// Allowed tools per phase. Phases not listed here allow every tool.

// Orchestrator may NOT write files or run commands directly — phase agents
// do that. Orchestrator's job is dispatch + aggregate.
const ORCHESTRATING_ALLOWED_TOOLS = new Set([
  'read_file',
  'list_files',
  'use_mcp_tool',
  'spawn_phase_agent',
  'spawn_phase_agent_background',
  'check_phase_agent',
  'cancel_phase_agent',
  'inject_phase_message',
  'attempt_completion',
]);

// W3.INVEST — Investigator is READ-ONLY. It diagnoses; it never mutates the
// workspace and never dispatches subagents. The phase-gate IS the hard-deny
// mechanism per HARNESS_EVOLUTION.md §E ("Investigator scope — denies all
// write tools regardless of input"). Any tool outside this set (including
// `write_to_file`, `replace_in_file`, `execute_command`, `spawn_phase_agent*`,
// `write_harness_state`) is rejected with a synthetic error result — the
// agent loop never reaches the tool handler, so workspace + harness state
// are guaranteed unchanged. `grep` is not currently registered in TOOL_MAP
// (see chat/server/agent/tools/core.js); list_files + targeted read_file
// covers the investigator's read needs.
const INVESTIGATING_ALLOWED_TOOLS = new Set([
  'read_file',
  'list_files',
  'read_container_logs',
  'read_harness_state',
  'attempt_completion',
]);

/**
 * Resolve the MGA assistant ID for a phase + scope combo.
 * Returns { assistantId, label } or { assistantId: null, error } when the
 * config is missing or the inputs are invalid.
 *
 * - ORCHESTRATING → orchestratorAssistantId (from chat/server/config/assistants.json)
 * - SUBAGENT + scope → subagent<Scope>AssistantId. Scope must be one of
 *   database | backend | frontend | vectordb | integration.
 * - INVESTIGATING → investigatorAssistantId (W3.INVEST). Scope-independent
 *   (investigator reads across all scopes); the scope arg is ignored.
 * - Anything else throws — caller must pass an explicit dispatchable phase.
 */
export function resolvePhaseAssistant(phase, { scope = null, creds = {} } = {}) {
  if (phase === PHASES.ORCHESTRATING) {
    const id = process.env.ORCHESTRATOR_ASSISTANT_ID || creds.orchestratorAssistantId || null;
    return { assistantId: id, label: 'Orchestrator' };
  }
  if (phase === PHASES.SUBAGENT) {
    if (!scope) return { assistantId: null, label: 'Subagent', error: 'SUBAGENT phase requires a scope' };
    const validScopes = ['database', 'backend', 'frontend', 'vectordb', 'integration'];
    if (!validScopes.includes(scope)) {
      return { assistantId: null, label: 'Subagent', error: `Invalid SUBAGENT scope "${scope}"; must be one of ${validScopes.join(', ')}` };
    }
    const upper = scope.toUpperCase();
    const camel = scope.charAt(0).toUpperCase() + scope.slice(1);
    const id = process.env[`SUBAGENT_${upper}_ASSISTANT_ID`] || creds[`subagent${camel}AssistantId`] || null;
    return { assistantId: id, label: `Subagent-${scope}` };
  }
  if (phase === PHASES.INVESTIGATING) {
    const id = process.env.INVESTIGATOR_ASSISTANT_ID || creds.investigatorAssistantId || null;
    return { assistantId: id, label: 'Investigator' };
  }
  throw new Error(`resolvePhaseAssistant: phase "${phase}" is not dispatchable. Pass ORCHESTRATING, SUBAGENT, or INVESTIGATING.`);
}

export class PhaseStateMachine {
  constructor({ initialPhase } = {}) {
    if (!initialPhase) {
      throw new Error('PhaseStateMachine requires an explicit initialPhase (ORCHESTRATING or SUBAGENT).');
    }
    if (!Object.values(PHASES).includes(initialPhase)) {
      throw new Error(`Unknown phase: ${initialPhase}`);
    }
    this.phase = initialPhase;
  }

  isOrchestrating() {
    return this.phase === PHASES.ORCHESTRATING;
  }

  isSubagent() {
    return this.phase === PHASES.SUBAGENT;
  }

  isInvestigating() {
    return this.phase === PHASES.INVESTIGATING;
  }

  /**
   * Does this phase produce file writes as its product?
   *
   * Only SUBAGENT writes code (incl. the `verification` scope, which reads then
   * builds/edits). ORCHESTRATING spawns agents; INVESTIGATING is read-only
   * diagnosis. The agent loop's write-pressure guards — the task-impossibility
   * lock and the gather-only finalize nudge — encode "zero writes after N turns
   * = stuck", which is only a valid signal for a phase expected to write. Gate
   * those guards on this predicate so read-only phases are exempt by
   * construction rather than via a per-phase exemption list.
   */
  producesFileWrites() {
    return this.phase === PHASES.SUBAGENT;
  }

  /**
   * Which MGA assistant role should handle this phase?
   * @returns {'orchestrator' | 'subagent' | 'investigator'}
   */
  getAssistantRole() {
    if (this.phase === PHASES.ORCHESTRATING) return 'orchestrator';
    if (this.phase === PHASES.SUBAGENT) return 'subagent';
    if (this.phase === PHASES.INVESTIGATING) return 'investigator';
    throw new Error(`getAssistantRole: phase "${this.phase}" has no role mapping.`);
  }

  /**
   * Is this tool allowed to dispatch in the current phase?
   */
  isToolAllowed(toolName) {
    if (this.phase === PHASES.ORCHESTRATING) {
      return ORCHESTRATING_ALLOWED_TOOLS.has(toolName);
    }
    if (this.phase === PHASES.INVESTIGATING) {
      return INVESTIGATING_ALLOWED_TOOLS.has(toolName);
    }
    // SUBAGENT (and type-space-only PLANNING/DONE) — full tool access.
    return true;
  }

  /**
   * Synthetic error returned to the model when a tool is blocked by phase.
   */
  getBlockedToolMessage(toolName) {
    if (this.phase === PHASES.ORCHESTRATING) {
      return (
        `ERROR: ${toolName} is not permitted for the Orchestrator. You orchestrate; you do NOT ` +
        `write files or run commands directly. Your tools are read_file, list_files, use_mcp_tool, ` +
        `spawn_phase_agent / spawn_phase_agent_background / check_phase_agent / cancel_phase_agent / ` +
        `inject_phase_message, and attempt_completion. To make code changes, dispatch a phase agent.`
      );
    }
    if (this.phase === PHASES.INVESTIGATING) {
      return (
        `ERROR: ${toolName} is not permitted for the Investigator. You DIAGNOSE only; you do NOT ` +
        `mutate the workspace and you do NOT dispatch subagents. Your read-only tools are read_file, ` +
        `list_files, read_container_logs, read_harness_state, and attempt_completion. Emit your ` +
        `structured JSON report via attempt_completion when your investigation is complete.`
      );
    }
    return `ERROR: ${toolName} blocked by phase ${this.phase}.`;
  }
}
