---
description: "Convert an existing JavaScript project (Express backend and/or React frontend) to the TypeScript template layout — opt-in only, with a backup branch and a verified build"
triggers: ["migrate to TypeScript", "convert to TypeScript", "move to TS", "typescript migration", "modernize the project", "use the TypeScript template"]
globs: []
---

# TypeScript Migration (JavaScript project → the v2 TypeScript layout)

Template v2 is TypeScript-canonical: new projects get Express + TS and React + Vite + TS, the
snippets are `.ts`/`.tsx`, and `backend/Dockerfile.node` builds with `tsc`. A JavaScript project
**keeps working and keeps its stack** (core rule "Existing Project → Continue in ITS Stack"). This
skill is the optional path to the new layout when the user asks for it.

⛔ Never start this as a side effect of another request. Offer it at most once per session
("your project is JavaScript; the template is TypeScript now — say *migrate to TypeScript* when
you want that, it takes one session and everything is backed up"). If the user says not now,
`touch .template-ts-migration-declined` (tracked) and stop mentioning it.

`bash scripts/detect-stack.sh` tells you what applies: `backend=node-js` → backend part,
`frontend=react-js` → frontend part. Python, Rust and already-TS layers are untouched.

## Protocol

**0. Back up.** `git checkout -b pre-typescript-backup && git push -u origin pre-typescript-backup && git checkout -`
Tell the user the branch name.

**1. Convert one layer at a time** (backend first — it has the Dockerfile change). Commit
after each layer with `chore: migrate <layer> to TypeScript`.

**2. Verify after each layer**: `docker compose up -d --build`, `/health` on 8080 and 3000,
one real request per route group (or the harness verification when `chat/` exists). Behaviour
must be identical — this migration changes types and file names, never logic. Fix before
moving on; do not weaken checks; do not silence errors with `any` or `@ts-ignore`.

**3. Finish**: `docs/PROJECT_STATUS.md` stack line updated; summary of what moved and where the
backup is.

## Backend: Express JavaScript → TypeScript (ESM)

1. `package.json`: `"type": "module"`, scripts `"build": "tsc"`, `"start": "node dist/index.js"`,
   `"typecheck": "tsc --noEmit"`; devDependencies `typescript`, `@types/node`, `@types/express`
   and `@types/*` for every other lib in use (`cors`, `pg`, `multer`, …). Add `tsconfig.json`
   from `snippets/backend/express-server-template.ts`'s header (target ES2022, module NodeNext,
   `outDir: dist`, `rootDir: src`, `strict: true`, **`allowJs: true` during the migration**).
2. Move the entry: `backend/server.js` → `backend/src/index.ts` (create `src/` if the code is flat);
   `require` → `import`, `module.exports` → `export`, add `.js` extensions on relative imports
   (NodeNext). Type the request handlers (`Request`, `Response`, `NextFunction`) and the DB rows
   (`interface` per table). Keep every route path, status code and JSON shape exactly as it is
   (`/api`-prefix rule unchanged: routes are defined WITHOUT `/api`).
3. Rename the remaining `.js` files to `.ts` one folder at a time; run `npm run typecheck` after
   each folder; when everything compiles, set `allowJs: false`.
4. `cp backend/Dockerfile.node backend/Dockerfile` (multi-stage, runs `tsc`, ships `dist/`,
   non-root, healthcheck). Migrations stay in `backend/migrations/`; the runner from
   `snippets/config/db-migrations` is the TS one.
5. `backend/.dockerignore` must exclude `dist/` and `node_modules/` (the template copy does).

## Frontend: React JavaScript → TypeScript

1. `frontend/package.json`: devDependencies `typescript`, `@types/react`, `@types/react-dom`;
   `vite.config.js` → `vite.config.ts` (`snippets/frontend/vite-react-config.ts`); add
   `tsconfig.json` (`jsx: react-jsx`, `strict: true`, **`allowJs: true` during the migration**)
   and `tsconfig.node.json` for the Vite config.
2. Rename `src/main.jsx` → `main.tsx`, then components `.jsx` → `.tsx` one folder at a time;
   type props with `interface`, state with generics (`useState<Item[]>([])`), API responses
   with the same row interfaces the backend uses (copy them; do not import across the
   containers). `fetch('/api/…')` calls stay relative.
3. When everything compiles, `allowJs: false`. `frontend/Dockerfile.react` needs no change
   (Vite builds to `dist/`, nginx serves it).

## What NOT to do

- No rewrite of logic, no "while we're here" refactors, no new libraries.
- No conversion of a Python or Rust backend — they are first-class as they are.
- No `any` to make errors disappear: type it, or leave that file `.js` under `allowJs` and
  say so in the summary.
