import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In Codespaces the app is accessed via the port-forward tunnel at
// https://${CODESPACE_NAME}-8889.app.github.dev, not localhost:8889. Vite's
// default HMR tries to open a WebSocket back to the local port and fails —
// we need to point it at the public tunnel on :443.
const codespaceName = process.env.CODESPACE_NAME;
const codespaceDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';

const hmrConfig = codespaceName
  ? {
      host: `${codespaceName}-8889.${codespaceDomain}`,
      protocol: 'wss',
      clientPort: 443,
    }
  : true; // default HMR on localhost

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8889,
    host: true, // needed so Codespaces can bind and forward
    hmr: hmrConfig,
    proxy: {
      '/api': {
        target: 'http://localhost:5050',
        changeOrigin: true,
        ws: true,
      },
      '/docs': {
        target: 'http://localhost:5050',
        changeOrigin: true,
      },
      // Socket.IO uses its own path ('/socket.io/...' by default). Without
      // this proxy entry the browser tries ws://localhost:8889/socket.io/...
      // and hits Vite instead of the Express server on :5050 — handshake
      // fails, the client spins on reconnect, and the UI sticks on
      // "Setting up your session…".
      '/socket.io': {
        target: 'http://localhost:5050',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
