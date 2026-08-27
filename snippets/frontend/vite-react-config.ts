/**
 * scopes: [frontend]
 * flags: []
 * description: Vite + React + TypeScript + Tailwind v4 config. Pair with package.json (commented below).
 *
 * SETUP STEPS
 * -----------
 * 1. Create `frontend/package.json` with the deps listed below.
 * 2. Create `frontend/index.html` with `<div id="root"></div>` and
 *      <script type="module" src="/src/main.tsx"></script>.
 * 3. Create `frontend/src/main.tsx` (entry point — see commented block below).
 * 4. Create `frontend/src/index.css` with a single line:  @import "tailwindcss";
 * 5. Drop this file at `frontend/vite.config.ts`.
 * 6. Drop the shadcn `cn()` helper at `frontend/src/lib/utils.ts`
 *    (snippets/frontend/lib/utils.ts).
 * 7. Drop shadcn components at `frontend/src/components/`
 *    (snippets/frontend/components/*.tsx).
 *
 * Dockerfile.react already runs `npm install` and `npm run build` in the
 * builder stage, then nginx serves `dist/`.
 *
 * RECOMMENDED frontend/package.json (commented — copy/adjust):
 *
 * {
 *   "name": "frontend",
 *   "private": true,
 *   "version": "0.0.1",
 *   "type": "module",
 *   "scripts": {
 *     "dev": "vite",
 *     "build": "vite build",
 *     "preview": "vite preview",
 *     "typecheck": "tsc --noEmit"
 *   },
 *   "dependencies": {
 *     "react": "^19.0.0",
 *     "react-dom": "^19.0.0",
 *     "react-hook-form": "^7.x",
 *     "zod": "^3.x",
 *     "clsx": "^2.x",
 *     "tailwind-merge": "^2.x",
 *     "@radix-ui/react-avatar": "^1.x",
 *     "@radix-ui/react-dialog": "^1.x",
 *     "@radix-ui/react-dropdown-menu": "^2.x",
 *     "@radix-ui/react-label": "^2.x",
 *     "@radix-ui/react-select": "^2.x",
 *     "@radix-ui/react-separator": "^1.x",
 *     "@radix-ui/react-slot": "^1.x",
 *     "@radix-ui/react-tabs": "^1.x",
 *     "@radix-ui/react-toast": "^1.x"
 *   },
 *   "devDependencies": {
 *     "typescript": "^5.x",
 *     "@types/react": "^19.x",
 *     "@types/react-dom": "^19.x",
 *     "vite": "^6.x",
 *     "@vitejs/plugin-react": "^5.x",
 *     "tailwindcss": "^4.x",
 *     "@tailwindcss/vite": "^4.x"
 *   }
 * }
 *
 * RECOMMENDED frontend/tsconfig.json (commented — copy/adjust):
 *
 * {
 *   "compilerOptions": {
 *     "target": "ES2022",
 *     "lib": ["ES2022", "DOM", "DOM.Iterable"],
 *     "jsx": "react-jsx",
 *     "module": "ESNext",
 *     "moduleResolution": "Bundler",
 *     "strict": true,
 *     "noEmit": true,
 *     "esModuleInterop": true,
 *     "isolatedModules": true,
 *     "skipLibCheck": true,
 *     "resolveJsonModule": true,
 *     "allowImportingTsExtensions": false,
 *     "verbatimModuleSyntax": false
 *   },
 *   "include": ["src", "vite.config.ts", "tailwind.config.ts"]
 * }
 *
 * RECOMMENDED frontend/src/main.tsx (commented — copy/adjust):
 *
 * import { StrictMode } from 'react';
 * import { createRoot } from 'react-dom/client';
 * import './index.css';
 * import { AppScaffold } from './AppScaffold.js';
 *
 * createRoot(document.getElementById('root')!).render(
 *   <StrictMode>
 *     <AppScaffold />
 *   </StrictMode>
 * );
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Frontend calls /api/foo -> backend /foo (matches nginx/Traefik routing).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // WebSocket support for Socket.IO.
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
