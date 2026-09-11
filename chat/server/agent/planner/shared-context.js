/**
 * Continuation-context helpers shared by the two-agent runtime.
 *
 * These match the input the legacy single-prompt router received per call:
 *   - Project context (env, phase, structure, idea, stack, recent commits)
 *     on the first turn of a clarify dialog
 *   - Attached-files block (uploads) on every turn — user can attach mid-clarify
 *   - Project memory (.harness/state.md + .harness/contracts.json) on every
 *     follow-up turn — what makes the agent see "we're iterating, not fresh"
 *   - Cost-watch warning if outbound chars balloon vs the session baseline
 *
 * The runtime entry point ([two-agent.js](./two-agent.js)) builds the enriched
 * user message for the Understanding Agent by composing these helpers.
 *
 * Extracted from the legacy `chat/server/agent/planner/router.js` so that
 * file can be deleted in the Phase B deletion commit without losing the
 * continuation-context wiring.
 */

import { readContracts, readStateMd } from '../../session/harness-state.js';
import { logAndSwallow } from '../../util/log-helpers.js';

// Absolute char ceiling for outbound prompts; over this we warn on every
// call. The ratio check (>3x first-turn) catches runaway injection growth
// across iterations; the absolute ceiling catches first-turn megaprompts.
const PROMPT_SIZE_RUNAWAY_CHARS = 100_000;

/**
 * First-turn context block. Tells the understanding-agent what's already on
 * disk (environment / phase / scope folders / git state) so its disambiguation
 * + capability offers reflect reality.
 *
 * Returns "" when envContext is null — caller's responsibility to compose
 * what to send if there's no project context (typically the bare user message).
 */
export function buildProjectContext(envContext) {
  if (!envContext) return '';

  const lines = ['[Project Context]'];
  lines.push(`Environment: ${envContext.environment === 'codespaces' ? 'GitHub Codespace' : 'Local'}`);
  lines.push(`Phase: ${envContext.projectPhase}`);

  const parts = [];
  if (envContext.hasStructure?.frontend) parts.push('frontend');
  if (envContext.hasStructure?.backend) parts.push('backend');
  if (envContext.hasStructure?.database) parts.push('database');
  if (envContext.hasStructure?.vectordb) parts.push('vectordb');
  lines.push(`Structure: ${parts.length > 0 ? parts.join(' + ') : 'none (fresh project)'}`);

  if (envContext.projectStatus?.idea) {
    lines.push(`Idea: ${envContext.projectStatus.idea}`);
  }
  if (envContext.projectStatus?.stack) {
    lines.push(`Stack: ${envContext.projectStatus.stack}`);
  }
  if (envContext.projectStatus?.completedTasks?.length > 0) {
    lines.push(`Recent tasks: ${envContext.projectStatus.completedTasks.slice(-3).join('; ')}`);
  }

  const isContinuation = envContext.projectPhase && envContext.projectPhase !== 'empty';
  if (isContinuation) {
    if (envContext.recentCommits?.length > 0) {
      lines.push(`Recent commits: ${envContext.recentCommits.slice(0, 5).join(' | ')}`);
    }
    if (envContext.hasUncommittedChanges) {
      lines.push('Uncommitted changes: yes (the user has work-in-progress on disk)');
    }
  }

  return lines.join('\n');
}

/**
 * Attached-files block. Uploads carry `{ filename, relativePath, size, mime,
 * parsed: { preview, summary } | null }` from the upload route.
 *
 * Sent on every turn (user may attach a file mid-clarify), capped at 3000
 * chars total. First file gets a short preview; rest just appear in the list.
 *
 * Returns "" when there are no uploads.
 */
export function buildAttachedFilesBlock(uploads) {
  if (!Array.isArray(uploads) || uploads.length === 0) return '';
  const MAX_BLOCK_CHARS = 3000;
  const lines = ['[Attached files]'];
  for (const u of uploads) {
    const summary = u?.parsed?.summary || `${u?.mime || 'file'}, ${u?.size || 0} bytes`;
    lines.push(`- ${u.relativePath} — ${summary}`);
  }
  const first = uploads[0];
  const firstPreview = first?.parsed?.preview?.trim();
  if (firstPreview) {
    const header = `\n(Preview of ${first.relativePath}:)\n`;
    const budget = MAX_BLOCK_CHARS - lines.join('\n').length - header.length - 4;
    if (budget > 200) {
      lines.push(header + firstPreview.slice(0, budget) + (firstPreview.length > budget ? '…' : ''));
    }
  }
  return lines.join('\n');
}

/**
 * Project memory block. Reads `.harness/state.md` + `.harness/contracts.json`
 * from the workspace and formats them as a `=== PROJECT MEMORY ===` envelope
 * the understanding-agent recognizes (per its §3 CONTINUATION CONTEXT).
 *
 * Returns null in three cases:
 *   - state.md unreadable (logged via logAndSwallow)
 *   - contracts.json malformed (logged via logAndSwallow)
 *   - neither artifact exists (normal first-build-in-fresh-workspace case)
 *
 * Callers treat null as "no memory; send the bare user message" — the agent
 * will (correctly) plan a fresh build.
 */
export function buildProjectMemoryBlock(workspaceDir) {
  let stateMdRaw;
  try {
    stateMdRaw = readStateMd(workspaceDir);
  } catch (err) {
    return logAndSwallow(
      err,
      `[two-agent] continuation-context fallback: state.md not readable at ${workspaceDir}/.harness/state.md`,
      null,
    );
  }

  let contracts;
  try {
    contracts = readContracts(workspaceDir);
  } catch (err) {
    return logAndSwallow(
      err,
      '[two-agent] continuation-context: contracts.json malformed',
      null,
    );
  }

  if (stateMdRaw == null && contracts == null) return null;

  const parts = ['=== PROJECT MEMORY ==='];
  parts.push('');
  parts.push('Prior `.harness/state.md` and `.harness/contracts.json` (ground truth for what is already built). Treat this as authoritative; iterate on top of it. Do not re-plan from scratch.');
  parts.push('');

  if (stateMdRaw) {
    parts.push('--- .harness/state.md ---');
    parts.push(stateMdRaw.trimEnd());
    parts.push('');
  } else {
    parts.push('--- .harness/state.md ---');
    parts.push('(not yet written)');
    parts.push('');
  }

  if (contracts) {
    parts.push('--- .harness/contracts.json ---');
    try {
      parts.push(JSON.stringify(contracts.data || contracts, null, 2));
    } catch (err) {
      logAndSwallow(err, '[two-agent] continuation-context: contracts.json stringify failed');
      parts.push('(contracts unavailable for injection)');
    }
    parts.push('');
  }

  parts.push('=== END PROJECT MEMORY ===');
  return parts.join('\n');
}

/**
 * Cost-watch warning. Fires (informational only, never blocks) when the
 * outbound message is dramatically larger than the session's first-turn
 * size or past the absolute char ceiling. Catches context-injection runaway.
 */
export function maybeWarnPromptSize(outboundCharsRaw, priorFirstMessageChars) {
  const outboundChars = Number(outboundCharsRaw) || 0;
  if (outboundChars > PROMPT_SIZE_RUNAWAY_CHARS) {
    console.warn(
      '[two-agent] iteration prompt-size %d chars exceeds absolute ceiling %d — possible context-injection runaway',
      outboundChars, PROMPT_SIZE_RUNAWAY_CHARS,
    );
    return;
  }
  if (typeof priorFirstMessageChars === 'number' && priorFirstMessageChars > 0) {
    const ratio = outboundChars / priorFirstMessageChars;
    if (ratio > 3) {
      console.warn(
        '[two-agent] iteration prompt-size %.1fx first-message (%d vs %d chars); possible context-injection runaway',
        ratio, outboundChars, priorFirstMessageChars,
      );
    }
  }
}
