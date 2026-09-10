/**
 * pending-plan-store.js — the plan held for user confirmation, on disk.
 *
 * `session.pendingPlan` lives in memory; a server restart (Codespace stop,
 * crash, redeploy) lost it while the transcript still showed the preview,
 * so the user came back to a chat that could never be confirmed. The plan
 * is persisted whenever it is set and removed whenever it resolves
 * (confirm / discard / revise / cancel / reset). `envContext` is not
 * stored — it is machine state, re-gathered on confirm.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CHAT_DATA_DIR } from '../core/paths.js';
import { logAndSwallow } from '../util/log-helpers.js';

export const PENDING_PLANS_DIR = path.join(CHAT_DATA_DIR, 'pending-plans');

function fileFor(sessionId, dir = PENDING_PLANS_DIR) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId))) throw new Error(`pending-plan: bad session id ${sessionId}`);
  return path.join(dir, `${sessionId}.json`);
}

export function savePendingPlan(sessionId, plan, { dir = PENDING_PLANS_DIR } = {}) {
  if (!plan) return clearPendingPlan(sessionId, { dir });
  try {
    const { envContext: _omit, ...rest } = plan;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(sessionId, dir), JSON.stringify({ savedAt: Date.now(), plan: rest }));
    return true;
  } catch (err) {
    logAndSwallow(err, '[pending-plan] save failed');
    return false;
  }
}

/** @returns the stored plan with `envContext: null`, or null when none is pending. */
export function loadPendingPlan(sessionId, { dir = PENDING_PLANS_DIR } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sessionId, dir), 'utf-8'));
    if (!raw?.plan || !Array.isArray(raw.plan.tasks)) return null;
    return { ...raw.plan, envContext: null };
  } catch {
    return null;
  }
}

export function clearPendingPlan(sessionId, { dir = PENDING_PLANS_DIR } = {}) {
  try { fs.rmSync(fileFor(sessionId, dir), { force: true }); return true; }
  catch (err) { logAndSwallow(err, '[pending-plan] clear failed'); return false; }
}
