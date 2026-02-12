import { useState, useEffect, useCallback } from 'react';
import { getAuthStatus, startSession, savePreferences, listSessions, resumeSession } from './lib/api.js';
import ConnectScreen from './components/ConnectScreen.jsx';
import WelcomeModal from './components/OnboardingScreen.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import Drawer from './components/Drawer.jsx';
import ChatScreen from './components/ChatScreen.jsx';
import Toast from './components/Toast.jsx';

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [sessionId, setSessionId] = useState(null);
  const [pastSessions, setPastSessions] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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
      const { configured } = await getAuthStatus();
      if (configured) {
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

  async function handleWelcomeDismiss({ mode }) {
    try {
      await savePreferences({ mode, projectType: 'fresh' });
    } catch { /* ignore */ }
    localStorage.setItem('onboarding_dismissed', '1');
    setShowWelcome(false);
  }

  async function beginSession() {
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
  }

  async function handleResume(id) {
    try {
      await resumeSession(id);
      setSessionId(id);
      setScreen('chat');
    } catch (err) {
      console.error('Failed to resume session:', err);
      addToast('Could not resume that conversation. Try starting a new one.');
    }
  }

  const handleNewSession = useCallback(async () => {
    await beginSession();
    // Refresh session list
    try {
      const { sessions } = await listSessions();
      setPastSessions(sessions || []);
    } catch { /* ignore */ }
  }, []);

  function handleReset() {
    setSessionId(null);
    beginSession();
    // Refresh session list
    listSessions().then(({ sessions }) => setPastSessions(sessions || [])).catch(() => {});
  }

  const handleOpenDrawer = useCallback(() => {
    // Refresh sessions when drawer opens
    listSessions().then(({ sessions }) => setPastSessions(sessions || [])).catch(() => {});
    setDrawerOpen(true);
  }, []);

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
            sessionId={sessionId}
            onReset={handleReset}
            onOpenDrawer={handleOpenDrawer}
          />
        )}
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessions={pastSessions}
        onResume={handleResume}
        onNewSession={handleNewSession}
        onOpenSettings={() => { setDrawerOpen(false); setShowSettings(true); }}
        currentSessionId={sessionId}
      />

      <WelcomeModal
        open={showWelcome}
        onDismiss={handleWelcomeDismiss}
      />

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={() => addToast('Settings saved. Start a new session for changes to take effect.', 'success')}
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
