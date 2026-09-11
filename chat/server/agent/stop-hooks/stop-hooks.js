/**
 * Stop hooks (Track B item B3) — let attempt_completion land, then validate.
 *
 * Replaces the post-completion suppression cascade that used to live inline
 * in agent.js (the "SUPPRESSED attempt_completion" class — mechanism #1 in
 * the Track B inventory). New flow:
 *
 *   1. Agent loop holds attempt_completion aside (unchanged).
 *   2. After the dispatch round finishes, agent calls runStopHooks(report, ctx).
 *   3. runStopHooks runs validators in priority order, short-circuiting on
 *      the first blocking validator (preserves the existing single-issue UX).
 *   4. If no validator blocks → { blocking: false }; agent terminates with
 *      the completion text.
 *   5. If a validator blocks → { blocking: true, message, sideEffects? };
 *      agent continues the loop, injecting the directive message in the next
 *      user turn instead of firing attempt_completion.
 *
 * Modeled on Claude Code's handleStopHooks (query/stopHooks.ts:65-295) — the
 * "let-it-land + post-validate + inject directive + continue" pattern.
 *
 * Validators absorbed:
 *   - tool-error-batching   (was the SUPPRESSED-class trigger; this is the
 *                            big one B3 retires permanently)
 *   - ghost-file            (was validateReportFilePaths in agent.js)
 *   - scope-required-files  (was findMissingScopeRequirements in agent.js)
 *   - pre-build-CHECK-4     (was preBuildSuppress predicate in agent.js)
 *
 * Each validator returns the uniform shape:
 *   { name, blocking, header?, directive, footer?, sideEffects?, logTag? }
 *
 * All synchronous — validators inspect already-collected state (toolErrors,
 * pendingCompletion, writtenPaths, etc.) and read the workspace via the
 * scope-deliverables helpers. No I/O races with the LLM call.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateReportFilePaths,
  findMissingScopeRequirements,
  detectBackendLanguage,
} from './scope-deliverables.js';
import { formatToolError, composeBlockingMessage } from './error-formatter.js';
import {
  BANNED_LLM_PATTERNS,
  listBackendSourceFiles,
} from '../../reconciler/mga-wiring-check.js';
import {
  ERROR_MIDDLEWARE_RE,
  REJECTION_GUARD_RE,
} from '../../reconciler/structural-checks.js';

// ─────────────────────────────────────────────────────────────────────────────
// Validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool-error batching validator — the SUPPRESSED-class trigger that B3
 * retires. Fires when the model bundled attempt_completion in a response
 * that ALSO had one or more tool calls that errored. Today's failure mode:
 * the model treats "SUPPRESSED" as procedural noise and re-emits the same
 * completion next turn (or, worse, does extra work to compensate). The new
 * directive is specific: list which tools failed, give a per-tool hint,
 * tell the model to fix and retry.
 */
function toolErrorBatchingValidator(_report, ctx) {
  if (!ctx.toolErrors || ctx.toolErrors.length === 0) {
    return { name: 'tool-error-batching', blocking: false };
  }
  const lines = ctx.toolErrors.map((e) =>
    formatToolError(e.name, e.path, e.snippet)
  );
  return {
    name: 'tool-error-batching',
    blocking: true,
    header: `Your attempt_completion didn't land — ${ctx.toolErrors.length} tool call${ctx.toolErrors.length === 1 ? '' : 's'} in the same response failed:`,
    directive: lines.join('\n'),
    footer: 'Fix the failures, then retry attempt_completion alone (no other tools in the same response).',
    logTag: `attempt_completion deferred — ${ctx.toolErrors.length} tool error(s) in same batch`,
  };
}

/**
 * Ghost-file validator — completion report claims paths that don't exist on
 * disk. Catches the bug class where the model mis-names a file in the report
 * (e.g. "src/server.js" when the real file is "src/index.js"). Polluted
 * claims persist into future turns via MGA conversation memory; cheaper to
 * fix the report now than to chase the ghost later.
 */
function ghostFileValidator(report, ctx) {
  // Only run when no tool errors — matches the original cascade ordering.
  if (ctx.toolErrors && ctx.toolErrors.length > 0) {
    return { name: 'ghost-file', blocking: false };
  }
  const lies = validateReportFilePaths(report, ctx.workspaceDir);
  if (lies.length === 0) {
    return { name: 'ghost-file', blocking: false };
  }
  const actual = ctx.writtenPaths ? [...ctx.writtenPaths] : [];
  const actualList = actual.length > 0
    ? `Actual paths you wrote this run:\n${actual.map((p) => `- ${p}`).join('\n')}`
    : '(No write_to_file / replace_in_file succeeded this run.)';
  return {
    name: 'ghost-file',
    blocking: true,
    header: `Your attempt_completion didn't land — the **Files:** section claims ${lies.length} path${lies.length === 1 ? '' : 's'} that don't exist on disk: ${lies.join(', ')}.`,
    directive: actualList,
    footer: 'Retry attempt_completion with only the paths you actually wrote.',
    logTag: `attempt_completion deferred — report claims ${lies.length} non-existent path(s): ${lies.join(', ')}`,
  };
}

/**
 * Scope-required-files validator — language committed but a build-critical
 * file is missing. Without this, soft prompt rules in scope-backend.md are
 * empirically ignored and `docker-compose build` fails before app start.
 * Per-scope copy ensures the directive points at the right rule.
 */
function scopeRequiredFilesValidator(_report, ctx) {
  if (ctx.toolErrors && ctx.toolErrors.length > 0) {
    return { name: 'scope-required-files', blocking: false };
  }
  const missing = findMissingScopeRequirements(ctx.scope, ctx.workspaceDir);
  if (missing.length === 0) {
    return { name: 'scope-required-files', blocking: false };
  }

  let header;
  let footer;
  if (ctx.scope === 'backend') {
    const lang = detectBackendLanguage(ctx.workspaceDir);
    const langLabel = lang || 'detected';
    header = `Your attempt_completion didn't land — language-required files missing for ${langLabel} backend: ${missing.join(', ')}.`;
    footer =
      'These are not optional. The Dockerfile build step depends on them; ' +
      '`docker-compose build` will fail before the app starts. ' +
      'Note: a re-export shim (e.g. `backend/main.py` containing only `from src.main import app`) does NOT count — the file must contain the actual FastAPI / Express app definition. ' +
      'See scope-backend.md (Required deliverables — language deps file) for the exact baseline content.';
  } else if (ctx.scope === 'integration') {
    header = `Your attempt_completion didn't land — integration scope missing required file(s): ${missing.join(', ')}.`;
    footer =
      '`docker-compose.yml` at the workspace root is non-optional. Without it, `compose up` skips and the deploy is silent-failed. ' +
      'nginx configs alone are not enough — the integration scope must produce a compose file that wires up backend / frontend / database / vectordb (whichever scopes are present).';
  } else {
    header = `Your attempt_completion didn't land — ${ctx.scope} scope missing required file(s): ${missing.join(', ')}.`;
    footer = 'Write the missing file(s) with write_to_file, then retry attempt_completion.';
  }

  return {
    name: 'scope-required-files',
    blocking: true,
    header,
    directive: 'Write the missing file(s) with write_to_file, then retry attempt_completion.',
    footer,
    logTag: `attempt_completion deferred — ${ctx.scope} scope missing ${missing.length} language-required file(s): ${missing.join(', ')}`,
  };
}

/**
 * Scaffold-markers validator — Python backend only (lazy
 * `raise NotImplementedError` self-stubs).
 *
 * Node backend was removed from this check on 2026-05-22: the routes.ts
 * scaffold is no longer pre-staged (backend writes from scratch via
 * write_to_file). Frontend component stubs were removed the same day for
 * the same reason — the LLM treated stubs as decorative, composed
 * replace_in_file SEARCH from training-data priors, and burned 8+ turns
 * per component. Frontend now authors components from scratch too.
 *
 * Python backend: even though the LLM writes `main.py` from scratch, it
 * sometimes leaves `raise NotImplementedError` placeholders. Keep that
 * check as a backstop.
 */
function scaffoldMarkersValidator(_report, ctx) {
  if (ctx.toolErrors && ctx.toolErrors.length > 0) {
    return { name: 'scaffold-markers', blocking: false };
  }

  // Per-scope candidate list. Backend covers route handlers; frontend
  // covers component stubs. Other scopes have no scaffold-marker file
  // pattern (database init.sql is generated, integration writes from
  // scratch, vectordb is short).
  let candidates;
  if (ctx.scope === 'backend') {
    // Python only — Node routes.ts is no longer pre-staged, so no scaffold
    // markers can remain in it. Python main.py is LLM-written from scratch
    // but occasionally left with `raise NotImplementedError`.
    candidates = [
      { path: 'backend/main.py', markers: [/raise\s+NotImplementedError/g] },
    ];
  } else {
    // Frontend no longer has component scaffolds (removed 2026-05-22).
    return { name: 'scaffold-markers', blocking: false };
  }

  // Collect findings with BYTE-EXACT line content. The LLM was previously
  // told only "1 line(s) remain" and then composed SEARCH from imagination
  // for what it thought the marker line looked like — empirically that
  // spirals (v7: 19+ turns of failed SEARCH; v8: same). Giving the model
  // the exact disk bytes for each remaining line means its next
  // `replace_in_file` SEARCH has a verbatim source it can copy.
  const findings = [];
  for (const c of candidates) {
    const abs = path.join(ctx.workspaceDir, c.path);
    if (!existsSync(abs)) continue;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const hits = []; // [{ lineNumber, content }]
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let matched = false;
      for (const re of c.markers) {
        if (re.test(lines[i])) matched = true;
        re.lastIndex = 0; // reset between iterations (global flag)
      }
      if (matched) hits.push({ lineNumber: i + 1, content: lines[i] });
    }
    if (hits.length > 0) {
      findings.push({ path: c.path, hits });
    }
  }

  if (findings.length === 0) {
    return { name: 'scaffold-markers', blocking: false };
  }

  // Build a structured per-file block showing each remaining marker WITH
  // the exact line content the model needs to use as a SEARCH source.
  // Cap each line at 200 chars to keep the directive readable even on
  // long lines.
  const fileList = findings
    .map((f) => {
      const lineDump = f.hits
        .map((h) => `  Line ${h.lineNumber}: ${truncateForDirective(h.content)}`)
        .join('\n');
      return `- ${f.path} — ${f.hits.length} remaining marker${f.hits.length === 1 ? '' : 's'}:\n${lineDump}`;
    })
    .join('\n\n');

  // Only Python backend reaches this branch (Node + frontend short-circuit
  // earlier — no scaffolds = no markers).
  const header = `Your attempt_completion didn't land — \`raise NotImplementedError\` placeholders are still in your FastAPI handlers. Every contracted endpoint must have a REAL handler body before status=complete.`;
  const directive = `Files with remaining placeholders (line numbers + EXACT current content):\n${fileList}\n\nThose lines above are byte-exact disk content. Either \`write_to_file\` the whole corrected file or compose a \`replace_in_file\` whose SEARCH copies the line(s) verbatim and whose REPLACE is the real handler implementation per api_contract + business_logic_contract. Keep route paths, HTTP methods, and handler signatures untouched (those are contract-locked).`;
  const footer = `Re-run \`python -m mypy . --strict\` after your edits, then retry attempt_completion.`;

  return {
    name: 'scaffold-markers',
    blocking: true,
    header,
    directive,
    footer,
    logTag: `attempt_completion deferred — scaffold placeholders still present in ${findings.map((f) => f.path).join(', ')} (${findings.reduce((n, f) => n + f.hits.length, 0)} line(s))`,
  };
}

function truncateForDirective(s) {
  const MAX = 200;
  if (typeof s !== 'string') return '';
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + ` …(truncated, ${s.length - MAX} more chars)`;
}

/**
 * Backend error-handler validator — Node backend only. A single rejected
 * await in a route handler must never kill the process (Express 4 does not
 * route async rejections to error middleware; the process guard is the
 * actual crash stopper). Both pieces are in the index.ts skeleton the
 * subagent prompt mandates; this validator makes the mandate enforceable
 * while the agent can still fix it in-context.
 */
function backendErrorHandlerValidator(_report, ctx) {
  if (ctx.toolErrors && ctx.toolErrors.length > 0) {
    return { name: 'backend-error-handler', blocking: false };
  }
  if (ctx.scope !== 'backend') {
    return { name: 'backend-error-handler', blocking: false };
  }
  if (detectBackendLanguage(ctx.workspaceDir) !== 'node') {
    // FastAPI survives handler exceptions natively — no process guard needed.
    return { name: 'backend-error-handler', blocking: false };
  }

  const files = listBackendSourceFiles(ctx.workspaceDir);
  const hasMiddleware = files.some(({ content }) => ERROR_MIDDLEWARE_RE.test(content));
  const hasGuard = files.some(({ content }) => REJECTION_GUARD_RE.test(content));
  if (hasMiddleware && hasGuard) {
    return { name: 'backend-error-handler', blocking: false };
  }

  const missing = [];
  if (!hasMiddleware) missing.push('the 4-arg Express error middleware (`app.use((err, _req, res, _next) => …)` as the LAST app.use)');
  if (!hasGuard) missing.push("the process guard (`process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason))` — log, never exit)");
  return {
    name: 'backend-error-handler',
    blocking: true,
    header: `Your attempt_completion didn't land — the backend is missing ${missing.length === 2 ? 'both crash guards' : 'a crash guard'}: ${missing.join(' and ')}.`,
    directive: 'Add the missing piece(s) to src/index.ts (they are part of the mandated skeleton), then retry attempt_completion.',
    footer: 'Without them, one failed await (e.g. an unreachable external API) kills the container and every route 502s.',
    logTag: `attempt_completion deferred — backend missing crash guard(s): ${missing.length}`,
  };
}

/**
 * MGA client-usage validator — fires only when the pre-staged MGA client is
 * on disk (i.e. the contract had ai-chat / mga_assistants). Two invariants:
 * the backend must actually import the client, and no non-MGA LLM hosts or
 * model names may appear in backend source. Shares BANNED_LLM_PATTERNS with
 * the pre-compose gate (reconciler/mga-wiring-check.js) so both layers agree.
 */
function mgaClientUsageValidator(_report, ctx) {
  if (ctx.toolErrors && ctx.toolErrors.length > 0) {
    return { name: 'mga-client-usage', blocking: false };
  }
  if (ctx.scope !== 'backend') {
    return { name: 'mga-client-usage', blocking: false };
  }
  const staged = [
    { rel: 'backend/src/lib/mga-client.ts', importRe: /mga-client(?:\.js)?['"]/, hint: "import { chatWithAssistant, streamChat } from './lib/mga-client.js'" },
    { rel: 'backend/src/mga_client.py', importRe: /(?:from|import)\s+(?:src\.|\.)?mga_client\b/, hint: 'from src.mga_client import chat_with_assistant' },
  ].find((c) => existsSync(path.join(ctx.workspaceDir, c.rel)));
  if (!staged) {
    return { name: 'mga-client-usage', blocking: false };
  }

  const files = listBackendSourceFiles(ctx.workspaceDir);

  const bannedHits = [];
  for (const { rel, content } of files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { re, label } of BANNED_LLM_PATTERNS) {
        if (re.test(lines[i])) {
          bannedHits.push(`- ${rel}:${i + 1} (${label}): ${truncateForDirective(lines[i].trim())}`);
        }
      }
    }
  }
  if (bannedHits.length > 0) {
    return {
      name: 'mga-client-usage',
      blocking: true,
      header: `Your attempt_completion didn't land — backend source references non-MGA LLM hosts/models (${bannedHits.length} line${bannedHits.length === 1 ? '' : 's'}):`,
      directive: bannedHits.join('\n'),
      footer: `The ONLY LLM transport is the pre-staged ${staged.rel} (${staged.hint}). Remove the lines above, route the calls through the client, then retry attempt_completion.`,
      logTag: `attempt_completion deferred — ${bannedHits.length} banned LLM reference(s) in backend source`,
    };
  }

  const referenced = files.some(({ rel, content }) => rel !== staged.rel && staged.importRe.test(content));
  if (!referenced) {
    return {
      name: 'mga-client-usage',
      blocking: true,
      header: `Your attempt_completion didn't land — the pre-staged MGA client (${staged.rel}) is never imported by your code.`,
      directive: `Every MGA call must go through it: ${staged.hint}. Wire your AI endpoint handler(s) to the client, then retry attempt_completion.`,
      footer: 'Hand-rolled MGA transports are blocked by the pre-compose gate; using the client now avoids a fix dispatch later.',
      logTag: 'attempt_completion deferred — pre-staged MGA client unused',
    };
  }

  return { name: 'mga-client-usage', blocking: false };
}

/**
 * Whoami-contract validator — role-gated backends must advertise the dev
 * persona surface (reference/user-identity.md): GET /whoami returns
 * `devMode` and `availableRoles`. The pre-staged DevRoleSwitcher keys off
 * those fields; a bare {id,email,role} whoami silently disables local role
 * switching (observed live — backend implemented the role claim but not
 * the whoami shape).
 */
function whoamiContractValidator(_report, ctx) {
  if (ctx.toolErrors && ctx.toolErrors.length > 0) {
    return { name: 'whoami-contract', blocking: false };
  }
  if (ctx.scope !== 'backend') {
    return { name: 'whoami-contract', blocking: false };
  }
  const files = listBackendSourceFiles(ctx.workspaceDir);
  const all = files.map((f) => f.content).join('\n');
  const hasWhoami = /['"`]\/whoami['"`]/.test(all);
  const roleGated = /requireRole\s*\(|\.role\s*[!=]==/.test(all);
  if (!hasWhoami || !roleGated) {
    return { name: 'whoami-contract', blocking: false };
  }

  // When the locked identity parser is staged, hand-rolled x-amzn-oidc-data
  // parsing outside it is the drift that produced wrong devMode/roleClaim
  // semantics (observed live: switcher hid itself, personas got default
  // roles). The parser must be the only reader.
  const stagedParser = ['backend/src/lib/oidc-identity.ts', 'backend/src/oidc_identity.py']
    .find((rel) => existsSync(path.join(ctx.workspaceDir, rel)));
  if (stagedParser) {
    const manualParsers = files.filter(({ rel, content }) =>
      rel !== stagedParser && /x-amzn-oidc-data/.test(content));
    if (manualParsers.length > 0) {
      return {
        name: 'whoami-contract',
        blocking: true,
        header: `Your attempt_completion didn't land — ${manualParsers.length} file(s) read x-amzn-oidc-data directly instead of using the pre-staged parser (${stagedParser}).`,
        directive: `Files: ${manualParsers.map((f) => f.rel).join(', ')}. Replace the hand-rolled parsing with ${stagedParser.endsWith('.py') ? 'parse_oidc_identity(request)' : 'parseOidcIdentity(req)'} — it owns the devMode and roleClaim semantics (reference/user-identity.md).`,
        footer: 'Rewire identity through the locked parser, then retry attempt_completion.',
        logTag: `attempt_completion deferred — manual OIDC parsing outside ${stagedParser}`,
      };
    }
  }

  const hasDevMode = /devMode/.test(all);
  const hasAvailableRoles = /availableRoles/.test(all);
  if (hasDevMode && hasAvailableRoles) {
    return { name: 'whoami-contract', blocking: false };
  }
  const missing = [!hasDevMode && '`devMode`', !hasAvailableRoles && '`availableRoles`'].filter(Boolean).join(' and ');
  return {
    name: 'whoami-contract',
    blocking: true,
    header: `Your attempt_completion didn't land — this app is role-gated but GET /whoami does not return ${missing}.`,
    directive:
      'Per reference/user-identity.md, /whoami must return `devMode` (true when the OIDC token carries `dev: true` or no OIDC header was present) and `availableRoles` (the app\'s role enum as a string array). The pre-staged DevRoleSwitcher renders from these fields — without them, local role switching is silently disabled.',
    footer: 'Add the two fields to the /whoami response, then retry attempt_completion.',
    logTag: 'attempt_completion deferred — role-gated app with shapeless /whoami',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validators run in this order. First blocking wins; later validators are
 * skipped. Order:
 *   tool-error-batching → ghost-file → scope-required-files → scaffold-markers
 *   → backend-error-handler → mga-client-usage
 *
 * Tool-error-batching first so a model that bundles a failed sibling tool
 * with attempt_completion sees the per-tool hints, not a "ghost file" red
 * herring caused by the failed write that never landed. Ghost-file and
 * scope-required-files are mutually exclusive in practice (ghost paths
 * implies a misnamed write, scope-required implies a missed write).
 * Scaffold-markers runs last (after scope-required-files confirmed the
 * canonical scaffold file exists) — catches the fake-PASS where the file
 * exists but its handler bodies are all still 501 placeholders.
 *
 * tryAutoStartApp at the session boundary runs the build authoritatively
 * (and `compose up`, and waitForHttp); failures there fail the session
 * with a clear error message. The harness no longer double-checks the
 * build at agent loop time.
 */
const VALIDATORS = [
  toolErrorBatchingValidator,
  ghostFileValidator,
  scopeRequiredFilesValidator,
  scaffoldMarkersValidator,
  backendErrorHandlerValidator,
  mgaClientUsageValidator,
  whoamiContractValidator,
];

/**
 * Run the cascade for the held-aside attempt_completion. If any validator
 * blocks, return its directive composed via composeBlockingMessage (a single
 * directive user message ready to inject as the next turn's input). If
 * nothing blocks, return { blocking: false } and let the caller terminate
 * cleanly.
 *
 * @param {string} report  The attempt_completion `result` text.
 * @param {{
 *   toolErrors: Array<{name: string, path?: string, snippet: string}>,
 *   scope: string,
 *   workspaceDir: string,
 *   writtenPaths?: Set<string>,
 *   phaseMachine: object,
 *   verificationBuildAttempted: boolean,
 *   preBuildSuppressionFired: boolean,
 * }} ctx
 * @returns {{
 *   blocking: boolean,
 *   message?: string,
 *   logTag?: string,
 *   sideEffects?: { preBuildSuppressionFired?: true },
 *   results?: Array<{name: string, blocking: boolean}>,
 * }}
 */
export function runStopHooks(report, ctx) {
  for (const validator of VALIDATORS) {
    const r = validator(report, ctx);
    if (r.blocking) {
      return {
        blocking: true,
        message: composeBlockingMessage([r]),
        logTag: r.logTag,
        sideEffects: r.sideEffects,
        results: [r],
      };
    }
  }
  return { blocking: false };
}
