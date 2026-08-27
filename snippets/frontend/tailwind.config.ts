/**
 * scopes: [frontend]
 * flags: []
 * description: Tailwind CSS v4 config (TypeScript) — pairs with @tailwindcss/vite. Optional escape hatch for theme extensions.
 */

/**
 * Tailwind v4 config (TypeScript).
 *
 * Tailwind v4 prefers CSS-based config via `@import 'tailwindcss'` + `@theme`
 * in your main stylesheet. This TS config file is the optional escape hatch
 * for theme extensions, content globs, and plugins — keep it minimal.
 *
 * The @tailwindcss/vite plugin (see vite-react-config.ts) picks this up
 * automatically if present.
 *
 * Place this file at frontend/tailwind.config.ts.
 */

import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
