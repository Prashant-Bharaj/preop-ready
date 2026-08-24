/**
 * TaskRunner — in-memory registry for background phase agents (Part B Phase 2).
 *
 * Tracks the state of phase agents dispatched via `spawn_phase_agent_background`
 * so the orchestrator (and the frontend, via WS events) can poll status,
 * inject mid-flight messages, or cancel.
 *
 * Lifetime: process-local. Tasks are NOT persisted across server restarts.
 * The orchestrator reseed scenario (server restart mid-build) is out of
 * scope for this spike — restarted runs start fresh.
 *
 * Concurrency: tasks run as in-flight Promises. The registry stores the
 * AbortController and a pending-message queue so cancel + inject can act
 * on a running task. The orchestrator polls via `getTask(taskId)`; the
 * subagent run completes asynchronously and updates state via the
 * settle callbacks the spawner installs.
 */

const tasks = new Map(); // taskId → TaskRecord

/**
 * @typedef {object} TaskRecord
 * @property {string} taskId
 * @property {string} sessionId
 * @property {'running' | 'completed' | 'failed' | 'cancelled'} state
 * @property {string} scope
 * @property {string} description
 * @property {number} startedAt              — Date.now() at register
 * @property {AbortController} abortController
 * @property {string[]} pendingInjects       — messages queued via injectMessage
 * @property {object | null} result          — runCustomAgent return on success
 * @property {Error | null} error            — error on failure
 */

export function registerTask(taskId, { sessionId, scope, description, abortController, promise = null }) {
  const record = {
    taskId,
    sessionId,
    state: 'running',
    scope,
    description,
    startedAt: Date.now(),
    abortController,
    pendingInjects: [],
    result: null,
    error: null,
    // Awaitable handle for sync-spawn auto-wait (eliminates orchestrator
    // polling): toolSpawnPhaseAgent awaits all in-flight background tasks
    // for this session before returning, so when the orchestrator sees the
    // sync result every parallel sibling has also completed.
    promise,
  };
  tasks.set(taskId, record);
  return record;
}

/**
 * Attach the awaitable promise to an already-registered task. The background
 * spawn handler registers the task first (so cancel/inject can target it),
 * then chains the runCustomAgent promise — call this once that promise
 * exists so other code can `await` it.
 */
export function setTaskPromise(taskId, promise) {
  const t = tasks.get(taskId);
  if (!t) return null;
  t.promise = promise;
  return t;
}

export function getTask(taskId) {
  return tasks.get(taskId) || null;
}

export function listTasksForSession(sessionId, { state = null } = {}) {
  const out = [];
  for (const t of tasks.values()) {
    if (t.sessionId !== sessionId) continue;
    if (state && t.state !== state) continue;
    out.push(t);
  }
  return out;
}

/**
 * Mark a task as completed and store its result. Called by the spawner
 * when the inner runCustomAgent resolves.
 */
export function markCompleted(taskId, result) {
  const t = tasks.get(taskId);
  if (!t) return null;
  t.state = 'completed';
  t.result = result;
  return t;
}

/**
 * Mark a task as failed. Called by the spawner when runCustomAgent throws
 * or returns a non-zero exit code that the orchestrator should surface.
 */
export function markFailed(taskId, error) {
  const t = tasks.get(taskId);
  if (!t) return null;
  t.state = 'failed';
  t.error = error instanceof Error ? error : new Error(String(error));
  return t;
}

/**
 * Cancel a running task by triggering its AbortSignal. Sets state =
 * 'cancelled' so listing/checks reflect the user's intent even if the
 * inner runCustomAgent hasn't finished aborting.
 */
export function cancelTask(taskId, reason = 'cancelled by orchestrator') {
  const t = tasks.get(taskId);
  if (!t) return null;
  if (t.state !== 'running') return t; // already terminal
  t.state = 'cancelled';
  try {
    t.abortController.abort(reason);
  } catch {}
  return t;
}

/**
 * Append a message to a task's pending-inject queue. The runCustomAgent loop
 * will see it on its next turn (if the run is still active). If the task has
 * already completed/failed/cancelled, this is a no-op and returns null.
 *
 * Phase 2 wiring note: the inner runCustomAgent loop must check the registry's
 * pendingInjects on each turn boundary and prepend any queued messages to its
 * next user message. That hook lives in agent.js.
 */
export function injectMessage(taskId, message) {
  const t = tasks.get(taskId);
  if (!t) return null;
  if (t.state !== 'running') return null;
  t.pendingInjects.push(String(message));
  return t;
}

/**
 * Drain pending injects for a task. Used by the runCustomAgent loop on each
 * turn boundary — returns and clears any queued messages. Returns [] when
 * none queued (or task missing).
 */
export function drainInjects(taskId) {
  const t = tasks.get(taskId);
  if (!t || t.pendingInjects.length === 0) return [];
  const drained = t.pendingInjects.slice();
  t.pendingInjects.length = 0;
  return drained;
}

/**
 * Drop a task from the registry. Caller's responsibility — the orchestrator
 * usually drops tasks after reading the final result so memory doesn't grow.
 * Cancelled/failed/completed tasks are kept until explicitly dropped so
 * check_phase_agent can still report status to the orchestrator.
 */
export function dropTask(taskId) {
  return tasks.delete(taskId);
}

/**
 * Test/debug helper — clear all tasks. Not part of the public surface.
 * @internal
 */
export function _resetAll() {
  tasks.clear();
}

export function generateTaskId() {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
