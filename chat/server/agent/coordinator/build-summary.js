/**
 * Deterministic build summary generator — replaces the LLM orchestrator's
 * end-of-build authoring of state.md content + the user-facing build report.
 *
 * Input shape:
 *   - `completionReports[scope]` is the raw `attempt_completion.result` text
 *     each subagent emitted. The canonical format is defined in
 *     `chat/prompts/subagent-base.md`:
 *
 *       --- PHASE AGENT REPORT ---
 *       **Scope:** <scope>
 *       **Status:** complete | partial | infeasible
 *       **Files written:**
 *       - <path>
 *       - <path>
 *       **Summary:** (1-2 paragraphs)
 *       **Contracts for sibling scopes:**
 *       - <bullets>
 *       --- END REPORT ---
 *
 *     We parse Status + Files written + Summary structurally and ignore the
 *     rest (Contracts blocks are for sibling-prompt injection, not the user
 *     view).
 *
 * Quality tradeoffs vs LLM:
 *   - `built` is the first paragraph of each subagent's **Summary:** section
 *     (capped), not LLM-rephrased.
 *   - `known_issues` are status-driven (status != complete) + missing-files
 *     heuristic — not LLM-synthesized.
 *   - `next_likely_actions` is omitted.
 *   - Build report prose is template-populated.
 *
 * Consumers call this once at end of build, then pass the result to
 * writeStateMd / generateContractTypes utilities.
 */

/**
 * Generate state.md content + the user-facing build report from completion data.
 *
 * @param {object} params
 * @param {{
 *   tasks: Array<{scope, summary, task, dockerfile?, primarySnippet?}>,
 *   flags?: string[],
 *   dataModel?: {tables: Array}|null,
 *   apiContract?: {endpoints: Array}|null,
 *   vectorEngine?: string|null,
 *   uiContract?: object|null,
 *   businessLogicContract?: object|null,
 *   mgaAssistants?: Array,
 * }} params.contract
 * @param {Object<string,string>} params.completionReports - keyed by scope; value is the subagent's raw attempt_completion text
 * @param {string[]} params.dispatchedScopes - the scopes that were actually dispatched (post iterate-filter)
 * @param {object|null} params.iterate - iterate payload if this was an iterate dispatch
 * @param {Object<string,string>|null} [params.priorBuilt] - the prior `built` map
 *   read from `.harness/built.json` (or parsed out of state.md as fallback).
 *   When present, the merged result preserves scopes NOT in this dispatch
 *   so partial-scope iterates don't clobber other scopes' history. Pass null
 *   on a fresh initial build.
 *
 * @returns {{ stateMd: object, buildReport: string, status: 'built'|'partial'|'failed', built: Object<string,string> }}
 *   `built` is exposed so callers can persist it to .harness/built.json
 *   without re-deriving (this is the merged map: priorBuilt overlaid with
 *   current-dispatch entries).
 */
export function generateBuildSummary({ contract, completionReports, dispatchedScopes, iterate = null, priorBuilt = null }) {
  const scopes = Array.isArray(dispatchedScopes) ? dispatchedScopes : Object.keys(completionReports || {});

  // ── Parse each completion report once; reuse downstream ──
  const parsedByScope = {};
  for (const scope of scopes) {
    parsedByScope[scope] = parseSubagentReport((completionReports || {})[scope] || '');
  }

  // ── stack — derived structurally from contract ──
  const stack = deriveStack(contract);

  // ── built — merge prior with current dispatch ──
  //
  // Start from the prior map (preserves scopes the current dispatch didn't
  // touch — e.g. a frontend-only iterate keeps database/backend/integration
  // entries from the initial build) and overlay this dispatch's scopes
  // (which always win, since their content reflects the latest code).
  const built = priorBuilt ? { ...priorBuilt } : {};
  for (const scope of scopes) {
    const summary = parsedByScope[scope].summary;
    built[scope] = firstParagraph(summary, 400) || '(no summary text)';
  }

  // ── known_issues — derived from parsed status + files ──
  const knownIssues = [];
  for (const scope of scopes) {
    for (const issue of detectIssues(scope, parsedByScope[scope], (completionReports || {})[scope])) {
      knownIssues.push(issue);
    }
  }

  // ── next_likely_actions — omitted (was LLM extrapolation) ──
  const nextLikelyActions = [];

  const stateMd = {
    stack,
    active_contracts: '`.harness/contracts.json` (v1)',
    built,
    known_issues: knownIssues,
    next_likely_actions: nextLikelyActions,
  };

  // ── Build status — derive from parsed status + issue patterns ──
  const status = deriveStatus(scopes, parsedByScope, completionReports);

  // ── User-facing build report (markdown) ──
  const buildReport = renderBuildReport({
    contract,
    parsedByScope,
    scopes,
    status,
    knownIssues,
    iterate,
  });

  return { stateMd, buildReport, status, built };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subagent report parser — structural parse of the canonical PHASE AGENT
// REPORT format defined in chat/prompts/subagent-base.md.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_RE = /\*{0,2}Status:\*{0,2}\s*([A-Za-z]+)/i;
const SUMMARY_RE = /\*{0,2}Summary:\*{0,2}\s*\n?([\s\S]*?)(?=\n\s*\*{0,2}(?:Contracts for sibling scopes|Known issues?|UNABLE TO RESOLVE|Files written|Status|Scope)[^\n]*\*{0,2}|\n\s*---\s*END|$)/i;
const FILES_RE = /\*{0,2}Files written:\*{0,2}[ \t]*\n?([\s\S]*?)(?=\n\s*\n|\n\s*\*{0,2}[A-Z][^\n]*:\*{0,2}|\n\s*---\s*END|$)/i;

/**
 * Parse a subagent's raw attempt_completion text into structured fields.
 * Tolerates markdown-bold wrapping (`**Field:**`), plain (`Field:`), bullet-
 * list and inline file lists, and missing closing markers.
 *
 * @param {string} text
 * @returns {{ status: string|null, files: string[], summary: string, raw: string }}
 */
export function parseSubagentReport(text) {
  if (!text || typeof text !== 'string') {
    return { status: null, files: [], summary: '', raw: '' };
  }

  // Strip opening/closing dashes-and-text markers (tolerate REPORT/RESULT,
  // case, surrounding whitespace).
  let body = text
    .replace(/^---\s*PHASE AGENT (?:REPORT|RESULT)[^\n]*---\s*\n*/i, '')
    .replace(/\n*---\s*END(?:\s+(?:REPORT|RESULT))?\s*---\s*$/i, '')
    .trim();

  // Status
  let status = null;
  const sm = body.match(STATUS_RE);
  if (sm) status = sm[1].toLowerCase();

  // Files written — either a bullet block or an inline comma list
  let files = [];
  const fm = body.match(FILES_RE);
  if (fm) {
    const block = fm[1].trim();
    if (block) {
      if (/^-\s+/m.test(block)) {
        // bullet list — one path per line
        files = block.split('\n')
          .map(l => l.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean);
      } else if (/^none$/i.test(block)) {
        files = [];
      } else {
        // inline list (e.g. "Files written: file1, file2") OR a single path
        files = block.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      }
    }
  }

  // Summary section
  let summary = '';
  const ms = body.match(SUMMARY_RE);
  if (ms) summary = ms[1].trim();

  return { status, files, summary, raw: body };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stack derivation
// ─────────────────────────────────────────────────────────────────────────────

function deriveStack(contract) {
  const stack = {};
  const backendTask = (contract?.tasks || []).find(t => t.scope === 'backend');
  if (backendTask?.dockerfile) {
    stack.backend_language = backendTask.dockerfile.includes('python') ? 'python' : 'node';
  }
  if ((contract?.tasks || []).some(t => t.scope === 'frontend')) {
    stack.frontend = 'react-vite';
  }
  if ((contract?.tasks || []).some(t => t.scope === 'database')) {
    stack.database = 'postgres';
  }
  if (contract?.vectorEngine) {
    stack.vector_engine = contract.vectorEngine;
  }
  return stack;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue detection — parsed-report-driven
// ─────────────────────────────────────────────────────────────────────────────

const ISSUE_STATUS_KEYWORDS = new Set(['partial', 'failed', 'infeasible', 'incomplete']);

function detectIssues(scope, parsed, rawText) {
  // No completion text recorded at all — separate signal from "report parsed
  // but status was X". Either way it counts as an issue for state.md.
  if (!rawText || !rawText.trim()) {
    return [{ scope, description: 'no completion text recorded', attempts: 1 }];
  }

  const issues = [];

  if (parsed.status && ISSUE_STATUS_KEYWORDS.has(parsed.status)) {
    issues.push({
      scope,
      description: `agent reported status=${parsed.status}`,
      attempts: 1,
    });
  }

  // No files written for a non-integration scope is suspicious.
  // Integration's only deliverable is compose, sometimes implicit.
  if (parsed.files.length === 0 && scope !== 'integration') {
    issues.push({
      scope,
      description: 'no files written for this scope',
      attempts: 1,
    });
  }

  // Subagent self-reported caveats under an explicit heading (e.g. "Known
  // issues:" / "UNABLE TO RESOLVE:"). The Summary parser stops before these
  // markers, so they're separately discoverable in the raw text. The
  // heading may use markdown-bold (`**…:**`) or plain (`Heading:`) form;
  // tolerate the colon being inside or outside the bold markers.
  const caveat = parsed.raw.match(/(?:^|\n)\s*\*{0,2}(?:Known\s+issues?|UNABLE TO RESOLVE):?\*{0,2}:?\s*\n+([\s\S]*?)(?=\n\s*\*{0,2}[A-Z][A-Za-z ]+:\*{0,2}|\n\s*---|$)/i);
  if (caveat) {
    const firstLine = caveat[1].split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (firstLine && !issues.some(i => i.description === firstLine)) {
      issues.push({
        scope,
        description: firstLine.replace(/^[-*]\s*/, '').slice(0, 200),
        attempts: 1,
      });
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status derivation — parsed-report-driven
// ─────────────────────────────────────────────────────────────────────────────

function deriveStatus(scopes, parsedByScope, completionReports) {
  if (!scopes || scopes.length === 0) return 'failed';

  // Any scope with no completion report at all → failed.
  for (const scope of scopes) {
    if (!completionReports?.[scope]) return 'failed';
  }

  // Any scope with an explicit terminal-failure status → failed.
  for (const scope of scopes) {
    const status = parsedByScope[scope]?.status;
    if (status === 'failed' || status === 'infeasible') return 'failed';
  }

  // Any partial status or empty-files non-integration → partial.
  for (const scope of scopes) {
    const status = parsedByScope[scope]?.status;
    if (status === 'partial' || status === 'incomplete') return 'partial';
    if (scope !== 'integration' && parsedByScope[scope]?.files.length === 0) return 'partial';
  }

  return 'built';
}

// ─────────────────────────────────────────────────────────────────────────────
// Build report rendering (markdown)
// ─────────────────────────────────────────────────────────────────────────────

function renderBuildReport({ contract, parsedByScope, scopes, status, knownIssues, iterate }) {
  const lines = [];
  lines.push('--- BUILD REPORT ---');
  lines.push('');
  lines.push(`**Status:** ${status}`);
  lines.push('');

  if (iterate) {
    lines.push(`**Mode:** iterate (affected scopes: ${iterate.affectedScopes.join(', ')})`);
    lines.push('');
  }

  // Scopes built
  lines.push('**Scopes built:**');
  for (const scope of scopes) {
    const files = parsedByScope[scope]?.files || [];
    const filesLine = files.length === 0
      ? (scope === 'integration' ? 'no files (compose may be implicit)' : 'no files written')
      : files.join(', ');
    lines.push(`- ${scope}: ${filesLine}`);
  }
  lines.push('');

  // Endpoints — from contract.apiContract if present
  const endpoints = contract?.apiContract?.endpoints || [];
  if (endpoints.length > 0) {
    lines.push('**Endpoints:**');
    for (const ep of endpoints) {
      const purpose = ep.purpose || ep.summary || '';
      lines.push(`- ${ep.method || 'GET'} /api${ep.path || ''}${purpose ? ` — ${purpose}` : ''}`);
    }
    lines.push('');
  }

  // Run locally
  lines.push('**Run locally:**');
  lines.push('- `docker compose up --build`');
  if (scopes.includes('frontend') && scopes.includes('integration')) {
    lines.push('- App: http://localhost:8080 (nginx → backend at /api)');
  } else if (scopes.includes('backend')) {
    lines.push('- Backend: http://localhost:3000');
  }
  lines.push('');

  // Known issues
  if (knownIssues.length > 0) {
    lines.push('**Known issues:**');
    for (const issue of knownIssues) {
      const scopePrefix = issue.scope ? `[${issue.scope}] ` : '';
      lines.push(`- ${scopePrefix}${issue.description}`);
    }
    lines.push('');
  }

  lines.push('--- END BUILD REPORT ---');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Text utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take the first paragraph (up to first blank line) of text, capped at maxChars.
 */
function firstParagraph(text, maxChars = 400) {
  if (!text) return '';
  const trimmed = text.trim();
  const para = trimmed.split(/\n\s*\n/)[0] || trimmed;
  const collapsed = para.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  const truncated = collapsed.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastSentenceEnd > maxChars * 0.6) {
    return truncated.slice(0, lastSentenceEnd + 1);
  }
  return `${truncated}…`;
}
