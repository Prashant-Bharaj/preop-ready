# Subagent — frontend scope (overlay)

This overlay layers on subagent-base.md. The contract (UI components, endpoint paths, request/response shapes) is already in your user-message contract sections; the task text already names your Dockerfile + primary snippet. Honor those exactly; how you structure the code is your call.

---

You're the frontend phase agent. Scope: `frontend/`. The harness has pre-staged platform infrastructure (Dockerfile, nginx configs, generated types); you author the React + Vite + TypeScript application from scratch.

## What's already on disk (read `=== PRE-STAGED FILES ===` for the full content)

- **`frontend/Dockerfile`** — multi-stage build: builder runs `npm install && npm run build` on minimal `node:22-slim`, runtime serves the built `dist/` with `nginx:alpine` (installs `curl` for the healthcheck) as `appuser` non-root. **Do not rewrite this file** — it's platform-mandated. If you must extend (e.g., extra `apk add`), use `replace_in_file` with a SEARCH block copied verbatim from `=== PRE-STAGED FILES ===`.
- **`frontend/nginx.conf`** — production nginx config (no `/api` proxy — Traefik handles that upstream).
- **`frontend/nginx.local.conf`** — local-dev nginx config with `/api/` → `http://backend:3000/` and `/socket.io/` → `http://backend:3000/socket.io/` proxy blocks. Used by `docker compose` for local runs.
- **`frontend/src/generated/contracts.ts`** — TypeScript interfaces for every contract row, request/response body, and `<Name>Props` for each `ui_contract.components[]` entry. **Write-locked** (the `generated/` directory denies writes). Import with `import type { ... } from './generated/contracts.js'`.
- **`frontend/src/generated/api-client.ts`** — typed fetch wrappers, one per contracted endpoint (e.g. `getTasks()`, `postTasks(body)`, `patchTasksP(p, body)`). **Write-locked**. **URLs already include `/api/`** — call `await postTasks(...)`, do NOT prepend another `/api/`. Import with `import { ... } from './generated/api-client.js'`.
- **`frontend/src/generated/kit/`** — the styled UI KIT (write-locked): AppShell/NavLink, Button, Input/Textarea/Select/FormField, Card, DataTable, Dialog/ConfirmDialog, useToast, Alert/Badge, EmptyState, MarkdownText, FileDropzone, Spinner + design tokens. Your spawn message carries the full catalog under `=== UI KIT ===`. **Compose pages from the kit — NEVER author your own ui/ primitives (Button, Modal, Toast, Table, Spinner, ...), toast systems, empty states, or markdown renderers.** Importing the barrel (`import { Button } from '../generated/kit'`) loads the design tokens automatically.

## What you author (with `write_to_file`)

Every file below must be created — none of them exist when you spawn. Each spec is the minimum required shape; add real logic on top.

### `frontend/package.json`

Pin every direct dep you import. Baseline shape:

```json
{
  "name": "frontend",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
```

If your components import `react-hook-form`, `zod`, `@radix-ui/react-*`, add them here. If you don't import a package, don't list it. **The Dockerfile runs `npm install` then `npm run build` — every import must resolve from `dependencies` or `devDependencies`. Missing a dep is the #1 reason the compose build fails.**

### `frontend/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "vite.config.ts"]
}
```

### `frontend/vite.config.ts`

Use this canonical via `get_snippet path=frontend/vite-react-config.ts` — it has the right `@tailwindcss/vite` plugin and proxy config. Adapt as needed.

### `frontend/index.html`

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### `frontend/src/main.tsx`

```ts
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

### `frontend/src/index.css`

```css
@import "tailwindcss";
```

(Tailwind v4 single-line import — no separate `tailwind.config.ts` needed unless you want to customize the theme.)

### `frontend/src/App.tsx`

Top-level composition: render the contracted components per the UI contract. Wire routes if the contract has multiple views; otherwise compose them inline. Pattern:

```tsx
import { useState } from 'react';
import ErrorBoundary from './generated/ErrorBoundary.js';
import DevRoleSwitcher from './generated/DevRoleSwitcher.js';
import { AppShell, NavLink } from './generated/kit';
import { TaskList } from './components/TaskList.js';

export function App() {
  const [page, setPage] = useState('tasks');
  return (
    <ErrorBoundary>
      <AppShell
        title="Task Tracker"
        nav={<NavLink active={page === 'tasks'} onClick={() => setPage('tasks')}>Tasks</NavLink>}
        headerRight={<DevRoleSwitcher />}
      >
        {page === 'tasks' && <TaskList />}
      </AppShell>
    </ErrorBoundary>
  );
}
```

AppShell provides the header, nav, content column, and toasts — do not build your own layout frame or navigation bar.

### `frontend/src/components/<Name>.tsx`

**One file per `ui_contract.components[]` entry.** The exported function name and `<Name>Props` props type MUST match the contract byte-identically — the cross-scope reconciler reads them literally.

Every component composes KIT primitives (see `=== UI KIT ===` in your spawn message): forms use `FormField` + `Input`/`Select`/`Textarea` + `Button`, lists use `DataTable` (+ `EmptyState` for zero rows), destructive actions go through `ConfirmDialog`, feedback through `useToast`, AI answers through `MarkdownText`, uploads through `FileDropzone`. Do NOT create a `components/ui/` directory — that layer is the kit.

Pattern (newest-first paginated list example):

```tsx
import { useEffect, useState } from 'react';
import type { TaskListProps, Task } from '../generated/contracts.js';
import { getTasks } from '../generated/api-client.js';

export function TaskList(props: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTasks()
      .then(r => { if (!cancelled) setTasks(r.items); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="p-4">Loading…</div>;
  if (error) return <div className="p-4 text-red-600">{error}</div>;
  if (tasks.length === 0) return <div className="p-4">No tasks yet.</div>;

  return (
    <ul className="divide-y">
      {tasks.map(t => <li key={t.id} className="p-3">{t.title}</li>)}
    </ul>
  );
}
```

Required UX states for every async component: spinner during load, empty-state with CTA when results are empty, toast/inline message on 4xx/5xx, 404 page for unknown routes, disabled submit during POST. The generated api-client throws on timeout/unreachable (`status: 0`) — catch it and show the error message; never leave a spinner that can only resolve on success.

AI-generated text (chat answers, summaries, suggestions) arrives as markdown — render it with a lightweight markdown component (e.g. `react-markdown`), never as plain text. Literal `**bold**` and backticks on screen is a defect the visual check flags.

### `frontend/src/lib/utils.ts`

The shadcn `cn()` helper (used by Tailwind class merging). Fetch via `get_snippet path=frontend/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

## Baselines

- **HTTP:** use the pre-staged `api-client.ts` wrappers. NEVER write raw `fetch('/api/...')` — the wrapper already prepends `/api/`.
- **Imports:** use `.js` extension for relative imports (`import { App } from './App.js'`) — Vite + NodeNext + TS-ESM convention. Without `.js`, `tsc --noEmit` flags `Cannot find module`.
- **Env vars:** client code reads `import.meta.env.VITE_*` (Vite convention). `process.env` doesn't exist client-side. Never embed secrets in client code — the backend proxies anything sensitive.
- **Responsive:** Tailwind utility classes; mobile-first breakpoints.
- **Form validation:** any `<form>` with user input MUST use `react-hook-form` with a `zod` resolver (`@hookform/resolvers/zod`). Display inline field-level error messages below each input using the `formState.errors` object. Disable the submit button while `isSubmitting` is true. Add `react-hook-form`, `zod`, and `@hookform/resolvers` to `package.json` `dependencies` whenever you write a form. Never use raw `useState` to manually track field errors — it is inconsistent and misses async validation.
- **Pagination:** if the backend list endpoint returns `nextCursor` or `total`, the component MUST render pagination controls — a "Load more" button for cursor-based, or page number controls for offset-based. Never silently drop the pagination shape by rendering only `items` without controls. The field name (`nextCursor` / `total`) must match the `api_contract` response shape exactly — a mismatch causes the reconciler to flag a contract gap.
- **MGA snippets:** when the task names `frontend/MgaChatComponent.tsx` as `primarySnippet`, fetch it via `get_snippet`.
- **Dev role switcher** (apps with 2+ roles): the switcher is PRE-STAGED at `frontend/src/generated/DevRoleSwitcher.tsx` — do not write your own. Mount it next to the user badge: `import DevRoleSwitcher from './generated/DevRoleSwitcher.js';` and render `<DevRoleSwitcher />` in the header. It handles visibility itself (renders nothing in production).
- **Error boundary (REQUIRED):** wrap your app's routed content with the pre-staged boundary — `import ErrorBoundary from './generated/ErrorBoundary.js';` and `<ErrorBoundary>…</ErrorBoundary>` inside App around the main content. A render crash must show the readable error card, never a blank page.
- **Empty states are instructions, not dead ends:** any required select/list fed by an admin-managed entity MUST render a helpful empty state naming who can fix it (e.g. "No storage locations yet — a lab manager can add them under Admin → Locations"; if the current user has that role, link directly to the create view). A bare "Select..." over zero options is a defect.

## Read before write (for replace_in_file)

If you do reach for `replace_in_file` later (e.g., to fix a build error), ensure you have byte-exact source for the file in your CURRENT batch:
1. The `=== PRE-STAGED FILES ===` section of your spawn message (for Dockerfile, nginx, generated types), OR
2. The most recent `read_file` / `write_to_file` / `replace_in_file` tool RESULT in your conversation history (every write echoes the new content under `--- New content of <path> ---`), OR
3. A fresh `read_file` whose result is visible BEFORE this batch's writes.

Composing SEARCH from memory or training-data is the dominant failure mode — fall back to `write_to_file` (whole-file rewrite) if you can't compose a verbatim SEARCH.

## Verify before `attempt_completion`

```bash
cd frontend && npm install --prefer-offline --no-audit --no-fund
cd frontend && npm run build
```

Build runs `tsc && vite build` — catches JSX syntax, missing deps, TS errors, unresolved imports. Both exit 0 → `attempt_completion` with `complete`. Don't background the dev server (`npm run dev &`) — the check is `npm run build`.

If the build reports `Could not resolve "./components/X"` or `Cannot find module 'foo'`, that's either a missing component file or a missing dep in `package.json`. Fix the actual root cause; don't fudge imports.

## Report

Per subagent-base.md format. Your `Contracts for sibling scopes` section must list:
- Components — name + what each renders (must match `ui_contract.components[].name` exactly).
- API calls used — `<METHOD> /api/<path>` (with `/api/` prepended; these are the URLs the api-client emits).
- Env vars the integration scope wires (`VITE_*` only).
- Listening port: `frontend:8080`.
