import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { getCredentials } from './auth.js';
import { redact, setSensitiveStrings } from './redact.js';
import { appendEvent, readTail } from './transcript.js';
import { upsertSession, listSessions } from './session-index.js';
import { WORKSPACE_DIR, CLINE_DIR, BOOTSTRAP_PATH } from './paths.js';
import {
  initMiddleware,
  refreshEnvContext,
  gatherEnvContext,
  buildPromptFromSpec,
  buildBootstrapPrompt,
  verifyAppHealth,
  buildErrorPrompt,
  canRetry,
  routeMessage,
} from './middleware/index.js';

let activeSession = null;
let middlewareReady = false;

// Initialize middleware (env context) in background
initMiddleware().then(() => {
  middlewareReady = true;
}).catch(err => {
  console.error('[session] Middleware init failed (non-fatal):', err.message);
  middlewareReady = true; // still allow requests, will use fallback
});

export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(50);

function getSession(sessionId) {
  if (!activeSession || activeSession.id !== sessionId) return null;
  return activeSession;
}

/**
 * Resolve paths to the node binary and cline script.
 * When cline is installed under a different nvm version, we use that version's
 * node binary so the script can find its dependencies.
 */
function resolveClinePaths() {
  // 1. Env var override
  if (process.env.CLINE_BIN && existsSync(process.env.CLINE_BIN)) {
    const binDir = path.dirname(process.env.CLINE_BIN);
    const nodeInSameDir = path.join(binDir, 'node');
    return {
      nodePath: existsSync(nodeInSameDir) ? nodeInSameDir : process.execPath,
      clineScript: process.env.CLINE_BIN,
    };
  }

  // 2. Try `which cline`
  try {
    const result = execSync('which cline', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result && existsSync(result)) {
      const binDir = path.dirname(result);
      const nodeInSameDir = path.join(binDir, 'node');
      return {
        nodePath: existsSync(nodeInSameDir) ? nodeInSameDir : process.execPath,
        clineScript: result,
      };
    }
  } catch { /* not on PATH */ }

  // 3. Check alongside the current node binary
  const currentBinDir = path.dirname(process.execPath);
  const siblingPath = path.join(currentBinDir, 'cline');
  if (existsSync(siblingPath)) {
    return { nodePath: process.execPath, clineScript: siblingPath };
  }

  // 4. Search nvm versions
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '/root', '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  try {
    const entries = execSync(`ls "${versionsDir}" 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n');
    for (const ver of entries.reverse()) {
      const candidate = path.join(versionsDir, ver, 'bin', 'cline');
      if (existsSync(candidate)) {
        return {
          nodePath: path.join(versionsDir, ver, 'bin', 'node'),
          clineScript: candidate,
        };
      }
    }
  } catch { /* no nvm */ }

  // 5. Global npm prefix
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 5000 }).trim();
    const globalPath = path.join(prefix, 'bin', 'cline');
    if (existsSync(globalPath)) {
      const nodeInPrefix = path.join(prefix, 'bin', 'node');
      return {
        nodePath: existsSync(nodeInPrefix) ? nodeInPrefix : process.execPath,
        clineScript: globalPath,
      };
    }
  } catch { /* ignore */ }

  throw new Error('Cline CLI not found. Install with: npm install -g cline');
}

/**
 * Configure Cline auth via one-shot CLI command.
 */
function configureClineAuth(creds) {
  const { nodePath, clineScript } = resolveClinePaths();
  const env = { ...process.env, CLINE_DIR };
  try {
    execSync(
      `"${nodePath}" "${clineScript}" auth -p openai -b "${creds.baseUrl}" -k "${creds.apiKey}" -m "${creds.model}"`,
      { cwd: WORKSPACE_DIR, env, stdio: 'pipe', timeout: 15000 }
    );
  } catch (err) {
    const safeMsg = err.message?.replace(creds.apiKey, '[REDACTED]') || 'unknown error';
    console.error('[session] Failed to configure Cline auth:', safeMsg);
    throw new Error('Failed to configure Cline authentication');
  }
}

/**
 * Find the most recent Cline task ID from the tasks directory.
 */
function findLatestClineTaskId() {
  const tasksDir = path.join(CLINE_DIR, 'data', 'tasks');
  if (!existsSync(tasksDir)) return null;
  try {
    const entries = readdirSync(tasksDir).filter(e => /^\d+$/.test(e)).sort();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Run a single Cline task as a child process.
 * Each message spawns a new short-lived process. Conversation continuity
 * is maintained via Cline's -T (taskId) flag which resumes from the
 * previous conversation history.
 *
 * When resuming, Cline replays all previous events before emitting new ones.
 * We filter these replayed events by watching for the `ask/resume_task` marker.
 */
function runClineTask(sessionId, prompt, { clineTaskId = null } = {}) {
  return new Promise((resolve, reject) => {
    const { nodePath, clineScript } = resolveClinePaths();
    const isResume = !!clineTaskId;

    const args = [clineScript, '--yolo', '--json'];
    if (clineTaskId) {
      args.push('-T', clineTaskId);
    }
    args.push('-c', WORKSPACE_DIR);
    args.push(prompt);

    console.log('[session] Running Cline task: resume=%s taskId=%s', isResume, clineTaskId || 'new');

    const proc = spawn(nodePath, args, {
      cwd: WORKSPACE_DIR,
      env: { ...process.env, CLINE_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Store proc reference for kill on reset
    if (activeSession?.id === sessionId) {
      activeSession.currentProc = proc;
    }

    // When resuming, skip replayed events until we see ask/resume_task
    let passthrough = !isResume;

    // Line-buffered JSON parsing
    let stdoutBuffer = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const redacted = redact(line);
        try {
          const clineEvent = JSON.parse(redacted);

          // Filter replayed events on resume
          if (!passthrough) {
            if (clineEvent.ask === 'resume_task') {
              passthrough = true;
            }
            continue; // skip replayed events (and the resume_task itself)
          }

          // Skip internal meta events
          if (clineEvent.say === 'user_feedback') continue;

          // Track if docker commands are being run (for response verification)
          if (clineEvent.say === 'command') {
            const cmdText = typeof clineEvent.text === 'string' ? clineEvent.text : '';
            if (cmdText.includes('docker-compose') || cmdText.includes('docker compose') || cmdText.includes('docker build')) {
              if (activeSession?.id === sessionId) {
                activeSession.ranDockerCommands = true;
              }
            }
          }

          const event = appendEvent(sessionId, 'cline', clineEvent);
          sessionEvents.emit('event', sessionId, event);
        } catch {
          if (passthrough) {
            const event = appendEvent(sessionId, 'stdout', redacted);
            sessionEvents.emit('event', sessionId, event);
          }
        }
      }
    });

    // stderr — log only, don't send to frontend
    let stderrBuffer = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        console.error('[cline stderr]', redact(line));
      }
    });

    // Use 'close' event (fires after all stdio streams are fully consumed)
    // rather than 'exit' (which can fire before stdout is drained)
    proc.on('close', (exitCode) => {
      // Flush any remaining buffered data
      if (stdoutBuffer.trim()) {
        const redacted = redact(stdoutBuffer);
        try {
          const clineEvent = JSON.parse(redacted);
          if (passthrough && clineEvent.say !== 'user_feedback') {
            const event = appendEvent(sessionId, 'cline', clineEvent);
            sessionEvents.emit('event', sessionId, event);
          }
        } catch {
          if (passthrough) {
            const event = appendEvent(sessionId, 'stdout', redacted);
            sessionEvents.emit('event', sessionId, event);
          }
        }
      }

      console.log('[session] Cline task completed: exitCode=%s', exitCode);
      const latestTaskId = findLatestClineTaskId();
      resolve({ exitCode, clineTaskId: latestTaskId });
    });

    proc.on('error', (err) => {
      console.error('[session] Cline process error:', err.message);
      reject(err);
    });
  });
}

export function mountSessionRoutes(app) {
  app.post('/api/session/start', async (_req, res) => {
    try {
      const creds = getCredentials();
      if (!creds) {
        return res.status(400).json({ error: 'Missing config' });
      }

      // Return existing session if still active
      if (activeSession && activeSession.status !== 'error') {
        return res.json({ sessionId: activeSession.id });
      }

      setSensitiveStrings([creds.apiKey]);

      try {
        configureClineAuth(creds);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }

      const sessionId = randomUUID();
      const now = Date.now();
      activeSession = {
        id: sessionId,
        clineTaskId: null,
        routerConversationId: null,
        status: 'working',
        currentProc: null,
        startedAt: now,
      };

      // Persist to session index
      upsertSession({ sessionId, createdAt: now, lastMessageAt: now });

      // Respond immediately so the UI can connect WebSocket
      res.json({ sessionId });

      // Emit initial working status
      appendEvent(sessionId, 'status', { status: 'working' });
      sessionEvents.emit('event', sessionId, {
        ts: Date.now(), type: 'status', payload: { status: 'working' },
      });

      // Run bootstrap prompt asynchronously (events stream via WebSocket)
      try {
        const bootstrapContent = readFileSync(BOOTSTRAP_PATH, 'utf-8');
        const creds = getCredentials();

        // Build enriched bootstrap with environment context
        const envContext = await gatherEnvContext();
        const fullBootstrap = buildBootstrapPrompt(bootstrapContent, envContext, creds);

        appendEvent(sessionId, 'user', { message: '[BOOTSTRAP]', source: 'system' });

        const result = await runClineTask(sessionId, fullBootstrap);
        if (activeSession?.id === sessionId) {
          activeSession.clineTaskId = result.clineTaskId;
          activeSession.status = 'idle';
          activeSession.currentProc = null;
          upsertSession({ sessionId, clineTaskId: result.clineTaskId, lastMessageAt: Date.now() });
        }

        const event = appendEvent(sessionId, 'status', { status: 'idle' });
        sessionEvents.emit('event', sessionId, event);
      } catch (err) {
        console.error('[session] Bootstrap failed:', err.message);
        if (activeSession?.id === sessionId) {
          activeSession.status = 'error';
          activeSession.currentProc = null;
        }
        const event = appendEvent(sessionId, 'status', { status: 'error', error: err.message });
        sessionEvents.emit('event', sessionId, event);
      }
    } catch (err) {
      console.error('[session] Unexpected error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to start session: ' + err.message });
      }
    }
  });

  app.post('/api/session/:sessionId/message', async (req, res) => {
    const session = getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.status === 'working') {
      return res.status(409).json({ error: 'Cline is still working on the previous message' });
    }

    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Record user message
    appendEvent(session.id, 'user', { message });
    sessionEvents.emit('event', session.id, {
      ts: Date.now(), type: 'user', payload: { message },
    });

    // Update session index (set title from first real user message)
    upsertSession({
      sessionId: session.id,
      title: message.slice(0, 80),
      lastMessageAt: Date.now(),
    });

    // Respond immediately
    res.json({ ok: true });

    // Run message through assistant router, then Cline
    try {
      session.status = 'working';
      session.ranDockerCommands = false;
      session.retryCount = session.retryCount || 0;
      sessionEvents.emit('event', session.id, {
        ts: Date.now(), type: 'status', payload: { status: 'working' },
      });

      // ── Step 1: Route through assistant LLM ──
      let enrichedMessage = message;
      if (middlewareReady) {
        try {
          const envContext = await refreshEnvContext();
          const routerResult = await routeMessage(message, envContext, {
            conversationId: session.routerConversationId,
          });

          // Persist conversation ID for multi-turn clarification
          session.routerConversationId = routerResult.conversationId;

          if (routerResult.action === 'clarify') {
            // Router needs more info — relay question to user, go idle
            console.log('[session] Router requests clarification');
            const clarifyEvent = appendEvent(session.id, 'cline', {
              say: 'text',
              text: routerResult.message,
            });
            sessionEvents.emit('event', session.id, clarifyEvent);

            session.status = 'idle';
            session.currentProc = null;
            upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
            const idleEvent = appendEvent(session.id, 'status', { status: 'idle' });
            sessionEvents.emit('event', session.id, idleEvent);
            return; // Wait for user's next message
          }

          // Router says "execute" — build enriched Cline prompt from spec
          if (routerResult.message) {
            const summaryEvent = appendEvent(session.id, 'cline', {
              say: 'text',
              text: routerResult.message,
            });
            sessionEvents.emit('event', session.id, summaryEvent);
          }

          enrichedMessage = buildPromptFromSpec(routerResult, envContext);
          console.log('[session] Router → execute: %d → %d chars, rules=[%s]',
            message.length, enrichedMessage.length, routerResult.rules?.join(', ') || 'none');

          // Reset router conversation after execution dispatch
          // (next user message starts a fresh routing conversation)
          session.routerConversationId = null;
        } catch (err) {
          console.error('[session] Router failed (falling back to raw message):', err.message);
          // Fall back to sending raw message to Cline
        }
      }

      // ── Step 2: Execute via Cline ──
      const result = await runClineTask(session.id, enrichedMessage, {
        clineTaskId: session.clineTaskId,
      });

      if (activeSession?.id === session.id) {
        if (!session.clineTaskId && result.clineTaskId) {
          session.clineTaskId = result.clineTaskId;
          upsertSession({ sessionId: session.id, clineTaskId: result.clineTaskId });
        }

        // ── Step 3: Verify app health after docker tasks ──
        if (session.ranDockerCommands && middlewareReady) {
          try {
            const health = await verifyAppHealth();
            if (!health.healthy && canRetry(session)) {
              console.log('[session] Health check failed, auto-retrying (%d/%d)', session.retryCount + 1, 2);
              session.retryCount++;
              const errorPrompt = buildErrorPrompt(health);
              await runClineTask(session.id, errorPrompt, {
                clineTaskId: session.clineTaskId,
              });
            } else if (!health.healthy) {
              console.log('[session] Health check failed after max retries, notifying user');
              const errorEvent = appendEvent(session.id, 'cline', {
                say: 'text',
                text: `The application has issues after the changes:\n${health.errors.join('\n')}\n\nPlease describe the problem and I'll help fix it.`,
              });
              sessionEvents.emit('event', session.id, errorEvent);
            }
          } catch (err) {
            console.error('[session] Health verification failed (non-fatal):', err.message);
          }
        }

        session.status = 'idle';
        session.currentProc = null;
        upsertSession({ sessionId: session.id, lastMessageAt: Date.now() });
      }

      const event = appendEvent(session.id, 'status', { status: 'idle' });
      sessionEvents.emit('event', session.id, event);
    } catch (err) {
      console.error('[session] Message processing failed:', err.message);
      if (activeSession?.id === session.id) {
        session.status = 'error';
        session.currentProc = null;
      }
      const event = appendEvent(session.id, 'status', { status: 'error', error: err.message });
      sessionEvents.emit('event', session.id, event);
    }
  });

  app.post('/api/session/:sessionId/reset', (_req, res) => {
    if (activeSession) {
      if (activeSession.currentProc) {
        try { activeSession.currentProc.kill(); } catch { /* already dead */ }
      }
      appendEvent(activeSession.id, 'status', { status: 'reset' });
      activeSession = null;
    }
    res.json({ ok: true });
  });

  app.get('/api/session/:sessionId/history', (req, res) => {
    const tail = parseInt(req.query.tail) || 100;
    const events = readTail(req.params.sessionId, tail);
    res.json({ events });
  });

  // ── Session list & resume ──

  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: listSessions() });
  });

  app.post('/api/session/:sessionId/resume', async (req, res) => {
    try {
      const creds = getCredentials();
      if (!creds) {
        return res.status(400).json({ error: 'Missing config' });
      }

      const { sessionId } = req.params;

      // If this session is already active, just return it
      if (activeSession?.id === sessionId) {
        return res.json({ sessionId });
      }

      // Kill any currently active session
      if (activeSession?.currentProc) {
        try { activeSession.currentProc.kill(); } catch { /* already dead */ }
      }

      // Look up the clineTaskId from the index
      const sessions = listSessions();
      const entry = sessions.find(s => s.sessionId === sessionId);
      const clineTaskId = entry?.clineTaskId || null;

      setSensitiveStrings([creds.apiKey]);
      try {
        configureClineAuth(creds);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }

      activeSession = {
        id: sessionId,
        clineTaskId,
        routerConversationId: null,
        status: 'idle',
        currentProc: null,
        startedAt: entry?.createdAt || Date.now(),
      };

      res.json({ sessionId });
    } catch (err) {
      console.error('[session] Resume failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to resume session: ' + err.message });
      }
    }
  });
}
