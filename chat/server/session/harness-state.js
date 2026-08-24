/**
 * Shared helper for the `.harness/` project-memory layer (Section A of
 * HARNESS_EVOLUTION.md). Single source of truth for path conventions,
 * serialization, and rendering of the four AI-managed artifacts:
 *
 *   <workspaceDir>/.harness/state.md       — current truth (overwritten each turn)
 *   <workspaceDir>/.harness/decisions.md   — why-we-chose log (append-only)
 *   <workspaceDir>/.harness/notes.md       — build log (append-only — was docs/AI_NOTES.md)
 *   <workspaceDir>/.harness/contracts.json — pinned router contracts (versioned)
 *
 * The `.harness/` directory lives in the USER-APP workspace (WORKSPACE_DIR),
 * not in the spike repo. Workers/tools/migration modules import from here so
 * the path convention and the rendering format are defined exactly once.
 *
 * All file writes are wrapped in try/catch and routed through `logAndSwallow`
 * at call sites: the project-memory layer is telemetry-class (per L.5), a
 * failed write must never block a build.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from '../core/paths.js';
import { canonicalizeContracts } from './contract-canonicalizer.js';
import { tlog } from '../util/timestamped-log.js';

export const HARNESS_DIRNAME = '.harness';
export const STATE_FILENAME = 'state.md';
export const DECISIONS_FILENAME = 'decisions.md';
export const NOTES_FILENAME = 'notes.md';
export const CONTRACTS_FILENAME = 'contracts.json';
export const BUILT_FILENAME = 'built.json';
export const AUTHZ_FILENAME = 'authz-matrix.json';

/**
 * Resolve the harness directory for a given workspace.
 *
 * @param {string} [workspaceDir] - Defaults to the harness's WORKSPACE_DIR.
 *   Tests / migration callers may pass an explicit path.
 * @returns {string} absolute path to `<workspaceDir>/.harness`
 */
export function getHarnessDir(workspaceDir = WORKSPACE_DIR) {
  return path.join(workspaceDir, HARNESS_DIRNAME);
}

function ensureHarnessDir(workspaceDir) {
  const dir = getHarnessDir(workspaceDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── contracts.json ────────────────────────────────────────────────────────

/**
 * Read the contracts envelope from disk. Returns null when the file does not
 * exist yet (first build, pre-finalization). Throws on malformed JSON — the
 * caller decides whether to swallow.
 *
 * The on-disk shape is a version envelope:
 *   { version: 1, data: { dataModel, apiContract, ... } }
 *
 * Section G's amend cascade may later append to an array of versions; v1
 * keeps a single record so today's reads always look at `.data`.
 *
 * @param {string} [workspaceDir]
 * @returns {{ version: number, data: object } | null}
 */
export function readContracts(workspaceDir = WORKSPACE_DIR) {
  const file = path.join(getHarnessDir(workspaceDir), CONTRACTS_FILENAME);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Persist contracts to disk. Wraps the payload in a v1 envelope and writes
 * via a temp-file rename so concurrent readers never see a truncated file.
 *
 * @param {string} workspaceDir
 * @param {object} contracts - The contracts payload (dataModel, apiContract,
 *   vectorEngine, uiContract, businessLogicContract, fileStructure, etc.).
 *   Canonicalized (request-spec markers, role-claim trigger clause — see
 *   contract-canonicalizer.js) then stored under `.data`.
 */
// ── authz-matrix.json ─────────────────────────────────────────────────────
// Behavioral security fingerprint (role × endpoint posture) written after
// each successful build's authz probe; diffed across iterates. See
// reconciler/authz-matrix.js.

export function readAuthzMatrix(workspaceDir = WORKSPACE_DIR) {
  const file = path.join(getHarnessDir(workspaceDir), AUTHZ_FILENAME);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeAuthzMatrix(workspaceDir, matrix) {
  const dir = ensureHarnessDir(workspaceDir);
  const file = path.join(dir, AUTHZ_FILENAME);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(matrix, null, 2));
  renameSync(tmp, file);
}

export function writeContracts(workspaceDir, contracts) {
  const dir = ensureHarnessDir(workspaceDir);
  const file = path.join(dir, CONTRACTS_FILENAME);
  const { data, changes } = canonicalizeContracts(contracts || {});
  if (changes.length) tlog(`[contracts] canonicalized: ${changes.join(', ')}`);
  const envelope = { version: 1, data };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(envelope, null, 2));
  // POSIX rename is atomic — concurrent readers never see a truncated file.
  renameSync(tmp, file);
}

// ── built.json ────────────────────────────────────────────────────────────
//
// Per-scope `{ scope: summaryText }` map — the durable source of truth for
// state.md's `## What's Built` section. Written alongside state.md after
// every build/iterate. Read on every iterate so partial-scope iterates can
// MERGE their new summary into the existing map instead of clobbering all
// other scopes (which was the pre-built.json behaviour: an iterate that
// only ran the `frontend` subagent would rewrite state.md with just a
// frontend section, wiping database/backend/integration history).
//
// Upgrade path for users whose workspace pre-dates built.json: the iterate
// loader falls back to `parseBuiltFromStateMd` to derive the map from the
// existing state.md once, then writes built.json on the same dispatch so
// subsequent iterates take the fast read path. No central migration —
// each workspace self-heals on its first post-upgrade iterate.

/**
 * Read the per-scope built map from disk. Returns null when the file is
 * absent (fresh workspace OR pre-built.json upgrade). Throws on malformed
 * JSON — caller decides whether to swallow.
 */
export function readBuilt(workspaceDir = WORKSPACE_DIR) {
  const file = path.join(getHarnessDir(workspaceDir), BUILT_FILENAME);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

/**
 * Persist the per-scope built map. Atomic temp-file rename so concurrent
 * readers never see a truncated file. Always paired with writeStateMd to
 * keep the two artifacts in sync.
 */
export function writeBuilt(workspaceDir, built) {
  const dir = ensureHarnessDir(workspaceDir);
  const file = path.join(dir, BUILT_FILENAME);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(built || {}, null, 2));
  renameSync(tmp, file);
}

/**
 * Legacy/upgrade fallback: extract `{ scope: summaryText }` from an
 * existing state.md when built.json is absent. renderStateMd's format
 * is deterministic (same code wrote it), so the parse is safe.
 *
 * Implementation is a line-by-line walker rather than a single regex —
 * `\s*\n` patterns are tricky around blank-line-separated markdown
 * sections (the `\s*` matches `\n` and eats it, leaving the literal `\n`
 * with nothing to match). The walker is also easier to read.
 *
 * Returns {} for empty/missing/malformed input rather than throwing —
 * caller treats it as "no prior built map known."
 */
export function parseBuiltFromStateMd(stateMdRaw) {
  if (!stateMdRaw || typeof stateMdRaw !== 'string') return {};
  const built = {};
  let inBuiltSection = false;
  let currentScope = null;
  let currentBody = [];

  const flush = () => {
    if (currentScope) {
      const body = currentBody.join('\n').trim();
      if (body) built[currentScope] = body;
    }
    currentScope = null;
    currentBody = [];
  };

  for (const line of stateMdRaw.split('\n')) {
    if (/^## What's Built\s*$/.test(line)) {
      inBuiltSection = true;
      continue;
    }
    if (inBuiltSection && /^## /.test(line)) {
      // Next H2 heading ends the built section.
      flush();
      inBuiltSection = false;
      continue;
    }
    if (!inBuiltSection) continue;
    const scopeMatch = line.match(/^### (\S.*?)\s*$/);
    if (scopeMatch) {
      flush();
      currentScope = scopeMatch[1].trim();
      continue;
    }
    if (currentScope) currentBody.push(line);
  }
  flush();
  return built;
}

// ── state.md ──────────────────────────────────────────────────────────────

/**
 * Render the structured state object into the canonical Markdown shape
 * defined by Section A of HARNESS_EVOLUTION.md. Deterministic — same input
 * always produces the same bytes. No LLM templating.
 *
 * @param {{
 *   stack?: object,
 *   active_contracts?: string,
 *   built?: object,
 *   known_issues?: Array,
 *   next_likely_actions?: Array<string>,
 * }} state
 * @returns {string} Markdown content for state.md
 */
export function renderStateMd(state = {}) {
  const lines = [];
  lines.push('# Project State');
  lines.push('');
  lines.push(`_Last updated: ${new Date().toISOString()}_`);
  lines.push('');

  // Stack
  lines.push('## Stack');
  lines.push('');
  if (state.stack && Object.keys(state.stack).length > 0) {
    for (const [key, value] of Object.entries(state.stack)) {
      lines.push(`- **${key}**: ${formatScalar(value)}`);
    }
  } else {
    lines.push('_(no stack recorded yet)_');
  }
  lines.push('');

  // Active contracts pointer
  lines.push('## Active Contracts');
  lines.push('');
  lines.push(state.active_contracts || '`.harness/contracts.json` (v1)');
  lines.push('');

  // Built — per-scope prose
  lines.push('## What\'s Built');
  lines.push('');
  if (state.built && Object.keys(state.built).length > 0) {
    for (const [scope, prose] of Object.entries(state.built)) {
      lines.push(`### ${scope}`);
      lines.push('');
      lines.push(typeof prose === 'string' ? prose : JSON.stringify(prose, null, 2));
      lines.push('');
    }
  } else {
    lines.push('_(nothing built yet)_');
    lines.push('');
  }

  // Known issues
  lines.push('## Known Issues');
  lines.push('');
  if (Array.isArray(state.known_issues) && state.known_issues.length > 0) {
    for (const issue of state.known_issues) {
      if (typeof issue === 'string') {
        lines.push(`- ${issue}`);
      } else if (issue && typeof issue === 'object') {
        const desc = issue.description || issue.summary || '(no description)';
        const attempts = issue.attempts != null ? ` (attempts: ${issue.attempts})` : '';
        const scope = issue.scope ? ` [${issue.scope}]` : '';
        lines.push(`- ${desc}${scope}${attempts}`);
      }
    }
  } else {
    lines.push('_(none)_');
  }
  lines.push('');

  // Next likely actions — iteration framing hint
  lines.push('## Next Likely Actions');
  lines.push('');
  if (Array.isArray(state.next_likely_actions) && state.next_likely_actions.length > 0) {
    for (const action of state.next_likely_actions) {
      lines.push(`- ${action}`);
    }
  } else {
    lines.push('_(none)_');
  }
  lines.push('');

  return lines.join('\n');
}

function formatScalar(value) {
  if (value == null) return '(unset)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects / arrays — single-line JSON, capped to a sensible length so the
  // state.md stays readable even for nested stack descriptions.
  const json = JSON.stringify(value);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

/**
 * Write state.md (overwrites). Caller is responsible for try/catch +
 * logAndSwallow — this helper does the IO, the caller decides telemetry.
 */
export function writeStateMd(workspaceDir, state) {
  const dir = ensureHarnessDir(workspaceDir);
  const file = path.join(dir, STATE_FILENAME);
  writeFileSync(file, renderStateMd(state), 'utf-8');
}

// ── decisions.md ──────────────────────────────────────────────────────────

/**
 * Render a single decision entry. Append-only, dated — the entry layout is
 * deterministic so audit trails are diff-friendly.
 *
 * @param {{ summary: string, reason?: string, alternatives_considered?: string|Array<string> }} decision
 */
export function renderDecisionEntry(decision = {}) {
  const ts = new Date().toISOString();
  const lines = [];
  lines.push(`## ${ts} — ${decision.summary || '(no summary)'}`);
  lines.push('');
  if (decision.reason) {
    lines.push(`**Reason:** ${decision.reason}`);
    lines.push('');
  }
  if (decision.alternatives_considered) {
    const alts = Array.isArray(decision.alternatives_considered)
      ? decision.alternatives_considered
      : [decision.alternatives_considered];
    lines.push('**Alternatives considered:**');
    for (const alt of alts) lines.push(`- ${alt}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Append a decision entry to decisions.md, creating the file with a header
 * on first write.
 */
export function appendDecision(workspaceDir, decision) {
  const dir = ensureHarnessDir(workspaceDir);
  const file = path.join(dir, DECISIONS_FILENAME);
  let prefix = '';
  if (!existsSync(file)) {
    prefix = '# Decisions Log\n\nAppend-only audit trail of non-obvious build decisions.\n\n';
  }
  appendFileSync(file, prefix + renderDecisionEntry(decision), 'utf-8');
}

// ── notes.md ──────────────────────────────────────────────────────────────

/**
 * Append a one-line build note. Format matches the original AI_NOTES
 * convention: short dated entry, file paths only, no analysis. Used by the
 * harness itself + future workers; not part of the W1.STATE write tool's
 * surface (that ships state + decision, not notes).
 */
export function appendNote(workspaceDir, line) {
  const dir = ensureHarnessDir(workspaceDir);
  const file = path.join(dir, NOTES_FILENAME);
  let prefix = '';
  if (!existsSync(file)) {
    prefix = '# Build Notes\n\nAppend-only build log. Format: `YYYY-MM-DD — summary — paths`.\n\n';
  }
  const ts = new Date().toISOString().slice(0, 10);
  const entry = `${ts} — ${line}\n`;
  appendFileSync(file, prefix + entry, 'utf-8');
}

// ── read helpers (used by router/subagents on iteration) ──────────────────

/**
 * Read state.md as a raw string. Returns null when the file does not exist
 * (first build / pre-finalization).
 */
export function readStateMd(workspaceDir = WORKSPACE_DIR) {
  const file = path.join(getHarnessDir(workspaceDir), STATE_FILENAME);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

/**
 * Convenience: has the harness dir been populated for this workspace? Used
 * by the backfill migration to short-circuit on re-runs.
 */
export function isHarnessPopulated(workspaceDir = WORKSPACE_DIR) {
  const dir = getHarnessDir(workspaceDir);
  if (!existsSync(dir)) return false;
  const contracts = path.join(dir, CONTRACTS_FILENAME);
  return existsSync(contracts);
}
