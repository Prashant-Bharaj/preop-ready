import { useState, useEffect, useRef, useCallback } from 'react';
import { editorUrlFor, classifyHealthProbe, OFFLINE_GRACE_MS, OFFLINE_PROBE_MS } from '../lib/workspace-status.js';
import { sendMessage, resetSession, cleanProject, connectStream, getEnvironment, getDockerStatus, cancelSession, confirmPlan, discardPlan, revisePlan, pauseSession, uploadFile, confirmOpenApp, closeAutoStartedApp, startApp, branchSession } from '../lib/api.js';
import MessageBubble from './MessageBubble.jsx';
import ExamplesModal from './ExamplesModal.jsx';
import DropZone from './DropZone.jsx';
import PhaseTasksChip from './PhaseTasksChip.jsx';
import ModuleReasonBadge from './ModuleReasonBadge.jsx';
import TracePanel from './TracePanel.jsx';
import { SendIcon, ChevronDownIcon, MenuIcon, StopIcon } from './Icon.jsx';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // mirrors server limit

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

// Live elapsed since a scope started, e.g. "12s" / "2m 05s". Recomputed on each
// render; the working-elapsed timer re-renders the component every second.
function formatElapsed(startedAt) {
  if (!startedAt) return '';
  const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

// Fixed duration (ms) → "12s" / "1m 03s". Used for a finished scope's elapsed.
function formatDurationMs(ms) {
  if (ms == null || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

// Internal orchestration plumbing that the user shouldn't see. These `[orchestrator]`
// text events (dispatching/auto-waiting on background phase agents, taskIds) describe
// how scopes are fanned out — implementation detail, not user-facing progress. They
// stay in the transcript for telemetry/debugging; we just don't render them. The scope
// cards themselves already show the actual work.
// Collapse a scope's cumulative streaming-text flushes. The server appends a new
// `say:text` event per ~150ms flush (each = prior text + more); on a parallel
// build these interleave across scopes in the transcript, so the restore-path
// merge (which only looks at the immediately-preceding event) misses them and
// the same message renders as several growing bubbles. Within one scope's events
// the flushes ARE consecutive, so collapsing consecutive cumulative text here
// (keep the longest) removes the duplicates.
function dedupeStreamingText(events) {
  const out = [];
  // Treat both `text` and `completion_result` as mergeable text so the streamed
  // report (say:text flushes) folds into its final completion_result — otherwise
  // the report renders twice (once streamed in the steps, once as the report).
  const txt = (e) =>
    (e?.type === 'cline' && (e?.payload?.say === 'text' || e?.payload?.say === 'completion_result')
      && typeof e?.payload?.text === 'string')
      ? e.payload.text : null;
  for (const ev of events) {
    const prev = out[out.length - 1];
    const evTxt = txt(ev);
    const prevTxt = txt(prev);
    if (evTxt != null && prevTxt != null && evTxt.startsWith(prevTxt)) {
      out[out.length - 1] = ev; // cumulative flush / finalized report — keep the later one
    } else {
      out.push(ev);
    }
  }
  return out;
}

function isInternalPlumbingEvent(event) {
  return event?.type === 'cline'
    && event?.payload?.say === 'text'
    && typeof event.payload?.text === 'string'
    && event.payload.text.trimStart().startsWith('[orchestrator]');
}

// Quick-access chips shown on the empty state (one per category)
const EXAMPLE_CHIPS = [
  { emoji: '🗳️', label: 'Voting app', text: 'I want to build a voting app where my team can vote on lunch options. Show a list of restaurants, let people vote, and display the results in real-time.' },
  { emoji: '📝', label: 'Feedback form', text: 'Create a feedback form with 5 questions about our team event. Questions should be rating (1-5) and one text comment. Show me a summary of all responses.' },
  { emoji: '🤖', label: 'AI chatbot', text: 'I want an AI chatbot that answers questions about our company policies. Simple chat interface, user types question, AI responds.' },
  { emoji: '📊', label: 'Status board', text: 'Build a dashboard that shows project status. Each project has a name, owner, and status (red/yellow/green). Let me add and update projects.' },
  { emoji: '🔄', label: 'Task tracker', text: 'Create a shared task list for my team. Add tasks, assign to people, mark as done. Filter by person or status.' },
];

/** Derive quick actions from current session state */
function getQuickActions(scopeStatuses, appRunning, dockerRunning, hasCode = false) {
  const scopes = Object.entries(scopeStatuses);
  const hasCompleted = scopes.some(([, info]) => info.status === 'completed');
  const failedScopes = scopes.filter(([, info]) => info.exitCode && info.exitCode !== 0).map(([s]) => s);

  // True if we think the app is up — either we saw `app_ready` live, or the backend
  // docker-status poll found the compose project's containers running.
  const isUp = appRunning || dockerRunning;

  const runOrStop = isUp
    ? { emoji: '⏹️', label: 'Stop application', action: 'stop' }
    : { emoji: '🧪', label: 'Start application', action: 'start' };

  if (failedScopes.length > 0) {
    return [
      { emoji: '🔧', label: `Fix ${failedScopes.join(' and ')}`, prompt: `The following scopes had errors: ${failedScopes.join(', ')}. Please check what went wrong, fix the issues, and verify the fixes work.` },
      runOrStop,
      { emoji: '🚀', label: 'Deploy application', prompt: 'Prepare my application for deployment and deploy it to production.' },
      { emoji: '🗑️', label: 'Clean and start over', action: 'clean' },
    ];
  }

  // Built project — either this session produced scopes or the workspace has
  // code from a prior session the user is resuming. Treat both the same: show
  // the full post-build action set including Start/Stop.
  if (hasCompleted || hasCode) {
    return [
      runOrStop,
      { emoji: '🚀', label: 'Deploy application', prompt: 'Prepare my application for deployment and deploy it to production.' },
      { emoji: '🗑️', label: 'Clean and start over', action: 'clean' },
    ];
  }

  // Nothing built yet — minimal actions. Still surface Stop if docker is
  // actually running (edge case — containers from a prior run left behind).
  const actions = [
    { emoji: '📊', label: 'Check project status', prompt: 'What is the current state of my project? What files exist and what has been built so far?' },
  ];
  if (isUp) actions.push(runOrStop);
  actions.push({ emoji: '🚀', label: 'Deploy application', prompt: 'Prepare my application for deployment and deploy it to production.' });
  return actions;
}


const SCOPE_LABELS = {
  database: 'Database',
  vectordb: 'Vector DB',
  backend: 'Backend',
  frontend: 'Frontend',
  integration: 'Integration',
  verification: 'Verification',
};

const SCOPE_LABELS_FRIENDLY = {
  database: 'Setting up data storage',
  vectordb: 'Preparing AI search',
  backend: 'Building server logic',
  frontend: 'Creating your interface',
  integration: 'Connecting everything',
  verification: 'Testing your app',
};

// Scopes that render in a second row (below the build scopes)
const PHASE1_SCOPES = new Set(['integration', 'verification']);

const ACTIVITY_LABELS_FRIENDLY = {
  'Reading files...': 'Reviewing the project...',
  'Writing code...': 'Writing your app...',
  'Running command...': 'Setting things up...',
  'Responding...': 'Preparing response...',
  'Thinking...': 'Thinking...',
  'Working...': 'Working on it...',
};

export default function ChatScreen({ sessionId, mode, onReset, onOpenDrawer, showTokenBar = true, pastSessions = [], onResumeSession = null }) {
  const isBeginner = mode === 'beginner';
  const [events, setEvents] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Welcome-back screen: "New conversation" swaps the action buttons for the
  // composer — fresh chat context over the EXISTING app code (vs resuming the
  // old session with full history, vs wiping the workspace).
  const [welcomeComposerOpen, setWelcomeComposerOpen] = useState(false);
  // Ephemeral per-scope streaming heartbeats ("generating… Nk chars") — fed
  // by non-persisted scope_heartbeat events so long silent generations read
  // as alive instead of stuck. Not restored on reload (live-only signal).
  const [scopeHeartbeats, setScopeHeartbeats] = useState({});
  const [sendError, setSendError] = useState(null);
  const [meta, setMeta] = useState({ branch: '—', commitSha: '—' });
  const [status, setStatus] = useState('working');
  const [activity, setActivity] = useState('Initializing...');
  const [workingElapsedSec, setWorkingElapsedSec] = useState(0);
  const [wsStatus, setWsStatus] = useState('connected');
  // 'gone' once a disconnect outlasts the grace period AND the API no longer
  // answers JSON — the codespace idled out (or the server died). Cleared by a
  // full reload when it answers again.
  const [workspaceGone, setWorkspaceGone] = useState(false);
  // Set when a portal launched this workspace (server env VIBE_PORTAL_URL):
  // the sleep card sends the user back there instead of to the editor.
  const [portalUrl, setPortalUrl] = useState(null);
  useEffect(() => {
    fetch('/api/auth/status').then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.portalUrl) return;
        try {
          const u = new URL(d.portalUrl);
          if (d.projectName) u.searchParams.set('project', d.projectName);
          setPortalUrl(u.toString());
        } catch {
          setPortalUrl(d.portalUrl);
        }
      })
      .catch(() => { /* offline or old server — editor link fallback */ });
  }, []);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showScrollTopBtn, setShowScrollTopBtn] = useState(false);
  // Full-process modal: { label, events } for one subagent, or null.
  // Subagent detail view: { label, scope, reportEvent, processEvents, mode } —
  // mode 'modal' (pop-out) or 'drawer' (side panel), or null when closed.
  const [scopeView, setScopeView] = useState(null);
  const [scopeStatuses, setScopeStatuses] = useState({});
  // Part B Phase 2 — orchestrator-dispatched phase agents tracked per taskId.
  // Populated from cline events with say='phase_status' (see PhaseTasksChip).
  // Map keyed by taskId; values: { taskId, scope, description?, state,
  // mode?, startedAt, error?, writtenPaths?, tokens? }.
  const [phaseTasks, setPhaseTasks] = useState(() => new Map());
  const [appRunning, setAppRunning] = useState(false);
  const [dockerRunning, setDockerRunning] = useState(false);
  const [envInfo, setEnvInfo] = useState(null);
  const [pendingPlan, setPendingPlan] = useState(null); // { message, tasks, summary, aiActions, techDetails }
  // Count of currently-open (unsubmitted) clarify cards. When > 0 we hide the
  // bottom composer so users answer inline on the card instead of having two
  // input paths competing for attention.
  const [clarifyActiveCount, setClarifyActiveCount] = useState(0);
  const handleClarifyActive = useCallback((active) => {
    setClarifyActiveCount((c) => (active ? c + 1 : Math.max(0, c - 1)));
  }, []);
  // Auto-start prompt: shown after the last phase when the app booted successfully.
  const [pendingAppOpen, setPendingAppOpen] = useState(null); // { url, message }
  const [appActionInFlight, setAppActionInFlight] = useState(null); // 'open' | 'close' | null
  // Per-session token usage — server emits one event after each Cline task
  // with running totals. We display them in the bottom bar next to opt-score.
  const [tokenTotals, setTokenTotals] = useState(null); // { promptTokens, completionTokens, cachedTokens, apiCalls } | null
  // Plan "request changes" input
  const [planChangeInput, setPlanChangeInput] = useState('');
  const [planRevising, setPlanRevising] = useState(false);
  const [showPlanChanges, setShowPlanChanges] = useState(false);
  // Pause / Resume
  const [paused, setPaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  // "New chat" confirmation dialog
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // "Branch from here" confirmation — holds `{ fromEventTs }` while open, else null.
  const [branchConfirm, setBranchConfirm] = useState(null);
  // Hybrid module trace panel
  const [traceOpen, setTraceOpen] = useState(false);
  const [branching, setBranching] = useState(false);
  // Toast: { id, message, type }
  const [toasts, setToasts] = useState([]);
  // Drag-and-drop attachments
  const [attachedFiles, setAttachedFiles] = useState([]); // [{ id, filename, mime, size, parsed, relativePath, uploading?, error? }]
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0); // tracks nested dragenter/leave so the overlay doesn't flicker
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const textareaRef = useRef(null);
  const streamRef = useRef(null);
  const lastFailedMsg = useRef(null);
  const toastIdRef = useRef(0);
  const tempIdRef = useRef(0);

  /** Show a toast notification. type: 'success' | 'info' | 'error' */
  function showToast(message, type = 'success', duration = 3000) {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }

  // Fetch environment/preflight info on mount
  useEffect(() => {
    getEnvironment().then(setEnvInfo).catch(() => {});
  }, []);

  // Poll docker compose status so the Stop/Start quick action stays accurate
  // across page reloads and between messages. Exposed as a callback so event
  // handlers (task completion, explicit "docker compose down" in a command)
  // can trigger an immediate refresh instead of waiting for the next tick.
  const refreshDockerStatus = useCallback(async () => {
    try {
      const { running } = await getDockerStatus();
      setDockerRunning(running);
      // Sync `appRunning` with docker truth. It gets set to true from history
      // replay (any prior `app_ready` event) but never self-clears when the
      // app later gets stopped — leaving the Stop/Start button stuck on
      // "Stop application" even though there's nothing to stop.
      if (!running) {
        setAppRunning(false);
        // The "your app is running — open it?" banner must not outlive the
        // running app. Clear it whenever docker truth says nothing is up
        // (covers the app being stopped, crashing, or brought down externally).
        setPendingAppOpen(null);
      }
    } catch { /* ignore — keep last known value */ }
  }, []);

  useEffect(() => {
    refreshDockerStatus();
    const id = setInterval(refreshDockerStatus, 10_000);
    return () => clearInterval(id);
  }, [refreshDockerStatus]);

  /**
   * Walk backward from the end of arr and return the index of the last event
   * matching `predicate` — but BAIL OUT when we cross a user-message boundary.
   * Without the boundary check, a follow-up assistant message whose opening
   * phrase happens to match the previous turn's message (common — "I'll …" /
   * "I'll …") would coalesce into the earlier bubble, leaving the new turn
   * visually empty. Each turn owns its own streaming window.
   */
  function findInCurrentTurn(arr, predicate) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (e?.type === 'user' && e?.payload?.source !== 'system') return -1;
      if (predicate(e)) return i;
    }
    return -1;
  }

  function findLastTextIndex(arr, scope) {
    return findInCurrentTurn(arr, e =>
      e?.type === 'cline' && e?.payload?.say === 'text' && e?.payload?.scope === scope
    );
  }

  /** Check if new text is a streaming continuation of old text */
  function isStreamingUpdate(oldText, newText) {
    return newText.startsWith(oldText);
  }

  function processHistoryBatch(rawEvents) {
    const result = [];
    for (const event of rawEvents) {
      if (event.type === 'meta' || event.type === 'status' || event.type === 'phase_status' || event.type === 'router_status' || event.type === 'scope_status') continue;
      if (event.type === 'cline') {
        const say = event.payload?.say;
        const ask = event.payload?.ask;
        const scope = event.payload?.scope;
        if (say === 'api_req_started') continue;
        if (say === 'text') {
          const last = result[result.length - 1];
          if (last?.type === 'cline' && last?.payload?.say === 'text' && last?.payload?.scope === scope) {
            const oldText = last.payload?.text || '';
            const newText = event.payload?.text || '';
            if (isStreamingUpdate(oldText, newText)) {
              result[result.length - 1] = event;
              continue;
            }
          }
        }
        if (ask === 'command_output') {
          // Same merge as the live handler — concat successive chunks so the
          // UI sees one bubble per command rather than one per line of output.
          const last = result[result.length - 1];
          if (last?.type === 'cline' && last?.payload?.ask === 'command_output' && last?.payload?.scope === scope) {
            result[result.length - 1] = {
              ...last,
              payload: {
                ...last.payload,
                text: (last.payload?.text || '') + (event.payload?.text || ''),
              },
            };
            continue;
          }
        }
        if (say === 'task_progress') {
          const idx = findInCurrentTurn(result, e =>
            e?.type === 'cline' && e?.payload?.say === 'task_progress' && e?.payload?.scope === scope
          );
          if (idx !== -1) { result[idx] = event; continue; }
        }
        if (say === 'completion_result') {
          const idx = findLastTextIndex(result, scope);
          if (idx !== -1) { result[idx] = event; continue; }
        }
      }
      result.push(event);
    }
    return result;
  }

  useEffect(() => {
    if (!sessionId) return;

    const stream = connectStream(sessionId, (event) => {
      if (event.type === 'history_batch') {
        const restored = processHistoryBatch(event.events || []);
        setEvents(restored);
        const rawEvents = event.events || [];
        // Deliberately do NOT re-hydrate `appRunning` from history. An
        // `app_ready` event in the transcript only tells us the app was up at
        // that moment — it may have been stopped since. The docker-status
        // poll (runs immediately on mount + every 10s + on every completion)
        // is the single source of truth for "is the app running right now".
        // Racing a history-based `setAppRunning(true)` against the poll
        // caused the Stop/Start button to stay stuck on "Stop application"
        // on resume after the containers had been brought down.

        // Rehydrate `scopeStatuses` from history so the quick-actions bar
        // appears on resume. The bar's visibility gate requires at least one
        // completed scope OR a running container — without this rehydration
        // both sides are false after resume and the bar stays hidden even
        // when the user clearly has a built project to act on.
        const statusesFromHistory = {};
        for (const ev of rawEvents) {
          if (ev.type === 'scope_status' && ev.payload?.scope) {
            statusesFromHistory[ev.payload.scope] = {
              status: ev.payload.status,
              exitCode: ev.payload.exitCode,
              ts: ev.ts || null,
            };
          }
        }
        if (Object.keys(statusesFromHistory).length > 0) {
          setScopeStatuses(statusesFromHistory);
        }

        // Restore token totals on reload — take the LARGEST cumulative seen,
        // not the most recent: per-call metrics from planner turns are smaller
        // than the session aggregate and previously reset the chip.
        let bestTotals = null;
        const totalOf = (t) => (t?.promptTokens || 0) + (t?.completionTokens || 0);
        for (const ev of rawEvents) {
          const t = ev.type === 'token_metrics' ? ev.payload?.totals : null;
          if (t && (!bestTotals || totalOf(t) > totalOf(bestTotals))) bestTotals = t;
        }
        if (bestTotals) setTokenTotals(bestTotals);

        // Restore the plan-confirmation card on reload: the server says
        // whether the last plan_preview is still awaiting confirm/discard
        // (event.pendingPlan is that payload, or null). Without this a
        // reload dropped the card while the server kept waiting.
        if (event.pendingPlan) {
          setPendingPlan({
            message: event.pendingPlan.message || '',
            tasks: event.pendingPlan.tasks || [],
            modulePlan: event.pendingPlan.modulePlan || null,
            reasonCodes: event.pendingPlan.reasonCodes || [],
            confidence: event.pendingPlan.confidence ?? null,
          });
        } else {
          setPendingPlan(null);
        }

        // Restore the "open app" prompt on reload if it was still outstanding:
        // show it again when the last app_ready_prompt has NOT been followed
        // by an app_ready (user clicked Open) or any status 'reset' event.
        for (let i = rawEvents.length - 1; i >= 0; i--) {
          const ev = rawEvents[i];
          if (ev.type === 'app_ready' || (ev.type === 'status' && ev.payload?.status === 'reset')) break;
          if (ev.type === 'app_ready_prompt' && ev.payload?.url) {
            setPendingAppOpen({ url: ev.payload.url, message: ev.payload.message || 'Your app is running. Want to open it?' });
            break;
          }
        }

        const lastStatus = [...rawEvents].reverse().find(e => e.type === 'status');
        if (lastStatus) {
          const s = lastStatus.payload.status;
          setStatus(s);
          if (s === 'idle') setActivity('');
          else if (s === 'working') setActivity('Thinking...');
        }
        return;
      }

      if (event.type === 'meta') {
        setMeta(event.payload);
      } else if (event.type === 'status') {
        const s = event.payload.status;
        setStatus(s);
        if (s === 'idle') {
          setActivity('');
          setSendError(null); // Clear stale errors when ready
        } else if (s === 'working') {
          setActivity((prev) => prev || 'Thinking...');
        }
      } else if (event.type === 'cline') {
        const say = event.payload?.say;
        if (say === 'api_req_started') return;

        // Part B Phase 2: orchestrator-dispatched phase agent state events.
        // Payload.text is JSON with at least { taskId, scope, state }; we
        // upsert into phaseTasks so the chip can render.
        if (say === 'phase_status') {
          try {
            const info = JSON.parse(event.payload.text);
            if (info.taskId) {
              setPhaseTasks((prev) => {
                const next = new Map(prev);
                const existing = next.get(info.taskId) || {};
                next.set(info.taskId, { ...existing, ...info });
                return next;
              });
            }
          } catch { /* malformed phase_status — drop */ }
          return;
        }

        if (say === 'tool') {
          try {
            const info = JSON.parse(event.payload.text);
            if (['read_file', 'list_files', 'search_files', 'list_code_definition_names'].includes(info.tool)) {
              setActivity('Reading files...');
            } else if (info.tool === 'write_to_file' || info.tool === 'replace_in_file') {
              setActivity('Writing code...');
            } else {
              setActivity('Working...');
            }
          } catch { setActivity('Working...'); }
        } else if (say === 'command') {
          setActivity('Running command...');
          // Optimistic state update when Cline runs "docker compose down" so
          // the Stop/Start button swaps immediately instead of waiting up to
          // 10s for the next docker-status poll. The poll confirms shortly
          // after and corrects if anything went wrong.
          const cmdText = event.payload?.text || '';
          if (/docker(?:\s+|-)compose\s+down/i.test(cmdText)) {
            setDockerRunning(false);
            setAppRunning(false);
          }
        } else if (say === 'text') {
          setActivity('Responding...');
        } else if (say === 'completion_result') {
          setActivity('');
        }

        if (say === 'text') {
          const eventScope = event.payload?.scope;
          const newText = event.payload?.text || '';
          setEvents((prev) => {
            // Walk backward within the current turn only — if we cross a user
            // message boundary we're in the previous turn and must NOT merge.
            for (let i = prev.length - 1; i >= 0; i--) {
              const p = prev[i];
              if (p?.type === 'user' && p?.payload?.source !== 'system') break;
              if (p?.type === 'cline' && p?.payload?.say === 'text' && p?.payload?.scope === eventScope) {
                const oldText = p.payload?.text || '';
                // Streaming update: new text is a continuation → replace
                if (isStreamingUpdate(oldText, newText)) {
                  const next = [...prev];
                  next[i] = event;
                  return next;
                }
                break; // Different content → new message, append
              }
            }
            return [...prev, event];
          });
          return;
        }

        // Merge consecutive command outputs into one bubble. Cline streams a
        // running command's stdout as many separate `ask: command_output`
        // events (sometimes one per line of docker-compose output). Rendering
        // each as its own bubble fragments a single command's output across
        // the screen. We append the new chunk's text to the previous
        // command_output bubble when there's nothing non-command-output
        // between them.
        if (event.payload?.ask === 'command_output') {
          const eventScope = event.payload?.scope;
          const newChunk = event.payload?.text || '';
          setEvents((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const p = prev[i];
              if (p?.type === 'user' && p?.payload?.source !== 'system') break;
              if (p?.type !== 'cline') continue;
              // Anything that isn't another command_output (same scope) breaks
              // the run — the next command_output starts a fresh bubble.
              if (p?.payload?.ask !== 'command_output' || p?.payload?.scope !== eventScope) break;
              const next = [...prev];
              const merged = {
                ...p,
                payload: {
                  ...p.payload,
                  text: (p.payload?.text || '') + newChunk,
                },
              };
              next[i] = merged;
              return next;
            }
            return [...prev, event];
          });
          return;
        }

        // Collapse progress checklists — replace previous progress with same
        // scope, but only within the current turn (see note above).
        if (say === 'task_progress') {
          const eventScope = event.payload?.scope;
          setEvents((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const p = prev[i];
              if (p?.type === 'user' && p?.payload?.source !== 'system') break;
              if (p?.type === 'cline' && p?.payload?.say === 'task_progress' && p?.payload?.scope === eventScope) {
                const next = [...prev];
                next[i] = event;
                return next;
              }
            }
            return [...prev, event];
          });
          return;
        }

        if (say === 'completion_result') {
          const eventScope = event.payload?.scope;
          setEvents((prev) => {
            const idx = findLastTextIndex(prev, eventScope);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = event;
              return next;
            }
            return [...prev, event];
          });
          return;
        }

        setEvents((prev) => [...prev, event]);
      } else if (event.type === 'concierge_text') {
        // Concierge reply during a build (status='working'). Render as a
        // top-of-thread assistant bubble, identical visual treatment to a
        // cline say:'text' message but without the streaming merge — each
        // concierge turn is its own discrete bubble.
        setEvents((prev) => [...prev, event]);
      } else if (event.type === 'completion' || event.type === 'app_ready') {
        if (event.type === 'app_ready') setAppRunning(true);
        // Refresh docker status after every completion — covers "Stop
        // application" and any other quick action whose side-effect changes
        // container state, so the button label matches reality without
        // waiting for the next 10s poll.
        if (event.type === 'completion') refreshDockerStatus();
        // Completion summary / app ready — always append as a new message, never replace
        setEvents((prev) => [...prev, event]);
      } else if (event.type === 'scope_status') {
        const { scope, status: scopeStatus, exitCode } = event.payload;
        setScopeStatuses(prev => {
          const existing = prev[scope] || {};
          const next = { ...existing, status: scopeStatus, exitCode, ts: event.ts || Date.now() };
          // Stamp when a scope starts running so the card can show a live
          // elapsed heartbeat — a long tool-heavy turn (e.g. frontend writing
          // 40+ files in one LLM turn) otherwise looks frozen.
          if (scopeStatus === 'running' && (!existing.startedAt || existing.status !== 'running')) next.startedAt = Date.now();
          return { ...prev, [scope]: next };
        });
      } else if (event.type === 'phase_status') {
        // Track phase progress for beginner build indicator (not added to display events)
      } else if (event.type === 'router_status') {
        // Coordination signal only
      } else if (event.type === 'plan_preview') {
        // Server is holding a plan for user confirmation
        setPendingPlan({
          message: event.payload?.message || '',
          tasks: event.payload?.tasks || [],
          modulePlan: event.payload?.modulePlan || null,
          reasonCodes: event.payload?.reasonCodes || [],
          confidence: event.payload?.confidence ?? null,
        });
      } else if (event.type === 'app_ready_prompt') {
        // Server auto-started the app and is asking if the user wants to open it.
        setPendingAppOpen({ url: event.payload?.url, message: event.payload?.message || 'Your app is running. Want to open it?' });
      } else if (event.type === 'token_metrics') {
        // Running totals for this session. Monotonic guard: a smaller
        // per-call metric must never shrink the session chip.
        if (event.payload?.totals) {
          const nt = event.payload.totals;
          setTokenTotals((prev) => {
            const totalOf = (t) => (t?.promptTokens || 0) + (t?.completionTokens || 0);
            return totalOf(nt) >= totalOf(prev) ? nt : prev;
          });
        }
      } else if (event.type === 'scope_heartbeat') {
        const hb = event.payload || {};
        if (hb.scope) {
          setScopeHeartbeats((prev) => ({ ...prev, [hb.scope]: { chars: hb.chars || 0, ts: event.ts || Date.now() } }));
        }
      } else if (event.type === 'compact_metrics') {
        // Measurement-only event from the custom agent; not rendered.
      } else {
        setEvents((prev) => [...prev, event]);
      }
    }, (connStatus) => {
      setWsStatus(connStatus);
    });

    streamRef.current = stream;
    return () => stream.close();
  }, [sessionId]);

  // Workspace-gone detection. Socket.IO retries on its own, but a codespace
  // that idled out never comes back by itself: the user has to start it (and
  // the harness) again. Tell them, instead of showing "Reconnecting..." forever.
  useEffect(() => {
    if (wsStatus === 'connected') { setWorkspaceGone(false); return undefined; }
    let cancelled = false;
    let timer = null;
    const probe = async () => {
      if (cancelled) return;
      let result = 'gone';
      try {
        const res = await fetch('/api/auth/status', { cache: 'no-store' });
        result = classifyHealthProbe({ ok: res.ok, contentType: res.headers.get('content-type') || '' });
      } catch { result = 'gone'; }
      if (cancelled) return;
      if (result === 'online') {
        // Back (the harness restarted). A reload rehydrates everything —
        // history, pending plan, app state — from the server.
        if (workspaceGone) { window.location.reload(); return; }
      } else {
        setWorkspaceGone(true);
      }
      timer = setTimeout(probe, OFFLINE_PROBE_MS);
    };
    timer = setTimeout(probe, workspaceGone ? OFFLINE_PROBE_MS : OFFLINE_GRACE_MS);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [wsStatus, workspaceGone]);

  // "Follow mode": the outer container only auto-scrolls when the user is
  // already near the bottom. If they've scrolled up to read something, we
  // leave them alone and surface the scroll-to-bottom button instead.
  // Use instant scroll during streams — smooth animations compound with the
  // inner scope boxes and turn the page into a slot machine.
  const followBottomRef = useRef(true);
  useEffect(() => {
    if (!followBottomRef.current) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  // Each scope box scrolls to its own bottom on every event. Imperative
  // scrollTop with the CSS scroll-behavior: smooth rule was compounding the
  // outer smooth scroll — we now handle scrolling here and removed the CSS.
  useEffect(() => {
    document.querySelectorAll('.scope-events').forEach(el => {
      el.scrollTop = el.scrollHeight;
    });
  }, [events]);

  // Scroll position detection for scroll-to-bottom button AND follow mode.
  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distFromBottom <= 120;
    followBottomRef.current = nearBottom;
    setShowScrollBtn(!nearBottom && distFromBottom > 200);
    // Show "jump to start" once the user has scrolled down a screenful — lets
    // them get back to the beginning of a long conversation after continuations.
    setShowScrollTopBtn(el.scrollTop > 400);
  }, []);

  function scrollToBottom() {
    followBottomRef.current = true;
    const el = messagesContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  function scrollToTop() {
    // Stop auto-following the stream so new events don't yank the user back
    // down while they read from the beginning.
    followBottomRef.current = false;
    const el = messagesContainerRef.current;
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Auto-resize textarea
  function handleInputChange(e) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /**
   * Clipboard paste handler — detects image blobs (screenshots from macOS
   * Cmd+Shift+4, Windows Snipping Tool, etc.) in ClipboardEvent.items and
   * routes them through the same upload pipeline as drag-and-drop. Plain
   * text paste is untouched so pasting code/URLs still works normally.
   */
  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const blob = item.getAsFile();
        if (blob) {
          // Clipboard images arrive with a generic name like "image.png".
          // Give them a timestamped filename so pasted shots don't collide.
          const name = blob.name && blob.name !== 'image.png'
            ? blob.name
            : `pasted-${Date.now()}.${(blob.type || 'image/png').split('/')[1] || 'png'}`;
          files.push(new File([blob], name, { type: blob.type }));
        }
      }
    }
    if (files.length > 0) {
      e.preventDefault(); // suppress the "[object File]" text paste some browsers emit
      handleFiles(files);
    }
  }

  async function handleSend(e) {
    if (e) e.preventDefault();
    const msg = input.trim();
    if (!msg || !sessionId) return;

    if (isWorking) return; // Banner above input already shows the working message

    // Only the uploads that finished successfully ship with the message.
    const readyUploads = attachedFiles
      .filter(f => !f.uploading && !f.error)
      .map(({ filename, relativePath, mime, size, parsed }) => ({ filename, relativePath, mime, size, parsed }));

    setInput('');
    setSending(true);
    setSendError(null);
    lastFailedMsg.current = msg;

    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      await sendMessage(sessionId, msg, readyUploads.length > 0 ? readyUploads : null);
      // Clear pills on successful send — the files themselves persist in context/.
      setAttachedFiles([]);
    } catch (err) {
      console.error('Send failed:', err);
      setSendError('Message failed to send.');
    } finally {
      setSending(false);
    }
  }

  /**
   * Upload a File to the backend and track its pill through pending → ready / error.
   */
  async function uploadOne(file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast(`"${file.name}" is larger than 10 MB — skipped.`, 'error', 5000);
      return;
    }
    const tempId = `tmp-${++tempIdRef.current}`;
    setAttachedFiles(prev => [
      ...prev,
      { id: tempId, filename: file.name, mime: file.type || 'application/octet-stream', size: file.size, uploading: true },
    ]);
    try {
      const result = await uploadFile(file);
      setAttachedFiles(prev => prev.map(f => f.id === tempId ? {
        id: result.relativePath,
        filename: result.filename,
        relativePath: result.relativePath,
        mime: result.mime,
        size: result.size,
        parsed: result.parsed || null,
        uploading: false,
      } : f));
    } catch (err) {
      const msg = err?.message || 'Upload failed';
      setAttachedFiles(prev => prev.filter(f => f.id !== tempId));
      showToast(`Upload failed — ${msg}`, 'error', 5000);
    }
  }

  async function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    // Fire uploads in parallel — each pill updates independently.
    await Promise.all(files.map(uploadOne));
  }

  function removeAttached(id) {
    setAttachedFiles(prev => prev.filter(f => f.id !== id));
  }

  // ── Drag-and-drop handlers ─────────────────────────────────────────
  // Wire to the outer .chat-screen so drops anywhere in the chat UI attach.
  // dragCounter handles nested child enter/leave so the overlay doesn't flash.
  function handleDragEnter(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounter.current++;
    setIsDragging(true);
  }
  function handleDragOver(e) {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  }
  function handleDragLeave(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDragging(false);
  }
  function handleDrop(e) {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  async function handleRetry() {
    if (!lastFailedMsg.current || !sessionId) return;
    setSending(true);
    setSendError(null);
    try {
      await sendMessage(sessionId, lastFailedMsg.current);
    } catch (err) {
      console.error('Retry failed:', err);
      setSendError('Still unable to send. Check your connection.');
    } finally {
      setSending(false);
    }
  }

  // Memoized so it's a stable prop for React.memo'd MessageBubble — otherwise a
  // new function each render would defeat the memo and every keystroke would
  // re-render the whole conversation (post-build typing lag).
  const handleQuickAction = useCallback(async (prompt, displayLabel = null) => {
    if (status === 'working' || sending || !sessionId) return;
    setSending(true);
    setSendError(null);
    lastFailedMsg.current = prompt;
    try {
      await sendMessage(sessionId, prompt, null, displayLabel);
    } catch (err) {
      console.error('Quick action failed:', err);
      setSendError('Action failed to send.');
    } finally {
      setSending(false);
    }
  }, [status, sending, sessionId]);

  // Branch handlers. useCallback so MessageBubble's onBranch prop stays
  // ref-stable across re-renders (MessageBubble is React.memo'd).
  const handleBranchRequest = useCallback((fromEventTs) => {
    if (typeof fromEventTs !== 'number') return;
    setBranchConfirm({ fromEventTs });
  }, []);

  const handleBranchCancel = useCallback(() => {
    if (branching) return; // don't let cancel fire mid-request
    setBranchConfirm(null);
  }, [branching]);

  const handleBranchConfirm = useCallback(async () => {
    if (!branchConfirm || !sessionId || branching) return;
    const { fromEventTs } = branchConfirm;
    setBranching(true);
    try {
      const result = await branchSession(sessionId, fromEventTs);
      setBranchConfirm(null);
      if (result?.newSessionId && onResumeSession) {
        await onResumeSession(result.newSessionId);
      }
    } catch (err) {
      console.error('Branch failed:', err);
      showToast('Could not branch this conversation: ' + err.message, 'error', 5000);
    } finally {
      setBranching(false);
    }
  }, [branchConfirm, sessionId, branching, onResumeSession]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleStop() {
    if (!sessionId || stopping) return;
    setStopping(true);
    try {
      await cancelSession(sessionId);
    } catch (err) {
      console.error('Stop failed:', err);
    } finally {
      setStopping(false);
    }
  }

  async function handleConfirmPlan() {
    if (!sessionId || !pendingPlan) return;
    setPendingPlan(null);
    try {
      await confirmPlan(sessionId);
    } catch (err) {
      console.error('Confirm plan failed:', err);
    }
  }

  async function handleDiscardPlan() {
    if (!sessionId || !pendingPlan) return;
    setPendingPlan(null);
    try {
      await discardPlan(sessionId);
    } catch (err) {
      console.error('Discard plan failed:', err);
    }
  }

  async function handleOpenApp() {
    if (!sessionId || !pendingAppOpen) return;
    const url = pendingAppOpen.url;
    // Open the tab first (needs to happen inside the click handler so popup
    // blockers treat it as a user gesture) and then confirm with the server.
    window.open(url, '_blank', 'noopener,noreferrer');
    setAppActionInFlight('open');
    setPendingAppOpen(null);
    try {
      await confirmOpenApp(sessionId);
    } catch (err) {
      console.error('Open app failed:', err);
      showToast('Opened, but couldn\'t confirm with server', 'info', 3000);
    } finally {
      setAppActionInFlight(null);
    }
  }

  async function handleCloseApp() {
    if (!sessionId || !pendingAppOpen) return;
    setAppActionInFlight('close');
    setPendingAppOpen(null);
    try {
      await closeAutoStartedApp(sessionId);
      setAppRunning(false);
      setDockerRunning(false);
    } catch (err) {
      console.error('Close app failed:', err);
      showToast(`Couldn't stop the app: ${err.message}`, 'error', 4500);
    } finally {
      setAppActionInFlight(null);
    }
  }

  // Deterministic "Stop application" quick action — hits the close-app endpoint
  // (docker compose down) directly. NOT an LLM prompt: the assistant can't run
  // shell, and stopping containers is a pure infra action.
  async function handleStartApp() {
    if (!sessionId || appActionInFlight) return;
    setAppActionInFlight('start');
    try {
      await startApp(sessionId);
      // Progress (compose, migrations, probe, app-ready) arrives through the
      // normal event stream; the docker-status poll flips the button state.
      showToast('Starting your app — progress will appear in the chat.', 'success', 3500);
    } catch (err) {
      console.error('Start app failed:', err);
      showToast(`Couldn't start the app: ${err.message}`, 'error', 4500);
    } finally {
      setAppActionInFlight(null);
    }
  }

  async function handleStopApp() {
    if (!sessionId || appActionInFlight) return;
    setAppActionInFlight('close');
    try {
      await closeAutoStartedApp(sessionId);
      setAppRunning(false);
      setDockerRunning(false);
      setPendingAppOpen(null); // clear the stale "app is running" banner immediately
      showToast('Application stopped (containers down).', 'success', 3000);
    } catch (err) {
      console.error('Stop app failed:', err);
      showToast(`Couldn't stop the app: ${err.message}`, 'error', 4500);
    } finally {
      setAppActionInFlight(null);
    }
  }

  /** Called when the user clicks "New chat" — show confirm dialog if there are messages */
  function requestReset() {
    if (!hasUserMessages) {
      // Nothing to lose — reset immediately without asking
      doReset();
    } else {
      setShowResetConfirm(true);
    }
  }

  /** Actually perform the reset after confirmation */
  async function doReset() {
    setShowResetConfirm(false);
    if (!sessionId) return;
    // Show "session saved" toast before navigating away
    showToast('✅ Session saved — you can find it in the chat history.', 'success', 3500);
    try { await resetSession(sessionId); } catch { /* ignore */ }
    // Reset all local state — opt-score resets automatically because events[] becomes []
    setEvents([]);
    setScopeStatuses({});
    setAppRunning(false);
    setAttachedFiles([]);
    setPendingAppOpen(null);
    setTokenTotals(null);
    onReset();
  }

  async function handleCleanProject() {
    if (!sessionId) return;
    if (!window.confirm('This will delete all generated project files, uploaded context, and start fresh. Continue?')) return;
    try {
      await cleanProject(sessionId);
      setEvents([]);
      setScopeStatuses({});
      setAppRunning(false);
      setEnvInfo(null);
      setAttachedFiles([]);
      setPendingAppOpen(null);
      setTokenTotals(null);
      // Refresh env info so preflight card updates
      getEnvironment().then(setEnvInfo).catch(() => {});
      onReset();
    } catch (err) {
      console.error('Clean failed:', err);
    }
  }

  const isWorking = status === 'working';

  // While isWorking, rotate through warmer wait phrases as time passes so the
  // user knows the MGA router is actually doing something (main wait is ~20-30s).
  // State holds the current phrase; we swap it on a timer at specific thresholds.
  useEffect(() => {
    if (!isWorking) {
      setWorkingElapsedSec(0);
      return;
    }
    // The phrase only changes at these thresholds, so fire a timer at each
    // boundary instead of ticking every second — ~5 re-renders per wait window
    // rather than ~40. workingElapsedSec is bumped to the boundary value it
    // crossed, which the phrase map below reads.
    setWorkingElapsedSec(0);
    const timers = [4, 10, 18, 28, 45].map((sec) =>
      setTimeout(() => setWorkingElapsedSec(sec), sec * 1000)
    );
    return () => timers.forEach(clearTimeout);
  }, [isWorking]);

  // Map elapsed seconds → phrase. Null means "don't show any suffix yet".
  const waitPhrase = (() => {
    if (!isWorking) return null;
    if (workingElapsedSec < 4)  return null;
    if (workingElapsedSec < 10) return 'give me a moment';
    if (workingElapsedSec < 18) return 'organising the details';
    if (workingElapsedSec < 28) return 'almost there';
    if (workingElapsedSec < 45) return 'this one\u2019s a bigger ask';
    return 'still working on it';
  })();

  const friendlyActivity = isBeginner ? (ACTIVITY_LABELS_FRIENDLY[activity] || activity) : activity;
  const statusLabel = isWorking
    ? (isBeginner ? (friendlyActivity || 'Building...') : (activity || 'Working'))
    : status === 'error' ? 'Error' : 'Ready';
  const statusColor = { working: '#f59e0b', idle: '#10b981', error: '#ef4444' };

  // Build progress: derive active scopes for progress bar
  const activeScopeList = Object.entries(scopeStatuses);
  const showBuildProgress = isBeginner && activeScopeList.length > 1;
  const scopeLabels = isBeginner ? SCOPE_LABELS_FRIENDLY : SCOPE_LABELS;

  // Separate bootstrap events from real user conversation.
  // The server runs a bootstrap prompt on session start, producing events before
  // the user sends anything. Show the welcome state until the first real user message.
  const firstUserIdx = events.findIndex(e => e.type === 'user' && e.payload?.source !== 'system');
  const hasUserMessages = firstUserIdx !== -1;
  const displayEvents = hasUserMessages
    ? events.slice(firstUserIdx).filter(e => !isInternalPlumbingEvent(e))
    : [];

  const isEmptyState = displayEvents.length === 0 && !isWorking;

  const composerJsx = (
    <form className="chat-input-bar" onSubmit={handleSend}>
      {attachedFiles.length > 0 && (
        <div className="attached-files-bar">
          {attachedFiles.map(f => {
            const label = f.uploading ? 'Uploading' : ((f.mime || '').startsWith('image/') ? 'Image' : 'File');
            return (
              <span
                key={f.id}
                className={`attached-file-pill${f.uploading ? ' uploading' : ''}`}
                title={f.relativePath || f.filename}
              >
                <span className="attached-file-kind">{label}</span>
                <span className="attached-file-name">{f.filename}</span>
                <span className="attached-file-size">{formatBytes(f.size)}</span>
                <button
                  type="button"
                  className="attached-file-remove"
                  aria-label={`Remove ${f.filename}`}
                  onClick={() => removeAttached(f.id)}
                  disabled={f.uploading}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="chat-input-wrapper">
        <textarea
          ref={textareaRef}
          placeholder={isWorking ? 'Type your next message here...' : 'Describe your idea — drop or paste files (images, PDFs, docs) to attach them'}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={sending}
          rows={3}
          aria-label="Message input"
        />
        {isWorking ? (
          <button
            type="button"
            className="send-btn send-btn-stop"
            onClick={handleStop}
            disabled={stopping}
            aria-label="Stop current task"
            title="Stop current task"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="submit"
            className="send-btn"
            disabled={sending || !input.trim()}
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </form>
  );

  return (
    <div
      className={`chat-screen${isEmptyState ? ' empty-mode' : ''}${isDragging ? ' is-dragging' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DropZone visible={isDragging} />
      <header className="chat-header">
        <div className="header-left">
          <button className="btn-menu" onClick={onOpenDrawer} aria-label="Open menu">
            <MenuIcon />
          </button>
          <h2>Chat</h2>
          <span className="status-badge" style={{ backgroundColor: statusColor[status] || '#6b7280' }}>
            {isWorking && <span className="status-dot" />}
            {statusLabel}
          </span>
        </div>
        <nav className="header-nav" aria-label="Community links">
          <a
            className="header-nav-link"
            href="https://go/hackathons"
            target="_blank"
            rel="noopener noreferrer"
          >
            Join a hackathon
          </a>
          <a
            className="header-nav-link"
            href="https://world-of-vibecoding.vibe.intranet.cnb/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Meet the vibers
          </a>
        </nav>
        <div className="header-right">
          {/* Part B Phase 2: orchestrator-dispatched phase agents indicator.
              Hidden when no tasks have run; otherwise shows count + drilldown. */}
          <PhaseTasksChip phaseTasks={phaseTasks} />
          {!isBeginner && (
            <span className="git-info" title={meta.commitSha}>
              {meta.branch} @ {meta.commitSha?.slice(0, 7)}
            </span>
          )}
          {isWorking && (
            <button
              className="btn-pause"
              onClick={async () => {
                if (!sessionId || stopping) return;
                setStopping(true);
                try {
                  await pauseSession(sessionId);
                  setPaused(true);
                } catch (err) {
                  console.error('Pause failed:', err);
                } finally {
                  setStopping(false);
                }
              }}
              disabled={stopping}
              aria-label="Pause current task"
            >
              {stopping ? 'Pausing…' : '⏸ Pause'}
            </button>
          )}
          {isWorking && (
            <button className="btn-stop" onClick={handleStop} disabled={stopping} aria-label="Stop current task">
              {stopping ? 'Stopping…' : '⏹ Stop'}
            </button>
          )}
          <button className="btn-reset" onClick={requestReset} aria-label="Start a new session">
            New chat
          </button>
        </div>
      </header>

      {workspaceGone ? (
        <div className="workspace-gone" role="alert">
          <div className="workspace-gone-title">Your workspace went to sleep</div>
          <p>
            The environment behind this page stopped (Codespaces pauses it after a period of inactivity).
            Nothing is lost: your chat, plan and app are saved and come back as they were.
          </p>
          {portalUrl ? (
            <p>
              <a className="btn-wake" href={portalUrl} target="_blank" rel="noreferrer">
                Back to the portal
              </a>
              <span className="workspace-gone-hint">
                Choose &quot;Start Vibe Coding&quot; there: it wakes the workspace and brings you back here.
              </span>
            </p>
          ) : editorUrlFor(window.location.hostname) ? (
            <p>
              <a className="btn-wake" href={editorUrlFor(window.location.hostname)} target="_blank" rel="noreferrer">
                Wake it up
              </a>
              <span className="workspace-gone-hint">
                Opens your workspace and starts it. The harness starts with it and this page reconnects by itself.
              </span>
            </p>
          ) : (
            <p className="workspace-gone-hint">Start the harness again (<code>cd chat &amp;&amp; npm start</code>); this page reconnects by itself.</p>
          )}
        </div>
      ) : wsStatus === 'disconnected' ? (
        <div className="connection-banner" role="alert">
          Connection lost. Trying to reconnect...
        </div>
      ) : wsStatus === 'reconnecting' ? (
        <div className="connection-banner reconnecting" role="status">
          Reconnecting...
        </div>
      ) : null}

      {showBuildProgress && (
        <div className="build-progress">
          {activeScopeList.map(([scope, info], i) => (
            <div key={scope} className="build-progress-step-wrapper">
              {i > 0 && <div className={`build-progress-connector ${info.status === 'completed' || info.status === 'running' ? 'active' : ''}`} />}
              <div className={`build-progress-step ${info.status === 'running' ? 'active' : ''} ${info.status === 'completed' ? 'completed' : ''} ${info.status === 'error' ? 'error' : ''}`}>
                <span className="build-progress-icon">
                  {info.status === 'completed' ? '✓' : info.status === 'error' ? '✗' : info.status === 'running' ? '●' : '○'}
                </span>
                <span className="build-progress-label">{scopeLabels[scope] || scope}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
        {displayEvents.length === 0 && !isWorking && (
          <div className="empty-state">
            {envInfo?.templateVersion?.needsUpdate && (
              <div className="template-update-banner">
                <div className="template-update-content">
                  <span className="template-update-icon">&#x26A0;&#xFE0F;</span>
                  <div>
                    <strong>Template update available</strong>
                    <p>Version {envInfo.templateVersion.current} &rarr; {envInfo.templateVersion.latest} — includes new features and fixes.</p>
                  </div>
                </div>
                <button
                  className="template-update-btn"
                  onClick={() => handleQuickAction('Run the template update script (scripts/apply-updates.sh) to update this project to the latest template version. Show me what changed.', 'Update template')}
                  disabled={sending || isWorking}
                >
                  Update now
                </button>
              </div>
            )}

            {(() => {
              const hasCode = envInfo?.preflight?.checks?.some(c => c.id === 'project-folders' && c.status === 'pass');

              if (hasCode) {
                // Existing-project welcome: report status and offer to continue rather than
                // starting fresh. Composer is NOT shown by default — user picks an action.
                const idea = envInfo?.projectStatus?.idea;
                const stack = envInfo?.projectStatus?.stack;
                const deployment = envInfo?.projectStatus?.deploymentStatus;
                const phase = envInfo?.projectPhase;
                return (
                  <>
                    <h3>Welcome back!</h3>
                    <p>Here's what I found in your workspace.</p>

                    <div className="welcome-back-card">
                      {idea && (
                        <div className="welcome-back-row">
                          <span className="welcome-back-label">Idea</span>
                          <span className="welcome-back-value">{idea}</span>
                        </div>
                      )}
                      {stack && (
                        <div className="welcome-back-row">
                          <span className="welcome-back-label">Stack</span>
                          <span className="welcome-back-value">{stack}</span>
                        </div>
                      )}
                      {phase && (
                        <div className="welcome-back-row">
                          <span className="welcome-back-label">Phase</span>
                          <span className="welcome-back-value">{phase}</span>
                        </div>
                      )}
                      {deployment && (
                        <div className="welcome-back-row">
                          <span className="welcome-back-label">Deployment</span>
                          <span className="welcome-back-value">{deployment}</span>
                        </div>
                      )}
                    </div>

                    {welcomeComposerOpen ? (
                      <div className="welcome-back-new-convo">
                        <p className="welcome-back-new-convo-hint">
                          Your app code stays as it is — this is a fresh conversation
                          without the previous chat history. Describe what you want to
                          do next.
                        </p>
                        {composerJsx}
                        <button
                          type="button"
                          className="welcome-back-new-convo-back"
                          onClick={() => setWelcomeComposerOpen(false)}
                        >
                          ← Back
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="welcome-back-actions">
                          <button
                            className="welcome-back-primary"
                            onClick={() => {
                              // Resume the most recent session that had a real
                              // user message. `title` is only set when the user
                              // actually sends something (see POST /message in
                              // session.js) — empty shell sessions auto-created
                              // at boot have title === null. Filtering on title
                              // skips those and lands on the session the user
                              // really wants to continue, whether it was a full
                              // build or just a planning conversation.
                              // Placeholder-titled shells (probe/test sessions get
                              // 'Untitled session') must not win over the user's real
                              // conversation — observed live: Continue resumed an empty
                              // probe session and bounced straight back to this screen.
                              const candidates = (pastSessions || []).filter(s => s.sessionId !== sessionId);
                              const withTitle = candidates.find(s => s.title && s.title.trim() && s.title.trim() !== 'Untitled session');
                              const target = withTitle || candidates[0];
                              if (target && onResumeSession) {
                                onResumeSession(target.sessionId);
                              } else {
                                handleQuickAction(
                                  'Please review the existing project files in this workspace, summarise what has already been built, and tell me what you can help me with next.',
                                  'Continue where I left off'
                                );
                              }
                            }}
                            disabled={sending || isWorking}
                          >
                            Continue where I left off →
                          </button>
                          <button
                            className="welcome-back-secondary"
                            onClick={() => setWelcomeComposerOpen(true)}
                            disabled={sending || isWorking}
                          >
                            New conversation (keep my app)
                          </button>
                          <button
                            className="welcome-back-danger"
                            onClick={handleCleanProject}
                            disabled={sending || isWorking}
                          >
                            Start fresh (delete app code)
                          </button>
                        </div>
                      </>
                    )}
                  </>
                );
              }

              // Fresh-start flow (empty workspace).
              return (
                <>
                  <h3>What would you like to build?</h3>
                  <p>Describe your idea and the AI will create it for you.</p>

                  {composerJsx}

                  <a
                    className="marketplace-cta"
                    href="https://vibe-marketplace.vibe.intranet.cnb"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="marketplace-cta-body">
                      <span className="marketplace-cta-title">Need inspiration? Browse the Vibe Marketplace</span>
                      <span className="marketplace-cta-sub">Ready-made ideas from across the company</span>
                    </span>
                  </a>
                </>
              );
            })()}
          </div>
        )}

        {displayEvents.length === 0 && isWorking && (
          <div className="empty-state">
            <div className="loading-spinner" />
            <p style={{ marginTop: '1rem' }}>
              Setting up your session…
            </p>
          </div>
        )}

        {(() => {
          // Group consecutive scoped events into sections
          const sections = [];
          let currentNonScoped = [];
          let scopeGroups = {}; // scope → events[]
          let scopeOrder = []; // track order scopes appeared

          for (const event of displayEvents) {
            const scope = event.payload?.scope;
            if (scope) {
              // Flush non-scoped events first
              if (currentNonScoped.length > 0) {
                sections.push({ type: 'events', events: currentNonScoped });
                currentNonScoped = [];
              }
              if (!scopeGroups[scope]) {
                scopeGroups[scope] = [];
                scopeOrder.push(scope);
              }
              scopeGroups[scope].push(event);
            } else {
              // If we have accumulated scope groups, flush them as a parallel section
              if (scopeOrder.length > 0) {
                sections.push({ type: 'parallel', scopes: { ...scopeGroups }, order: [...scopeOrder] });
                scopeGroups = {};
                scopeOrder = [];
              }
              currentNonScoped.push(event);
            }
          }
          // Flush remaining
          if (scopeOrder.length > 0) {
            sections.push({ type: 'parallel', scopes: { ...scopeGroups }, order: [...scopeOrder] });
          }
          if (currentNonScoped.length > 0) {
            sections.push({ type: 'events', events: currentNonScoped });
          }

          // Group sections into conversation "turns" — each starting with a user message.
          // Events that arrive before any user message (e.g. greetings, system prompts) form
          // an optional opening turn with no user header.
          const turns = [];
          let current = { userEvent: null, body: [] };
          for (const section of sections) {
            if (section.type === 'events') {
              for (const ev of section.events) {
                if (ev.type === 'user' && ev.payload?.source !== 'system') {
                  if (current.userEvent || current.body.length) turns.push(current);
                  current = { userEvent: ev, body: [] };
                } else {
                  current.body.push({ kind: 'event', event: ev });
                }
              }
            } else {
              current.body.push({ kind: 'parallel', section });
            }
          }
          if (current.userEvent || current.body.length) turns.push(current);

          function renderParallelSection(section, keyBase, { isPastTurn = false } = {}) {
            // Parallel scopes section — split into build (phase 0) and integration (phase 1) rows
            const buildScopes = section.order.filter(s => !PHASE1_SCOPES.has(s));
            const integrationScopes = section.order.filter(s => PHASE1_SCOPES.has(s));

            // Build-phase wall-clock total: span from the first scope's first
            // event to the last scope's report (or last event). All scopes run
            // in parallel, so this is wall-clock, not the sum of per-card times.
            const buildTotal = (() => {
              let min = Infinity, max = -Infinity, done = 0, total = 0;
              for (const s of section.order) {
                const evs = section.scopes[s] || [];
                if (!evs.length) continue;
                total += 1;
                const startTs = evs[0]?.ts;
                const report = [...evs].reverse().find(e => e?.type === 'cline' && e.payload?.say === 'completion_result');
                const endTs = report?.ts || evs[evs.length - 1]?.ts;
                if (report) done += 1;
                if (startTs != null) min = Math.min(min, startTs);
                if (endTs != null) max = Math.max(max, endTs);
              }
              if (!total || min === Infinity || max === -Infinity) return null;
              return { ms: max - min, done, total, allDone: done === total };
            })();

            function renderScopeBox(scope) {
              const scopeEvents = dedupeStreamingText(section.scopes[scope] || []);
              // A scope_status left over from an EARLIER turn must not color this
              // turn's card: a stale 'completed' froze a card at "done · 3s" while
              // the re-dispatched agent ran 21 more minutes — and the heartbeat
              // only renders on running cards, so all progress was invisible.
              const scopeInfo = (() => {
                const info = scopeStatuses[scope];
                if (!info || info.ts == null) return info;
                const sectionStartTs = scopeEvents[0]?.ts ?? null;
                if (sectionStartTs != null && info.ts < sectionStartTs - 120000) return null;
                return info;
              })();

              // Split events into the final "report" (last completion_result) and the
              // rest (process steps).
              const reportIdx = (() => {
                for (let i = scopeEvents.length - 1; i >= 0; i--) {
                  const ev = scopeEvents[i];
                  if (ev?.type === 'cline' && ev.payload?.say === 'completion_result') return i;
                }
                return -1;
              })();
              const reportEvent = reportIdx >= 0 ? scopeEvents[reportIdx] : null;
              const processEvents = reportIdx >= 0
                ? [...scopeEvents.slice(0, reportIdx), ...scopeEvents.slice(reportIdx + 1)]
                : scopeEvents;
              // Count only the process events that MessageBubble will actually render (api_req_started returns null, etc).
              const processStepCount = processEvents.filter(ev => {
                const say = ev.payload?.say;
                const ask = ev.payload?.ask;
                return ['text', 'command', 'tool', 'task_progress', 'completion_result'].includes(say) || ask === 'command_output';
              }).length;

              // Status is DERIVED from the event stream, not just scope_status —
              // the parallel build fan-out only emits scope_status for 'orchestrator'
              // and 'verification', so per-scope cards would otherwise never flip to
              // done/running. A scope with a completion_result report is DONE; one with
              // events but no report is RUNNING; one with nothing yet is queued.
              const isCancelled = scopeInfo?.status === 'cancelled';
              const isComplete = !isCancelled && (scopeInfo?.status === 'completed' || reportEvent != null);
              const isFailed = isComplete && scopeInfo?.exitCode != null && scopeInfo.exitCode !== 0;
              const isSucceeded = isComplete && !isFailed;
              const isRunning = !isComplete && !isCancelled && (scopeInfo?.status === 'running' || processEvents.length > 0);

              // Per-task timing, derived from the event stream (the build fan-out
              // doesn't emit per-scope scope_status, so we can't rely on startedAt).
              const scopeStartTs = scopeEvents[0]?.ts || scopeInfo?.startedAt || null;
              const scopeEndTs = reportEvent?.ts || scopeEvents[scopeEvents.length - 1]?.ts || null;
              const scopeDurationMs = (scopeStartTs && scopeEndTs && scopeEndTs >= scopeStartTs)
                ? scopeEndTs - scopeStartTs : null;

              const openScope = (mode) => setScopeView({
                label: scopeLabels[scope] || scope, scope, reportEvent, processEvents, mode,
              });

              // One-line card: badge + live/done status + a pop-out icon (modal)
              // and an arrow (drawer). The whole row opens the drawer; the icon
              // opens the modal. Both show the report + every step — no inline
              // expand or nested clicks.
              return (
                <div
                  key={scope}
                  className={`scope-section scope-row ${isSucceeded ? 'completed' : ''} ${isFailed ? 'failed' : ''} ${isRunning ? 'running' : ''} ${isCancelled ? 'cancelled' : ''}`}
                >
                  <div
                    className="scope-header scope-header-clickable"
                    role="button"
                    tabIndex={0}
                    title="Open this subagent in a side drawer"
                    onClick={() => openScope('drawer')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openScope('drawer'); } }}
                  >
                    <span className={`scope-badge scope-${scope}`}>
                      {scopeLabels[scope] || scope}
                    </span>
                    {isRunning && (
                      <span className="scope-status scope-status-running">
                        <span className="scope-status-dot" />
                        working{scopeStartTs ? ` · ${formatElapsed(scopeStartTs)}` : ''}
                        {processStepCount > 0 ? ` · ${processStepCount} step${processStepCount === 1 ? '' : 's'}` : ''}
                        {(() => {
                          const hb = scopeHeartbeats[scope];
                          if (!hb || !hb.chars) return null;
                          const fresh = Date.now() - hb.ts < 20000;
                          return fresh ? ` · generating ${(hb.chars / 1000).toFixed(1)}k chars` : null;
                        })()}
                      </span>
                    )}
                    {isSucceeded && (
                      <span className="scope-status scope-status-done"><span className="scope-check">✓</span> done{scopeDurationMs != null ? ` · ${formatDurationMs(scopeDurationMs)}` : ''}</span>
                    )}
                    {isFailed && (
                      <span className="scope-status scope-status-failed" title={`Exited with code ${scopeInfo.exitCode}`}><span className="scope-fail">✗</span> failed</span>
                    )}
                    {isCancelled && (
                      <span className="scope-status scope-status-cancelled"><span className="scope-cancelled">⊘</span> cancelled</span>
                    )}
                    {!isRunning && !isComplete && !isCancelled && isWorking && (
                      <span className="scope-status scope-status-pending">
                        <span className="scope-status-dot" /> queued…
                      </span>
                    )}
                    <button
                      type="button"
                      className="scope-popout-btn"
                      title="Open in a popup"
                      aria-label="Open this subagent in a popup"
                      onClick={(e) => { e.stopPropagation(); openScope('modal'); }}
                    >⤢</button>
                    <span className="scope-section-chevron" aria-hidden>▸</span>
                  </div>
                </div>
              );
            }

            // No group wrapper: each scope is its own collapsed card, so we
            // render them directly inline (past turns included). The old
            // "N scopes completed" disclosure was redundant once scopes became
            // individually collapsible — and it produced a stack of wrapper rows
            // on multi-dispatch builds.
            return (
              <div key={keyBase}>
                {buildScopes.length > 0 && (
                  <div className="parallel-scopes">
                    {buildScopes.map(renderScopeBox)}
                  </div>
                )}
                {integrationScopes.length > 0 && (
                  <div className="parallel-scopes integration-row">
                    {integrationScopes.map(renderScopeBox)}
                  </div>
                )}
                {buildTotal && buildTotal.allDone && (
                  <div className="parallel-scopes-total">
                    <span className="scope-check">✓</span> All {buildTotal.total} task{buildTotal.total === 1 ? '' : 's'} completed · {formatDurationMs(buildTotal.ms)} total
                  </div>
                )}
              </div>
            );
          }

          return turns.map((turn, ti) => {
            const isPastTurn = ti < turns.length - 1;

            // Split the turn's event items into:
            //   - processItems: intermediate Cline chatter (text, command, tool,
            //     task_progress, command output) that belongs in the collapsible
            //     "Process" block
            //   - reportItem: the last non-scoped completion_result — rendered
            //     prominently below the Process toggle
            //   - tailItems: non-Cline events after the report (completion
            //     summary, app_ready, app_ready_prompt, etc.) and parallel
            //     sections — keep these at their original position
            // This mirrors the scope-box pattern for non-scoped turns so quick
            // actions (Stop/Start/Deploy) don't scatter progress checklists
            // and command output around the final summary.
            const PROCESS_SAYS = new Set(['text', 'command', 'tool', 'task_progress']);
            const PROCESS_ASKS = new Set(['command_output']);
            const isNonScopedCline = (ev) =>
              ev?.type === 'cline' && !ev.payload?.scope;
            const isProcessEvent = (ev) => {
              if (!isNonScopedCline(ev)) return false;
              const { say, ask } = ev.payload || {};
              return PROCESS_SAYS.has(say) || PROCESS_ASKS.has(ask);
            };
            const isReportEvent = (ev) =>
              isNonScopedCline(ev) && ev.payload?.say === 'completion_result';

            // Find the last completion_result among standalone events.
            let reportIdx = -1;
            for (let i = turn.body.length - 1; i >= 0; i--) {
              const item = turn.body[i];
              if (item.kind === 'event' && isReportEvent(item.event)) {
                reportIdx = i;
                break;
              }
            }

            const processItems = [];
            const tailItems = [];
            let reportItem = null;
            for (let i = 0; i < turn.body.length; i++) {
              const item = turn.body[i];
              if (i === reportIdx) {
                reportItem = item;
                continue;
              }
              if (item.kind === 'event' && isProcessEvent(item.event) && reportIdx !== -1 && i < reportIdx) {
                processItems.push(item);
              } else {
                tailItems.push(item);
              }
            }

            const processStepCount = processItems.filter(it => {
              const ev = it.event;
              const { say, ask } = ev.payload || {};
              return PROCESS_SAYS.has(say) || PROCESS_ASKS.has(ask);
            }).length;

            // A build turn can produce MULTIPLE parallel sections for the SAME
            // scope (initial dispatch + auto-recovery re-engages each start a
            // new section when a non-scoped event interrupts the stream). Merge
            // them into ONE card per scope — otherwise a scope renders 3-4 times,
            // some cards empty. Then render: pre-scope events → merged scope
            // cards → post-scope tail (build report, "all tasks completed",
            // verify phase, app-ready) so the report lands AFTER the cards.
            const parallelItems = turn.body.filter(it => it.kind === 'parallel');
            const hasScopes = parallelItems.length > 0;
            let mergedSection = null;
            if (hasScopes) {
              const scopes = {};
              const order = [];
              for (const it of parallelItems) {
                for (const s of it.section.order) {
                  if (!scopes[s]) { scopes[s] = []; order.push(s); }
                  scopes[s] = scopes[s].concat(it.section.scopes[s] || []);
                }
              }
              mergedSection = { type: 'parallel', scopes, order };
            }
            const firstParallelIdx = turn.body.findIndex(it => it.kind === 'parallel');
            const beforeScopeItems = hasScopes
              ? turn.body.filter((it, i) => i < firstParallelIdx && it.kind === 'event')
              : [];
            const afterScopeItems = hasScopes
              ? turn.body.filter((it, i) => i > firstParallelIdx && it.kind === 'event')
              : [];

            const renderEventItem = (item, i) => (
              item.kind === 'event' ? (
                <MessageBubble
                  key={`t${ti}-e${i}`}
                  type={item.event.type}
                  payload={item.event.payload}
                  onSendMessage={handleQuickAction} onClarifyActive={handleClarifyActive}
                  isPastTurn={isPastTurn}
                />
              ) : (
                renderParallelSection(item.section, `t${ti}-p${i}`, { isPastTurn })
              )
            );

            // The "Pre-start auto-correction" emits (docker-orchestration.js) are a
            // distinct verify-and-fix phase, not part of the conversation. Render
            // consecutive ones inside ONE collapsed disclosure so the user sees a
            // single "Verifying & fixing your app" step instead of a wall of bubbles
            // (and the long ghost-import "Skipped (no auto-fix)" list stays hidden
            // until they expand it).
            const isVerifyItem = (item) =>
              item.kind === 'event'
              && item.event?.type === 'cline'
              && item.event.payload?.say === 'text'
              && typeof item.event.payload?.text === 'string'
              && item.event.payload.text.trimStart().startsWith('Pre-start auto-correction');

            // verify_step events (docker-orchestration.js emitVerifyStep) fold
            // into a live step list so the multi-minute verify phase reads as
            // named steps instead of an opaque chip.
            const isVerifyStepItem = (item) =>
              item.kind === 'event' && item.event?.type === 'verify_step';

            const VERIFY_STEP_LABELS = {
              'code-quality': 'Code quality checks',
              'cross-check': 'Cross-checking components',
              'auto-recovery': 'Automatic repairs',
              'containers': 'Packaging & starting containers',
              'migrations': 'Applying database changes',
              'endpoint-tests': 'Testing every endpoint',
              'visual-check': 'Visual check',
            };
            const VERIFY_STEP_ORDER = Object.keys(VERIFY_STEP_LABELS);

            const renderItemsGrouped = (items, keyPrefix) => {
              const out = [];
              let run = [];
              const flushRun = (idx) => {
                if (!run.length) return;
                const runItems = run;
                run = [];

                // Same one-line + drawer/modal affordance as the scope cards:
                // the verify-and-fix step opens its fixes in the side drawer
                // (row/arrow) or a popup (icon), instead of an inline disclosure.
                const verifyEvents = runItems.map(it => it.event);
                const openVerify = (mode) => setScopeView({
                  label: 'Verifying & fixing your app', scope: 'verification',
                  reportEvent: null, processEvents: verifyEvents, stepsLabel: 'Fixes', mode,
                });
                out.push(
                  <div className="scope-section scope-row" key={`${keyPrefix}-verify-${idx}`}>
                    <div
                      className="scope-header scope-header-clickable verify-row-header"
                      role="button"
                      tabIndex={0}
                      title="Open the verify-and-fix details"
                      onClick={() => openVerify('drawer')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVerify('drawer'); } }}
                    >
                      <span className="scope-badge verify-badge">Verifying &amp; fixing your app</span>
                      <span className="scope-status scope-status-done">
                        <span className="scope-check">✓</span> {runItems.length} fix{runItems.length === 1 ? '' : 'es'}
                      </span>
                      <button
                        type="button"
                        className="scope-popout-btn"
                        title="Open in a popup"
                        aria-label="Open the verify-and-fix details in a popup"
                        onClick={(e) => { e.stopPropagation(); openVerify('modal'); }}
                      >⤢</button>
                      <span className="scope-section-chevron" aria-hidden>▸</span>
                    </div>
                  </div>
                );
              };
              // ONE step card per turn: fold every verify_step event (regardless of
              // interruptions by other bubbles) into the latest status per step,
              // rendered at the position of the first step event. Folding only
              // consecutive events froze earlier cards at "working" forever.
              const stepsByKey = {};
              for (const it of items) {
                if (!isVerifyStepItem(it)) continue;
                const p = it.event.payload || {};
                if (p.step) stepsByKey[p.step] = { status: p.status, detail: p.detail };
              }
              const stepRows = VERIFY_STEP_ORDER
                .filter(k => stepsByKey[k])
                .map(k => ({ step: k, label: VERIFY_STEP_LABELS[k], ...stepsByKey[k] }));
              let stepCardEmitted = false;
              const emitStepCard = (idx) => {
                if (stepCardEmitted || !stepRows.length) return;
                stepCardEmitted = true;
                out.push(
                  <div className="verify-steps-card" key={`${keyPrefix}-vsteps-${idx}`}>
                    <div className="verify-steps-title">Verifying your app</div>
                    {stepRows.map(r => (
                      <div className={`verify-step-row verify-step-${r.status}`} key={r.step}>
                        <span className="verify-step-icon" aria-hidden>
                          {r.status === 'done' ? '\u2713' : r.status === 'warn' ? '!' : '\u25CF'}
                        </span>
                        <span className="verify-step-label">{r.label}</span>
                        {r.detail ? <span className="verify-step-detail">{r.detail}</span> : (r.status === 'start' ? <span className="verify-step-detail">working…</span> : null)}
                      </div>
                    ))}
                  </div>
                );
              };

              items.forEach((item, i) => {
                if (isVerifyStepItem(item)) { flushRun(i); emitStepCard(i); return; }
                if (isVerifyItem(item)) { run.push(item); return; }
                flushRun(i);
                out.push(renderEventItem(item, `${keyPrefix}-${i}`));
              });
              flushRun('end');
              return out;
            };

            return (
              <div
                key={`turn-${ti}`}
                className={`conversation-turn${turn.userEvent ? ' has-user' : ' opening-turn'}${isPastTurn ? ' past-turn' : ''}`}
              >
                {turn.userEvent && (
                  <MessageBubble
                    type="user"
                    payload={turn.userEvent.payload}
                    eventTs={turn.userEvent.ts}
                    onSendMessage={handleQuickAction} onClarifyActive={handleClarifyActive}
                    onBranch={handleBranchRequest}
                    isPastTurn={isPastTurn}
                  />
                )}
                {turn.body.length > 0 && (
                  <div className="turn-body">
                    {/* BUILD turn — render the merged scope cards (one per scope)
                        between the pre-scope intro and the post-scope tail, so the
                        build report sits AFTER the cards it summarises and no scope
                        is duplicated. CONVERSATIONAL turns keep report-on-top. */}
                    {hasScopes ? (
                      <>
                        {renderItemsGrouped(beforeScopeItems, `t${ti}-pre`)}
                        {renderParallelSection(mergedSection, `t${ti}-scopes`, { isPastTurn })}
                        {renderItemsGrouped(afterScopeItems, `t${ti}-post`)}
                      </>
                    ) : reportItem ? (
                      <>
                        {processItems.length > 0 && (
                          <details className="scope-process turn-process">
                            <summary>
                              <span className="scope-process-label">Process</span>
                              <span className="scope-process-count">
                                {processStepCount > 0
                                  ? `${processStepCount} step${processStepCount === 1 ? '' : 's'}`
                                  : ''}
                              </span>
                              <span className="scope-process-chevron">▸</span>
                            </summary>
                            <div className="scope-events">
                              {processItems.map((item, i) => renderEventItem(item, `p${i}`))}
                            </div>
                          </details>
                        )}
                        <div className="scope-report turn-report">
                          {renderEventItem(reportItem, `r`)}
                        </div>
                        {renderItemsGrouped(tailItems, `t${ti}-tail`)}
                      </>
                    ) : (
                      renderItemsGrouped(turn.body, `t${ti}-all`)
                    )}
                  </div>
                )}
              </div>
            );
          });
        })()}

        {pendingPlan && (
          <div className="plan-preview-card">
            {/* ── Header ── framed as a confirmation question (C1) so the user
                 catches a misinterpretation BEFORE code runs. */}
            <div className="plan-preview-header">
              <span className="plan-preview-icon">🗂️</span>
              <div className="plan-preview-header-text">
                <strong>Does this sound right?</strong>
                {pendingPlan.message && (
                  <p className="plan-preview-subtitle">
                    <span className="plan-preview-lead">Here&apos;s what I understood:</span>{' '}
                    {pendingPlan.message}
                  </p>
                )}
              </div>
            </div>

            {/* ── Section 1: Plain-English summary rendered in header above; skip standalone section ── */}
            {false && pendingPlan.message && (
              <div className="plan-section plan-section-summary">
                <p className="plan-preview-message">{pendingPlan.message}</p>
              </div>
            )}

            {/* ── Section 2: What the AI will do (task list) ── */}
            {pendingPlan.tasks && pendingPlan.tasks.length > 0 && (
              <div className="plan-section plan-section-tasks">
                <h4 className="plan-section-title">
                  <span className="plan-section-icon">🤖</span> What the AI will do
                </h4>
                <ul className="plan-preview-tasks">
                  {pendingPlan.tasks.map((t, i) => {
                    // Prefer user-facing summary (v4.1+). Fall back to truncating
                    // the dense spec for older router responses without a summary.
                    const userDesc =
                      t.summary ||
                      (t.task
                        ? t.task.slice(0, 140) + (t.task.length > 140 ? '…' : '')
                        : '');
                    const showTechDetails = t.summary && t.task && t.task !== t.summary;
                    return (
                      <li key={i} className="plan-preview-task">
                        <span className="plan-task-num">{i + 1}</span>
                        <span
                          className="plan-task-scope"
                          data-scope={(t.scope || '').toLowerCase()}
                        >
                          {t.scope}
                        </span>
                        <div className="plan-task-content">
                          <span className="plan-task-desc">{userDesc}</span>
                          {showTechDetails && (
                            <details className="plan-task-tech">
                              <summary>View technical details</summary>
                              <pre className="plan-task-tech-body">{t.task}</pre>
                            </details>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* ── Section 3: Hybrid module badges (shown when AI modules will run) ── */}
            {pendingPlan.modulePlan && (
              <div className="plan-section plan-section-modules" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <ModuleReasonBadge
                  modulePlan={pendingPlan.modulePlan}
                  reasonCodes={pendingPlan.reasonCodes}
                  confidence={pendingPlan.confidence}
                />
                <button
                  onClick={() => setTraceOpen(true)}
                  style={{
                    fontSize: 11, color: '#a78bfa', background: 'none', border: 'none',
                    cursor: 'pointer', padding: '2px 0', textDecoration: 'underline',
                  }}
                  aria-label="View AI module trace"
                >
                  View trace
                </button>
              </div>
            )}

            {/* ── Section 4: Tech details (collapsible) ── */}
            {pendingPlan.techDetails && (
              <div className="plan-section plan-section-tech">
                <details className="plan-tech-details">
                  <summary className="plan-tech-summary">
                    <span className="plan-section-icon">🔧</span> Technical details
                  </summary>
                  <p className="plan-tech-body">{pendingPlan.techDetails}</p>
                </details>
              </div>
            )}

            {/* ── Request changes input ── */}
            <div className="plan-changes-area">
              {!showPlanChanges ? (
                <button
                  className="btn-plan-request-changes"
                  onClick={() => setShowPlanChanges(true)}
                  disabled={planRevising}
                >
                  ✏️ Request changes to this plan
                </button>
              ) : (
                <div className="plan-changes-input-wrap">
                  <textarea
                    className="plan-changes-textarea"
                    placeholder="Describe what you'd like to change… e.g. &quot;Use PostgreSQL instead of SQLite&quot; or &quot;Add a dark mode toggle&quot;"
                    value={planChangeInput}
                    onChange={e => setPlanChangeInput(e.target.value)}
                    rows={3}
                    autoFocus
                  />
                  <div className="plan-changes-btns">
                    <button
                      className="btn-plan-submit-changes"
                      disabled={planRevising || !planChangeInput.trim()}
                      onClick={async () => {
                        if (!planChangeInput.trim() || !sessionId) return;
                        setPlanRevising(true);
                        const feedback = planChangeInput.trim();
                        setPlanChangeInput('');
                        setShowPlanChanges(false);
                        setPendingPlan(null);
                        try {
                          await revisePlan(sessionId, feedback);
                        } catch (err) {
                          console.error('Revise plan failed:', err);
                        } finally {
                          setPlanRevising(false);
                        }
                      }}
                    >
                      {planRevising ? 'Updating…' : '↩ Submit changes'}
                    </button>
                    <button
                      className="btn-plan-cancel-changes"
                      onClick={() => { setShowPlanChanges(false); setPlanChangeInput(''); }}
                      disabled={planRevising}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Action buttons ── framed as yes/no to the confirmation question above. */}
            <div className="plan-preview-actions">
              <button className="btn-confirm-plan" onClick={handleConfirmPlan} disabled={planRevising}>
                ✅ Yes, build it
              </button>
              <button className="btn-discard-plan" onClick={handleDiscardPlan} disabled={planRevising}>
                ✕ No, let me rephrase
              </button>
            </div>
          </div>
        )}

        {/* Hide the open-app prompt while a new turn is working — a stale
            "your app is running, open it?" from the PREVIOUS run next to a
            live progress card reads as a contradiction. The next app_ready
            event re-populates it with fresh state. */}
        {pendingAppOpen && !isWorking && (
          <div className="app-open-prompt-card" role="dialog" aria-labelledby="app-open-title">
            <div className="app-open-prompt-header">
              <div>
                <strong id="app-open-title">{pendingAppOpen.message}</strong>
                <p className="app-open-prompt-url">{pendingAppOpen.url}</p>
              </div>
            </div>
            <div className="app-open-prompt-actions">
              <button
                className="btn-app-open"
                onClick={handleOpenApp}
                disabled={appActionInFlight !== null}
                autoFocus
              >
                Yes, open it
              </button>
              <button
                className="btn-app-close"
                onClick={handleCloseApp}
                disabled={appActionInFlight !== null}
              >
                {appActionInFlight === 'close' ? 'Stopping…' : 'No, stop it'}
              </button>
            </div>
          </div>
        )}

        {/* ── Paused state panel ── */}
        {paused && !isWorking && (
          <div className="paused-panel" role="status">
            <div className="paused-panel-header">
              <span className="paused-panel-icon">⏸</span>
              <strong>Task paused</strong>
              <span className="paused-panel-hint">Send a new message to continue.</span>
            </div>
            <div className="paused-panel-actions">
              <button
                className="btn-pause-discard"
                onClick={() => setPaused(false)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {isWorking && displayEvents.length > 0 && (
          <div className="typing-indicator">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-label">
              {friendlyActivity || 'Thinking...'}
              {waitPhrase && (
                <span className="typing-elapsed"> — {waitPhrase}</span>
              )}
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {showScrollTopBtn && (
        <button className="scroll-top-btn" onClick={scrollToTop} aria-label="Scroll to start of conversation" title="Jump to start">
          <ChevronDownIcon />
        </button>
      )}

      {showScrollBtn && (
        <button className="scroll-bottom-btn" onClick={scrollToBottom} aria-label="Scroll to bottom">
          <ChevronDownIcon />
        </button>
      )}

      {(() => {
        const hasCode = envInfo?.preflight?.checks?.some(c => c.id === 'project-folders' && c.status === 'pass') || false;
        const barVisible = !isWorking && displayEvents.length > 0 && clarifyActiveCount === 0 && (
          Object.values(scopeStatuses).some(info => info.status === 'completed')
          || appRunning
          || dockerRunning
          // Fallback for resumed sessions: if the workspace has actual app code
          // the user clearly has something to act on, even when scopeStatuses
          // hasn't rehydrated (old sessions built before scope_status events
          // were persisted to the transcript).
          || hasCode
        );
        if (!barVisible) return null;
        return (
        <div className="quick-actions">
          {getQuickActions(scopeStatuses, appRunning, dockerRunning, hasCode).map((action) => (
            <button
              key={action.label}
              className={`quick-action-btn${action.action === 'clean' ? ' quick-action-danger' : ''}`}
              onClick={() => {
                if (action.action === 'clean') return handleCleanProject();
                if (action.action === 'stop') return handleStopApp();
                if (action.action === 'start') return handleStartApp();
                return handleQuickAction(action.prompt, action.label);
              }}
              disabled={sending || (['stop', 'start'].includes(action.action) && appActionInFlight != null)}
            >
              <span>{action.emoji}</span> {action.label}
            </button>
          ))}
        </div>
        );
      })()}

      {sendError && (
        <div className="send-error" role="alert">
          <span>{sendError}</span>
          <button onClick={handleRetry}>Retry</button>
        </div>
      )}

      {showTokenBar && hasUserMessages && tokenTotals && (tokenTotals.promptTokens > 0 || tokenTotals.completionTokens > 0) && (
        <div className="opt-score-bar" role="status" aria-label="Token usage">
          <div className="opt-score-left">
            {tokenTotals.cachedTokens > 0 && (
              <>
                <span className="opt-score-icon">⚡</span>
                <span className="opt-score-main">
                  <span className="opt-score-saved">~{formatTokens(tokenTotals.cachedTokens)} tokens cached</span>
                </span>
              </>
            )}
          </div>
          <div className="opt-score-center">
            <span
              className="token-usage-chip"
              title={`${tokenTotals.promptTokens} prompt + ${tokenTotals.completionTokens} completion (${tokenTotals.cachedTokens} cached) across ${tokenTotals.apiCalls} API call${tokenTotals.apiCalls === 1 ? '' : 's'}`}
            >
              <span className="token-usage-label">Used</span>
              <span className="token-usage-value">
                {formatTokens(tokenTotals.promptTokens + tokenTotals.completionTokens)}
              </span>
              <span className="token-usage-detail">
                ({formatTokens(tokenTotals.promptTokens)} in, {formatTokens(tokenTotals.completionTokens)} out
                {tokenTotals.cachedTokens > 0 && `, ${formatTokens(tokenTotals.cachedTokens)} cached`})
              </span>
            </span>
          </div>
          <div className="opt-score-right" />
        </div>
      )}

      {displayEvents.length > 0 && clarifyActiveCount === 0 && composerJsx}

      <ExamplesModal
        open={showExamples}
        onClose={() => setShowExamples(false)}
        onUsePrompt={(text) => {
          setInput(text);
          // Focus the textarea so user can edit & send
          setTimeout(() => textareaRef.current?.focus(), 50);
        }}
      />

      {/* ── Subagent detail: pop-out MODAL or side DRAWER (same content) ── */}
      {scopeView && (() => {
        const { label, reportEvent, processEvents = [], stepsLabel = 'Process', mode } = scopeView;
        const body = (
          <>
            {processEvents.length > 0 && (
              <div className="scope-detail-steps">
                <div className="scope-detail-steps-title">
                  {stepsLabel} · {processEvents.length}
                </div>
                {processEvents.map((event, i) => (
                  <MessageBubble key={i} type={event.type} payload={event.payload}
                    onSendMessage={handleQuickAction} onClarifyActive={handleClarifyActive} isPastTurn />
                ))}
              </div>
            )}
            {reportEvent && (
              <div className="scope-detail-report">
                <div className="scope-detail-steps-title">Report</div>
                <MessageBubble type={reportEvent.type} payload={reportEvent.payload}
                  onSendMessage={handleQuickAction} onClarifyActive={handleClarifyActive} isPastTurn />
              </div>
            )}
          </>
        );
        if (mode === 'drawer') {
          return (
            <div className="scope-drawer-overlay" role="dialog" aria-modal="true"
              aria-label={`${label} — details`} onClick={() => setScopeView(null)}>
              <div className="scope-drawer" onClick={e => e.stopPropagation()}>
                <div className="scope-drawer-header">
                  <h3>{label}</h3>
                  <button className="modal-close-btn" onClick={() => setScopeView(null)} aria-label="Close">✕</button>
                </div>
                <div className="scope-drawer-body">{body}</div>
              </div>
            </div>
          );
        }
        return (
          <div className="modal-overlay" role="dialog" aria-modal="true"
            aria-label={`${label} — details`} onClick={() => setScopeView(null)}>
            <div className="process-modal" onClick={e => e.stopPropagation()}>
              <div className="process-modal-header">
                <h3>{label}</h3>
                <button className="modal-close-btn" onClick={() => setScopeView(null)} aria-label="Close">✕</button>
              </div>
              <div className="process-modal-body">{body}</div>
            </div>
          </div>
        );
      })()}

      {/* ── New-chat confirmation dialog ── */}
      {showResetConfirm && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title" onClick={() => setShowResetConfirm(false)}>
          <div className="reset-confirm-card" onClick={e => e.stopPropagation()}>
            <div className="reset-confirm-icon">💬</div>
            <h3 id="reset-confirm-title" className="reset-confirm-title">Start a new chat?</h3>
            <p className="reset-confirm-body">
              Your current session will be saved and you can return to it any time from the&nbsp;
              <strong>☰ history</strong> menu.
            </p>
            <div className="reset-confirm-actions">
              <button className="reset-confirm-yes" onClick={doReset} autoFocus>
                ✓ Yes, new chat
              </button>
              <button className="reset-confirm-no" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Branch-from-here confirmation dialog ── */}
      {branchConfirm && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="branch-confirm-title" onClick={handleBranchCancel}>
          <div className="reset-confirm-card" onClick={e => e.stopPropagation()}>
            <div className="reset-confirm-icon">↪</div>
            <h3 id="branch-confirm-title" className="reset-confirm-title">Branch from this message?</h3>
            <p className="reset-confirm-body">
              A new chat will open with the conversation up to this point.
              Project files will be <strong>reverted</strong> to the state you
              saw when you sent this message — any later changes, including
              uncommitted edits, will be overwritten.
            </p>
            <p className="reset-confirm-body" style={{ marginTop: '0.5rem', fontSize: '0.875em', opacity: 0.8 }}>
              This session stays intact in the&nbsp;<strong>☰ history</strong>&nbsp;menu if you want to come back.
            </p>
            <div className="reset-confirm-actions">
              <button className="reset-confirm-yes" onClick={handleBranchConfirm} disabled={branching} autoFocus>
                {branching ? 'Branching…' : '✓ Yes, branch'}
              </button>
              <button className="reset-confirm-no" onClick={handleBranchCancel} disabled={branching}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast notifications ── */}
      {toasts.length > 0 && (
        <div className="toast-container" aria-live="polite">
          {toasts.map(t => (
            <div key={t.id} className={`toast toast-${t.type} toast-enter`}>
              <span className="toast-icon">
                {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}
              </span>
              <span className="toast-message">{t.message}</span>
              <button className="toast-close" onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))} aria-label="Dismiss">×</button>
            </div>
          ))}
        </div>
      )}

      {/* ── Hybrid module trace panel ── */}
      <TracePanel
        sessionId={sessionId}
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
      />

    </div>
  );
}
