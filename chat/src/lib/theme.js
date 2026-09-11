// theme.js — light/dark theme preference + application.
//
// Preference precedence: user's saved choice (localStorage) → ?theme= query
// param (lets the platform portal deep-link projects in its own theme) →
// system prefers-color-scheme. "system" tracks OS changes live.
//
// Applied as `data-theme="light|dark"` on <html>; App.css defines the
// variable palettes.

const STORAGE_KEY = 'vibe-theme';
export const THEME_PREFS = ['system', 'dark', 'light'];

export function getThemePref() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (THEME_PREFS.includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  const fromQuery = new URLSearchParams(window.location.search).get('theme');
  if (fromQuery === 'light' || fromQuery === 'dark') return fromQuery;
  return 'system';
}

export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
}

export function setThemePref(pref) {
  if (!THEME_PREFS.includes(pref)) return;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* storage unavailable */ }
  applyTheme(pref);
}

/** Call once at boot: applies the theme and tracks OS changes while on "system". */
export function initTheme() {
  applyTheme(getThemePref());
  const mq = window.matchMedia?.('(prefers-color-scheme: light)');
  mq?.addEventListener?.('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}
