import { useState, useEffect, useCallback, useRef } from 'react';
import { getAuthStatus, startSession, savePreferences, listSessions, resumeSession, renameSession, deleteSession } from './lib/api.js';
import ConnectScreen from './components/ConnectScreen.jsx';
import WelcomeModal from './components/OnboardingScreen.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import AppSecretsModal from './components/AppSecretsModal.jsx';
import Drawer from './components/Drawer.jsx';
import ChatScreen from './components/ChatScreen.jsx';
import Toast from './components/Toast.jsx';

// ── Pro Tips shown during conversation switching ───────────────────────────────
const PRO_TIPS = [
  { emoji: '⚡', text: 'MCP tools fetch your rules & snippets on-demand — only when the AI needs them, keeping every prompt lean.' },
  { emoji: '💬', text: 'Be specific in your prompt. The more detail you give, the less back-and-forth the AI needs.' },
  { emoji: '🔧', text: 'You can ask the AI to fix a specific scope — e.g. "Fix only the backend errors" — without touching the rest.' },
  { emoji: '📝', text: 'Add a .rules file to your project root to give the AI permanent instructions about your coding style.' },
  { emoji: '🚀', text: 'After building, try "Run locally" to test your app in Docker before deploying.' },
  { emoji: '🧩', text: 'Snippets are reusable code blocks. The AI fetches the right one automatically — saving you hundreds of tokens per call.' },
  { emoji: '🔄', text: 'Use "New chat" to start fresh — your previous conversation is saved and accessible from the history drawer.' },
  { emoji: '🎯', text: 'Describe your app\'s audience and goals up front — the AI will make better architecture decisions.' },
  { emoji: '📦', text: 'The MCP server only loads the environment config when it\'s actually relevant, not on every request.' },
  { emoji: '💡', text: 'Ask the AI to "summarise what was built" at any time to get a quick overview of your project.' },
];

function SessionSwitchingOverlay() {
  const [tipIdx, setTipIdx] = useState(() => Math.floor(Math.random() * PRO_TIPS.length));
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Rotate tips every 3.5 seconds — purely cosmetic, no network calls
    const interval = setInterval(() => {
      setVisible(false); // fade out
      setTimeout(() => {
        setTipIdx(prev => (prev + 1) % PRO_TIPS.length);
        setVisible(true); // fade in
      }, 300);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  const tip = PRO_TIPS[tipIdx];

  return (
    <div className="session-switching-overlay" aria-live="polite" aria-label="Loading conversation">
      <div className="session-switching-card">
        <div className="loading-spinner" />
        <span className="session-switching-label">Loading conversation...</span>
        <div className={`session-switching-tip${visible ? ' tip-visible' : ' tip-hidden'}`}>
          <span className="session-tip-emoji">{tip.emoji}</span>
          <span className="session-tip-header">Pro tip</span>
          <p className="session-tip-text">{tip.text}</p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [sessionId, setSessionId] = useState(null);
  const [pastSessions, setPastSessions] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAppSecrets, setShowAppSecrets] = useState(false);
  const [mode, setMode] = useState('beginner');
  const [switchingSession, setSwitchingSession] = useState(false);
  const [showTokenBar, setShowTokenBar] = useState(
    () => localStorage.getItem('show_token_bar') !== 'false'
  );

  useEffect(() => { checkAuth(); }, []);

  function addToast(message, type = 'error') {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  }

  function removeToast(id) {
    setToasts(prev => prev.filter(t => t.id !== id));
  }

  async function checkAuth() {
    try {
      const { configured, mode: userMode } = await getAuthStatus();
      if (configured) {
        setMode(userMode || 'beginner');
        // Show welcome modal on first visit
        if (!localStorage.getItem('onboarding_dismissed')) {
          setShowWelcome(true);
        }
        // Go straight to chat — sessions are in the drawer
        await loadSessionsAndStart();
      } else {
        setScreen('connect');
      }
    } catch {
      setScreen('connect');
    }
  }

  const beginSession = useCallback(async () => {
    setSessionId(null);
    setScreen('chat');
    try {
      const { sessionId: id } = await startSession();
      setSessionId(id);
    } catch (err) {
      console.error('Failed to start session:', err);
      addToast('Failed to start a new session. Please try again.');
      setScreen('connect');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSessionsAndStart() {
    try {
      const { sessions } = await listSessions();
      if (sessions && sessions.length > 0) {
        setPastSessions(sessions);
      }
    } catch { /* ignore */ }
    await beginSession();
  }

  async function handleConnected() {
    setShowWelcome(true);
    await loadSessionsAndStart();
  }

  async function handleWelcomeDismiss({ mode: selectedMode }) {
    setMode(selectedMode || 'beginner');
    localStorage.setItem('onboarding_dismissed', '1');
    setShowWelcome(false);
    try {
      await savePreferences({ mode: selectedMode, projectType: 'fresh' });
    } catch (err) {
      console.error('Failed to save preferences:', err);
      addToast('Could not save your preference. You can update it in Settings.', 'error');
    }
  }

  const handleResume = useCallback(async (id) => {
    setSwitchingSession(true);
    try {
      await resumeSession(id);
      setSessionId(id);
      setScreen('chat');
    } catch (err) {
      console.error('Failed to resume session:', err);
      addToast('Could not resume that conversation. Try starting a new one.');
    } finally {
      setSwitchingSession(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewSession = useCallback(async () => {
    await beginSession();
    // Refresh session list
    try {
      const { sessions } = await listSessions();
      setPastSessions(sessions || []);
    } catch { /* ignore */ }
  }, [beginSession]);

  const handleReset = useCallback(() => {
    beginSession();
    // Refresh session list
    listSessions().then(({ sessions }) => setPastSessions(sessions || [])).catch(() => {});
  }, [beginSession]);

  const handleOpenDrawer = useCallback(() => {
    // Refresh sessions when drawer opens
    listSessions().then(({ sessions }) => setPastSessions(sessions || [])).catch(() => {});
    setDrawerOpen(true);
  }, []);

  const handleRename = useCallback(async (id, title) => {
    try {
      await renameSession(id, title);
      setPastSessions(prev => prev.map(s => s.sessionId === id ? { ...s, title } : s));
    } catch (err) {
      console.error('Failed to rename session:', err);
      addToast('Could not rename the conversation. Please try again.', 'error');
      throw err;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = useCallback(async (id) => {
    try {
      await deleteSession(id);
      setPastSessions(prev => prev.filter(s => s.sessionId !== id));
      // If we deleted the active session, start a fresh one
      if (id === sessionId) {
        await beginSession();
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
      addToast('Could not delete the conversation. Please try again.', 'error');
      throw err;
    }
  }, [sessionId, beginSession]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="app-container">
        {screen === 'loading' && (
          <div className="loading">
            <div className="loading-spinner" />
            <span className="loading-text">Starting up...</span>
            <span className="loading-hint">Preparing your workspace</span>
          </div>
        )}

        {screen === 'connect' && <ConnectScreen onConnected={handleConnected} />}

        {screen === 'chat' && (
          <ChatScreen
            key={sessionId}
            sessionId={sessionId}
            mode={mode}
            onReset={handleReset}
            onOpenDrawer={handleOpenDrawer}
            showTokenBar={showTokenBar}
            pastSessions={pastSessions}
            onResumeSession={handleResume}
          />
        )}

        {switchingSession && <SessionSwitchingOverlay />}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessions={pastSessions}
        onResume={handleResume}
        onNewSession={handleNewSession}
        onOpenSettings={() => setShowSettings(true)}
        onOpenAppSecrets={() => setShowAppSecrets(true)}
        currentSessionId={sessionId}
        onRename={handleRename}
        onDelete={handleDelete}
      />

      <WelcomeModal
        open={showWelcome}
        onDismiss={handleWelcomeDismiss}
      />

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={() => addToast('Settings saved. Start a new session for changes to take effect.', 'success')}
        showTokenBar={showTokenBar}
        onToggleTokenBar={(val) => {
          setShowTokenBar(val);
          localStorage.setItem('show_token_bar', val ? 'true' : 'false');
        }}
      />

      <AppSecretsModal
        open={showAppSecrets}
        onClose={() => setShowAppSecrets(false)}
      />

      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map(t => (
            <Toast key={t.id} message={t.message} type={t.type} onDismiss={() => removeToast(t.id)} />
          ))}
        </div>
      )}
    </>
  );
}
