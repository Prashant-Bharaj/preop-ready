/**
 * scopes: [frontend]
 * flags: []
 * description: App.tsx + main.tsx + index.html scaffold (TypeScript) with React Router and Tailwind.
 */

/**
 * React App Scaffold — App.tsx + main.tsx + index.html (TypeScript + Tailwind)
 *
 * Generic React + Vite app structure with React Router and Tailwind utility
 * classes. No separate App.css — styling is inline via className.
 *
 * Files to create from this scaffold:
 *   frontend/src/App.tsx     — copy the App component below
 *   frontend/src/main.tsx    — copy the entry point below
 *   frontend/src/index.css   — single line:  @import "tailwindcss";
 *   frontend/index.html      — copy the HTML template below
 */

// === frontend/src/App.tsx ===

import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { SearchPage } from './pages/SearchPage.js';
import { AdminPage } from './pages/AdminPage.js';

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <nav className="flex gap-4 border-b border-slate-200 bg-white px-6 py-3">
        <Link to="/" className="font-medium text-slate-700 hover:text-slate-900">
          Search
        </Link>
        <Link
          to="/admin"
          className="font-medium text-slate-700 hover:text-slate-900"
        >
          Admin
        </Link>
      </nav>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

export default App;

// === frontend/src/main.tsx ===
//
// import { StrictMode } from 'react';
// import { createRoot } from 'react-dom/client';
// import { App } from './App.js';
// import './index.css';
//
// const rootEl = document.getElementById('root');
// if (!rootEl) throw new Error('Missing #root element in index.html');
// createRoot(rootEl).render(
//   <StrictMode>
//     <App />
//   </StrictMode>
// );

// === frontend/src/index.css ===
//
// @import "tailwindcss";

// === frontend/index.html ===
//
// <!DOCTYPE html>
// <html lang="en">
//   <head>
//     <meta charset="UTF-8" />
//     <meta name="viewport" content="width=device-width, initial-scale=1.0" />
//     <title>App</title>
//   </head>
//   <body>
//     <div id="root"></div>
//     <script type="module" src="/src/main.tsx"></script>
//   </body>
// </html>

import type * as React from 'react';
