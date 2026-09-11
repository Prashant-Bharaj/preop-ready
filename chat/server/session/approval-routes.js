/**
 * Approval Routes — human-in-the-loop approval / rejection for held actions.
 *
 * Mounted by mountSessionRoutes() in routes.js.
 *
 *   POST /api/sessions/:id/approve-action  → resolves held approval promise for actionId
 *   POST /api/sessions/:id/reject-action   → rejects held approval promise, surfaces to user
 *
 * Approval promises are stored in session.pendingApprovals — a Map from
 * actionId → { resolve, reject }. The execution router adds entries when a
 * module action requires human approval; the UI triggers these endpoints
 * when the user clicks Approve / Reject.
 *
 * If no matching actionId is found, returns 404 (the action may have already
 * been resolved, timed out, or never existed).
 */

import { tlog } from '../util/timestamped-log.js';
import { logSafe } from '../util/log-helpers.js';

/**
 * @param {import('express').Application} app
 * @param {function(string): object|null} getSession — injected from routes.js
 */
export function mountApprovalRoutes(app, getSession) {
  // POST /api/sessions/:id/approve-action
  app.post('/api/sessions/:id/approve-action', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { actionId } = req.body || {};
    if (!actionId || typeof actionId !== 'string') {
      return res.status(400).json({ error: 'actionId required' });
    }

    const pending = session.pendingApprovals?.get(actionId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending action with that id' });
    }

    tlog('[approval] approved actionId=%s session=%s', logSafe(actionId), session.id);
    session.pendingApprovals.delete(actionId);
    pending.resolve({ approved: true, actionId });
    return res.json({ ok: true, actionId, result: 'approved' });
  });

  // POST /api/sessions/:id/reject-action
  app.post('/api/sessions/:id/reject-action', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { actionId, reason } = req.body || {};
    if (!actionId || typeof actionId !== 'string') {
      return res.status(400).json({ error: 'actionId required' });
    }

    const pending = session.pendingApprovals?.get(actionId);
    if (!pending) {
      return res.status(404).json({ error: 'No pending action with that id' });
    }

    tlog('[approval] rejected actionId=%s session=%s reason=%s',
      logSafe(actionId), session.id, logSafe(reason || 'none'));
    session.pendingApprovals.delete(actionId);
    pending.reject(Object.assign(new Error('Action rejected by user'), { actionId, reason }));
    return res.json({ ok: true, actionId, result: 'rejected' });
  });
}
