/**
 * template-check.js — platform template status for the harness.
 *
 * Wraps scripts/check-template-pr.sh (the same check the rules make every AI
 * tool run at session start) and parses its line contract into an object the
 * environment route, the preflight list and the prompt env-section can use.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { WORKSPACE_DIR } from './paths.js';
import { BASH_SCRIPT_MS } from '../config/defaults.js';

const EMPTY = Object.freeze({
  pr: null,          // { number, url, heldWorkflows } | null
  prUnknown: null,   // reason string when GitHub could not be asked
  caller: null,      // 'current' | 'outdated' | 'missing' | null
  version: null,     // { status: 'UP_TO_DATE'|'UPDATE_AVAILABLE'|'CHECK_FAILED', current?, latest?, reason? } | null
  majorHeld: null,   // { major, synced } when a major release is available but not accepted
  pendingWorkflows: null, // workflow files a CI sync could not push; need a local engine run + commit
  migrationNeeded: null, // retired layers string when the project must migrate first
  tsMigration: null, // JavaScript layers that could opt into the TypeScript layout
  autoUpdate: false,
});

/** Parse the script's stdout. Unknown lines are ignored. Pure. */
export function parseTemplateCheckOutput(output) {
  const result = { ...EMPTY };
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('TEMPLATE_')) continue;
    const [token, ...rest] = line.split('|');
    switch (token) {
      case 'TEMPLATE_PR': {
        if (rest[0] === 'none') { result.pr = null; break; }
        if (rest[0] === 'unknown') { result.prUnknown = rest[1] || 'unknown'; break; }
        const number = Number(rest[0]);
        if (!Number.isInteger(number)) break;
        result.pr = {
          number,
          url: rest[1] || null,
          heldWorkflows: /held_workflows=yes/.test(rest[2] || ''),
        };
        break;
      }
      case 'TEMPLATE_CALLER':
        if (['current', 'outdated', 'missing'].includes(rest[0])) result.caller = rest[0];
        break;
      case 'TEMPLATE_VERSION':
        if (rest[0] === 'UP_TO_DATE') result.version = { status: 'UP_TO_DATE' };
        else if (rest[0] === 'UPDATE_AVAILABLE') result.version = { status: 'UPDATE_AVAILABLE', current: rest[1] || '?', latest: rest[2] || '?' };
        else if (rest[0] === 'CHECK_FAILED') result.version = { status: 'CHECK_FAILED', reason: rest[1] || 'unknown' };
        break;
      case 'TEMPLATE_MAJOR_HELD':
        result.majorHeld = { major: rest[0] || '?', synced: rest[1] || '?' };
        break;
      case 'TEMPLATE_WORKFLOWS_PENDING':
        result.pendingWorkflows = rest[0] || null;
        break;
      case 'TEMPLATE_MIGRATION_NEEDED':
        result.migrationNeeded = rest[0] || 'unknown';
        break;
      case 'TEMPLATE_TS_MIGRATION':
        result.tsMigration = rest[0] || null;   // informational, never a warning
        break;
      case 'TEMPLATE_AUTO_UPDATE':
        result.autoUpdate = rest[0] === 'on';
        break;
      default:
        break;
    }
  }
  return result;
}

/** True when something needs the user's attention (drives the preflight warn). */
export function templateNeedsAttention(check) {
  if (!check) return false;
  return Boolean(check.pr)
    || check.caller === 'outdated' || check.caller === 'missing'
    || check.version?.status === 'UPDATE_AVAILABLE'
    || Boolean(check.majorHeld) || Boolean(check.migrationNeeded) || Boolean(check.pendingWorkflows);
}

/** One-line human summary, or null when nothing is pending. */
export function describeTemplateCheck(check) {
  if (!templateNeedsAttention(check)) return null;
  const parts = [];
  if (check.pr) {
    parts.push(`platform sync PR #${check.pr.number} is open${check.pr.heldWorkflows ? ' (workflow files need a local engine run after merging)' : ''}`);
  } else if (check.version?.status === 'UPDATE_AVAILABLE') {
    parts.push(`template update available (${check.version.current} → ${check.version.latest})`);
  }
  if (check.caller === 'outdated') parts.push('the weekly sync workflow is the pre-platform copy and cannot reach the template');
  if (check.caller === 'missing') parts.push('the sync workflow is missing');
  if (check.pendingWorkflows) parts.push(`workflow file(s) await a local engine run + commit (${check.pendingWorkflows})`);
  if (check.migrationNeeded) parts.push(`retired stack (${check.migrationNeeded}) — migrate before accepting template v${check.majorHeld?.major || '2'}`);
  else if (check.majorHeld) parts.push(`template v${check.majorHeld.major} is available (held until accepted)`);
  return parts.join('; ');
}

/** Run the script (never throws; returns EMPTY when unavailable). */
export function runTemplateCheck() {
  const scriptPath = path.join(WORKSPACE_DIR, 'scripts', 'check-template-pr.sh');
  if (!existsSync(scriptPath)) return { ...EMPTY };
  try {
    const output = execSync(`bash "${scriptPath}" 2>/dev/null`, {
      cwd: WORKSPACE_DIR,
      encoding: 'utf-8',
      timeout: BASH_SCRIPT_MS,
    });
    return parseTemplateCheckOutput(output);
  } catch {
    return { ...EMPTY };
  }
}