import { useState, useEffect } from 'react';
import { getAuthStatus, startSession } from './lib/api.js';
import ConnectScreen from './components/ConnectScreen.jsx';
import ChatScreen from './components/ChatScreen.jsx';

export default function App() {
  const [screen, setScreen] = useState('loading');
  const [sessionId, setSessionId] = useState(null);

  useEffect(() => { checkAuth(); }, []);

  async function checkAuth() {
    try {
      const { configured } = await getAuthStatus();
      if (configured) {
        await beginSession();
      } else {
        setScreen('connect');
      }
    } catch {
      setScreen('connect');
    }
  }

  async function beginSession() {
    try {
      const { sessionId: id } = await startSession();
      setSessionId(id);
      setScreen('chat');
    } catch (err) {
      console.error('Failed to start session:', err);
      setScreen('connect');
    }
  }

  if (screen === 'loading') {
    return <div className="app-container"><div className="loading">Starting up...</div></div>;
  }

  if (screen === 'connect') {
    return <div className="app-container"><ConnectScreen onConnected={beginSession} /></div>;
  }

  return (
    <div className="app-container">
      <ChatScreen sessionId={sessionId} onReset={() => { setSessionId(null); beginSession(); }} />
    </div>
  );
}
