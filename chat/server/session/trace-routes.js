/**
 * Trace Routes — read-only API for hybrid module execution trace.
 *
 * Mounted by mountSessionRoutes() in routes.js.
 *
 *   GET /api/sessions/:id/trace        → returns session.hybridTrace[]
 *   GET /api/sessions/:id/trace/:module → returns steps filtered by module name
 *
 * These endpoints surface the audit trail of which hybrid modules ran,
 * what inputs they received, what they contributed, and their status.
 * Returns 404 when session not found, 200 with empty array when no trace exists.
 */

import { getTrace } from '../agent/orchestrator/trace-store.js';

/**
 * @param {import('express').Application} app
 * @param {function(string): object|null} getSession — injected from routes.js
 */
export function mountTraceRoutes(app, getSession) {
  // GET /api/sessions/:id/trace — full trace for a session
  app.get('/api/sessions/:id/trace', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const trace = getTrace(session);
    return res.json({ sessionId: session.id, trace });
  });

  // GET /api/sessions/:id/trace/:module — steps filtered by module name
  app.get('/api/sessions/:id/trace/:module', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const moduleName = req.params.module;
    const trace = getTrace(session).filter(step => step.module === moduleName);
    return res.json({ sessionId: session.id, module: moduleName, trace });
  });
}
