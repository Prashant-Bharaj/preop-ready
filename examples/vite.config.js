/**
 * Example Vite config for React frontends.
 * Copy to frontend/vite.config.js when creating a React app.
 *
 * REQUIRED for static (DevOps Docs) deploy: base must use VITE_BASE_PATH
 * so assets load at https://docs.int.bayer.com/-/<repo-name>/.
 * The deploy workflow sets VITE_BASE_PATH automatically; locally it stays /.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Required for DevOps Docs static deploy (avoids blank page / 404 on assets)
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
});
