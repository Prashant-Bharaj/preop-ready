/**
 * Hybrid API client helpers — thin wrappers around the trace and approval
 * endpoints introduced in P1.
 *
 *   fetchTrace(sessionId)              → GET /api/sessions/:id/trace
 *   fetchModuleTrace(sessionId, module) → GET /api/sessions/:id/trace/:module
 *   approveAction(sessionId, actionId) → POST /api/sessions/:id/approve-action
 *   rejectAction(sessionId, actionId, reason?) → POST /api/sessions/:id/reject-action
 */

/**
 * Fetch the full hybrid trace for a session.
 *
 * @param {string} sessionId
 * @returns {Promise<{ sessionId: string, trace: Array }>}
 */
export async function fetchTrace(sessionId) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trace`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `fetchTrace: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch trace steps filtered to a specific module name.
 *
 * @param {string} sessionId
 * @param {string} moduleName — 'synthesis' | 'retrieval' | 'policy-checker'
 * @returns {Promise<{ sessionId: string, module: string, trace: Array }>}
 */
export async function fetchModuleTrace(sessionId, moduleName) {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/trace/${encodeURIComponent(moduleName)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `fetchModuleTrace: ${res.status}`);
  }
  return res.json();
}

/**
 * Approve a held action.
 *
 * @param {string} sessionId
 * @param {string} actionId
 * @returns {Promise<{ ok: boolean, actionId: string, result: 'approved' }>}
 */
export async function approveAction(sessionId, actionId) {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/approve-action`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `approveAction: ${res.status}`);
  }
  return res.json();
}

/**
 * Reject a held action.
 *
 * @param {string} sessionId
 * @param {string} actionId
 * @param {string} [reason]
 * @returns {Promise<{ ok: boolean, actionId: string, result: 'rejected' }>}
 */
export async function rejectAction(sessionId, actionId, reason) {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/reject-action`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId, reason: reason || null }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `rejectAction: ${res.status}`);
  }
  return res.json();
}
