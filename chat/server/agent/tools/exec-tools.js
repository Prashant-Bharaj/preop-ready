/**
 * Execution tool handlers — shell commands + MCP calls.
 *
 * execute_command spawns inside WORKSPACE_DIR with detached process-group
 * handling so backgrounded shell jobs (`cmd &`) can be killed cleanly.
 * use_mcp_tool is a thin proxy to the in-process MCP handler.
 */

import { spawn } from 'node:child_process';
import { WORKSPACE_DIR } from '../../core/paths.js';
import { callMcpTool } from '../../mcp/handlers.js';
import { makeToolEventPayload } from './core.js';
import { EXEC_IDLE_KILL_MS } from '../../config/defaults.js';
import { checkWritePermission } from './util/check-permissions.js';
import { resolveWorkspacePath, PathEscapeError } from './util/resolve-path.js';

// ── execute_command ──

export async function toolExecuteCommand(params, ctx) {
  const { emit, signal } = ctx || {};
  const cwd = (ctx && ctx.workspaceDir) || WORKSPACE_DIR;
  const cmd = params.command;
  if (!cmd) throw new Error('execute_command: missing command');
  const timeoutSec = params.timeout ? parseInt(params.timeout, 10) : 120;

  // Emit the command-run marker exactly like Cline does
  emit({ say: 'command', text: cmd });

  return new Promise((resolve, reject) => {
    // detached: true puts the shell in its own process group so we can kill
    // the ENTIRE tree (including backgrounded `&` children) by signalling
    // `-pid`. Without this, `node src/index.js &` leaves a zombie listener
    // bound to port 3000 that survives the shell's exit and also holds our
    // stdout pipe open, so `close` never fires until the zombie dies on its
    // own — which can be never.
    const proc = spawn(cmd, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    const maxCapture = 100_000; // cap returned output to the model

    // Kill the whole process group. Try SIGTERM first, then SIGKILL ~2s later
    // if anything in the group is still alive. Guarded with try/catch because
    // the group may already be gone.
    let killed = false;
    const killGroup = () => {
      if (killed) return;
      killed = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* group already gone */ }
      setTimeout(() => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ }
      }, 2000).unref();
    };

    const onChunk = (chunk, stream) => {
      const text = chunk.toString();
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      emit({ ask: 'command_output', text });
    };

    proc.stdout.on('data', (c) => onChunk(c, 'stdout'));
    proc.stderr.on('data', (c) => onChunk(c, 'stderr'));

    const timer = setTimeout(killGroup, timeoutSec * 1000);

    if (signal) {
      if (signal.aborted) killGroup();
      else signal.addEventListener('abort', killGroup, { once: true });
    }

    // Idle-kill: if the command contains a TRUE background `&` and stdout/stderr
    // go quiet for 5s, assume the foreground work finished but a backgrounded
    // child is holding the pipe open. Kill the group so we don't hang until
    // the global timeout.
    //
    // Earlier the regex was `/[^&]&(?!&)/` which false-matched the `&` in shell
    // redirects like `2>&1`. That killed `docker-compose build 2>&1` at 5s of
    // quiet time between layer builds — the idle-kill thought the whole command
    // had backgrounded. The new regex requires whitespace BEFORE the `&` (so
    // `2>&1`, `>&2`, `3>&4` etc. don't match — the `&` there is glued to `>`
    // with no space) and excludes `&&` via negative lookahead. That correctly
    // catches `npm run dev &`, `sleep 10 & echo done`, `cmd &; other` while
    // leaving shell FD redirects alone.
    const hasBackgroundOp = /\s&(?!&)/.test(cmd);
    let idleTimer = null;
    const resetIdle = () => {
      if (!hasBackgroundOp) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(killGroup, EXEC_IDLE_KILL_MS);
      idleTimer.unref();
    };
    if (hasBackgroundOp) {
      resetIdle();
      proc.stdout.on('data', resetIdle);
      proc.stderr.on('data', resetIdle);
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      const combined = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).slice(-maxCapture);
      const suffix = `\n\n(exit code: ${code ?? 'killed'})`;
      resolve(combined + suffix);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      reject(new Error(`execute_command: ${err.message}`));
    });
  });
}

/**
 * W1.PATH — Section E hook. Only the destructive shell patterns are gated
 * here; the vast majority of execute_command calls (npm install, docker
 * compose build, node --check, etc.) are allowed without inspection.
 *
 * Conservative cheap-detection cascade:
 *   1. Detect destructive file-ops by command-word prefix:
 *        `rm `, `rm -`, `mv `, `cp `, `tee `, `truncate `, `sed -i`, `dd `
 *      ...and check ALL inferrable absolute/relative path tokens against
 *      the write-permission cascade. If any token is denied, deny the
 *      whole command.
 *   2. For commands containing write-redirects (`>`, `>>`), pull out the
 *      tail target path and check it.
 *   3. Otherwise allow.
 *
 * Path inference is heuristic. The exec dispatch already runs inside the
 * workspace `cwd`, so unscoped paths land where they would normally;
 * the gate here is a belt-and-braces against `rm -rf .github/workflows`
 * shaped accidents, not a complete sandboxing strategy.
 */
const DESTRUCTIVE_PREFIXES = [
  /^\s*rm\b/,
  /^\s*mv\b/,
  /(^|[\s&|;])rm\s+-/,
  /(^|[\s&|;])mv\s+/,
];

/**
 * Strip the contents of quoted strings (both single and double quotes) from
 * the command before doing destructive-pattern / path-token analysis. The
 * shell treats quoted content as a single literal argument: characters
 * inside the quotes are NOT shell operators. Without this stripping, the
 * destructive-pattern detector matches the `>` inside `grep "</div>"`,
 * the redirect-target extractor pulls a fake path from inside a regex
 * pattern, and the path tokenizer treats regex strings as filesystem
 * paths. Empirically observed on 2026-05-21 t11-v8 smoke when the
 * frontend subagent's grep self-check `grep -rn "REPLACE-ME\|(stub)</div>"
 * frontend/src/components/` was BLOCKED because the `\|` and `</div>`
 * were classified as path-like tokens. Quoted content is data, not paths.
 */
function stripQuoted(cmd) {
  // Single-quoted: ' ... ' (no escapes inside)
  // Double-quoted: " ... " (allow escaped quotes \" but lazy match is fine
  // for our defensive use). Replace with placeholders so position-sensitive
  // regexes (DESTRUCTIVE_PREFIXES that anchor on word boundaries) still
  // work without seeing the quoted bytes.
  return cmd
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function inferPathTokens(cmd) {
  // Tokenize ONLY on the quote-stripped command — see stripQuoted comment
  // above. Tokens that were inside quotes are now empty strings and get
  // filtered out below.
  const stripped = stripQuoted(cmd);
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const candidates = [];
  for (const raw of tokens) {
    // Strip leading flags / option separators.
    const t = raw.replace(/^[-]+/, '');
    if (t.startsWith('--')) continue;
    if (t.length === 0) continue;
    if (t === '""' || t === "''") continue; // residue from stripQuoted
    if (t.includes('/') || /\.(yml|yaml|json|md|ts|tsx|js|jsx|py|sql|env|conf|sh|toml)$/.test(t)) {
      candidates.push(t);
    } else if (t.startsWith('.') && t.length > 1 && !t.startsWith('..')) {
      candidates.push(t);
    }
  }
  // Pull out a write-redirect target if present: `> path` / `>> path`.
  // Use the stripped command so `<div>` inside a quoted regex doesn't
  // confuse the regex.
  const redirMatch = stripped.match(/[>]{1,2}\s*([^\s|&;]+)/);
  if (redirMatch) candidates.push(redirMatch[1]);
  return candidates;
}

toolExecuteCommand.checkPermissions = function (params, ctx) {
  if (!params || typeof params.command !== 'string') {
    return { verdict: 'deny', reason: 'execute_command: missing or non-string command' };
  }
  const cmd = params.command;
  const workspaceDir = (ctx && ctx.workspaceDir) || WORKSPACE_DIR;

  // Apply destructive-pattern detection on the QUOTE-STRIPPED command, so
  // a `>` or `rm` inside a quoted string (e.g., `grep "</div>"` or
  // `grep "rm -rf"`) is treated as data, not a shell operator.
  const stripped = stripQuoted(cmd);
  const isDestructive = DESTRUCTIVE_PREFIXES.some(re => re.test(stripped))
    || />{1,2}\s*[^\s|&;]/.test(stripped); // any write redirect counts as destructive
  if (!isDestructive) return { verdict: 'allow', reason: null };

  const tokens = inferPathTokens(cmd);
  for (const t of tokens) {
    let abs;
    try {
      abs = resolveWorkspacePath(t, { workspaceDir, scope: ctx?.scope });
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return { verdict: 'deny', reason: `execute_command: ${err.message}` };
      }
      continue;
    }
    const verdict = checkWritePermission(abs, { workspaceDir, scope: ctx?.scope });
    if (verdict.verdict === 'deny') {
      return {
        verdict: 'deny',
        reason: `execute_command would touch '${t}': ${verdict.reason}`,
      };
    }
  }
  return { verdict: 'allow', reason: null };
};

// ── use_mcp_tool ──

export async function toolUseMcpTool(params, ctx) {
  const { emit } = ctx || {};
  const serverName = params.server_name;
  const toolName = params.tool_name;
  const argsRaw = params.arguments || '{}';

  if (serverName !== 'platform-tools') {
    throw new Error(`use_mcp_tool: unknown server_name "${serverName}". Only "platform-tools" is available.`);
  }
  if (!toolName) throw new Error('use_mcp_tool: missing tool_name');

  let args;
  try {
    args = typeof argsRaw === 'object' ? argsRaw : JSON.parse(argsRaw);
  } catch {
    throw new Error(`use_mcp_tool: arguments is not valid JSON: ${String(argsRaw).slice(0, 200)}`);
  }

  // Event — surface the MCP call in the UI the same way Cline does
  emit(makeToolEventPayload('use_mcp_tool', {
    content: JSON.stringify({ tool_name: toolName, arguments: args }),
  }));

  // W3.TEL Section M item 3 — thread sessionId/scope/phase from the agent
  // loop's ctx (set per-call in agent.js, line ~1305) into the MCP handler
  // opts. The get_snippet handler reads them when appending to
  // <workspaceDir>/.harness/snippet-fetches.jsonl. Other MCP tools ignore
  // these opts today; passing them unconditionally is forward-compatible
  // for any future tool that wants the same correlation keys (e.g. a
  // structured `get_rules` fetch log).
  //
  // ctx.phaseMachine.phase carries the current phase per phase.js; fall
  // back to null when the dispatcher was invoked outside a phase machine
  // (defensive — every production dispatch has one, but tests may not).
  const phase = ctx?.phaseMachine?.phase || null;
  const result = callMcpTool(toolName, args, {
    workspaceDir: WORKSPACE_DIR,
    sessionId: ctx?.sessionId || null,
    scope: ctx?.scope || null,
    phase,
  });
  return result;
}
