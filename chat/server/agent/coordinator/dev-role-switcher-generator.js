/**
 * dev-role-switcher-generator.js — emits the pre-staged local-dev persona
 * switcher as `frontend/src/generated/DevRoleSwitcher.tsx`.
 *
 * Design (reference/user-identity.md): local dev uses the SAME
 * x-amzn-oidc-data header as production, with a synthetic unsigned token
 * built by `devPersonaHeaders()` in the generated api-client. Production
 * safety comes from infrastructure — the ALB overwrites x-amzn-oidc-*
 * headers — so this component needs no env gates: it renders only when
 * /whoami echoes devMode (the `dev: true` claim survives only locally).
 *
 * Why generated instead of prompt-mandated: frontend agents empirically
 * skip "build a switcher" prompt rules, and DB-row role edits don't survive
 * rebuilds. The subagent only has to MOUNT this (one import + one JSX tag).
 */

export function generateDevRoleSwitcher(apiContract) {
  const endpoints = Array.isArray(apiContract?.endpoints) ? apiContract.endpoints : [];
  if (endpoints.length === 0) return null;

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — local-dev persona switcher.`);
  lines.push(`// Renders nothing in production (the ALB strips synthetic tokens, so`);
  lines.push(`// whoami.devMode is false) and in single-role apps.`);
  lines.push(`// Mount next to the user badge:`);
  lines.push(`//   import DevRoleSwitcher from './generated/DevRoleSwitcher.js';`);
  lines.push('');
  lines.push(`import { useEffect, useState } from 'react';`);
  lines.push(`import { devPersonaHeaders } from './api-client.js';`);
  lines.push('');
  lines.push(`interface WhoamiShape {`);
  lines.push(`  role?: string;`);
  lines.push(`  devMode?: boolean;`);
  lines.push(`  availableRoles?: string[];`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export default function DevRoleSwitcher() {`);
  lines.push(`  const [whoami, setWhoami] = useState<WhoamiShape | null>(null);`);
  lines.push('');
  lines.push(`  useEffect(() => {`);
  lines.push(`    fetch('/api/whoami', { headers: devPersonaHeaders() })`);
  lines.push(`      .then((r) => (r.ok ? r.json() : null))`);
  lines.push(`      .then((w) => {`);
  lines.push(`        // Cache the role list while the backend reports devMode — if a`);
  lines.push(`        // later response mis-computes devMode (semantic drift), the`);
  lines.push(`        // switcher survives from cache. The cache is only ever written`);
  lines.push(`        // when devMode was true, which production can never report.`);
  lines.push(`        if (w?.devMode && Array.isArray(w.availableRoles) && w.availableRoles.length >= 2) {`);
  lines.push(`          localStorage.setItem('dev-roles', JSON.stringify(w.availableRoles));`);
  lines.push(`        }`);
  lines.push(`        setWhoami(w);`);
  lines.push(`      })`);
  lines.push(`      .catch(() => setWhoami(null));`);
  lines.push(`  }, []);`);
  lines.push('');
  lines.push(`  let cachedRoles: string[] = [];`);
  lines.push(`  try { cachedRoles = JSON.parse(localStorage.getItem('dev-roles') || '[]'); } catch { cachedRoles = []; }`);
  lines.push(`  const personaActive = !!localStorage.getItem('dev-role');`);
  lines.push(`  const roles = (whoami?.devMode && Array.isArray(whoami.availableRoles) && whoami.availableRoles.length >= 2)`);
  lines.push(`    ? whoami.availableRoles`);
  lines.push(`    : ((personaActive || whoami?.devMode) ? cachedRoles : []);`);
  lines.push(`  if (!whoami || roles.length < 2) {`);
  lines.push(`    return null;`);
  lines.push(`  }`);
  lines.push(`  const current = (typeof localStorage !== 'undefined' && localStorage.getItem('dev-role')) || whoami.role || roles[0];`);
  lines.push('');
  lines.push(`  return (`);
  lines.push(`    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 }}>`);
  lines.push(`      dev role`);
  lines.push(`      <select`);
  lines.push(`        value={current}`);
  lines.push(`        onChange={(e) => {`);
  lines.push(`          localStorage.setItem('dev-role', e.target.value);`);
  lines.push(`          window.location.reload();`);
  lines.push(`        }}`);
  lines.push(`      >`);
  lines.push(`        {roles.map((r) => (`);
  lines.push(`          <option key={r} value={r}>{r}</option>`);
  lines.push(`        ))}`);
  lines.push(`      </select>`);
  lines.push(`    </label>`);
  lines.push(`  );`);
  lines.push(`}`);
  lines.push('');
  return { source: lines.join('\n') };
}
