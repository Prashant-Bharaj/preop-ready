/**
 * oidc-identity-generator.js — emits the locked OIDC identity parser as
 * `backend/src/lib/oidc-identity.ts` (Node) or `backend/src/oidc_identity.py`
 * (Python).
 *
 * Identity-parsing SEMANTICS are fully known platform behavior, yet agents
 * kept re-implementing them with drift — observed live: `devMode` computed
 * as "no OIDC header" (so the persona switcher's own synthetic token hid
 * the switcher), and the token's `role` claim ignored at first login (new
 * personas created with the default role). Pre-staging kills the class.
 *
 * Trust model (reference/user-identity.md): the ALB overwrites all
 * x-amzn-oidc-* headers in production, so `dev: true` can only ever be
 * seen locally — `devMode` derives from the claim (or a fully absent
 * header), never from environment guesses.
 */

export function shouldEmitOidcIdentity(contract) {
  return (contract?.tasks || []).some((t) => t?.scope === 'backend');
}

function backendIsPython(contract) {
  const backendTask = (contract?.tasks || []).find(t => t?.scope === 'backend');
  return backendTask?.dockerfile === 'Dockerfile.python';
}

export function generateOidcIdentity(contract) {
  if (!shouldEmitOidcIdentity(contract)) return null;
  return backendIsPython(contract)
    ? { relPath: 'backend/src/oidc_identity.py', source: pythonSource() }
    : { relPath: 'backend/src/lib/oidc-identity.ts', source: tsSource() };
}

function tsSource() {
  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT OR REWRITE — pre-staged OIDC identity parser.`);
  lines.push(`// Use parseOidcIdentity(req) as the ONLY reader of x-amzn-oidc-data.`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Semantics (reference/user-identity.md):`);
  lines.push(` * - present: an x-amzn-oidc-data header was supplied (ALB in production,`);
  lines.push(` *   synthetic persona token in local dev).`);
  lines.push(` * - devMode: the token carries \`dev: true\` (synthetic personas only —`);
  lines.push(` *   the ALB overwrites these headers in production) OR no header at all`);
  lines.push(` *   (bare local dev before a persona is chosen).`);
  lines.push(` * - roleClaim: the token's \`role\` claim. On user first-login, use it`);
  lines.push(` *   when non-null; otherwise the app's default (least-privileged) role.`);
  lines.push(` */`);
  lines.push(`import type { Request } from 'express';`);
  lines.push('');
  lines.push(`export interface OidcIdentity {`);
  lines.push(`  present: boolean;`);
  lines.push(`  devMode: boolean;`);
  lines.push(`  sub: string | null;`);
  lines.push(`  email: string | null;`);
  lines.push(`  name: string | null;`);
  lines.push(`  roleClaim: string | null;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export function parseOidcIdentity(req: Request): OidcIdentity {`);
  lines.push(`  const header = req.headers['x-amzn-oidc-data'];`);
  lines.push(`  if (typeof header !== 'string' || header.length === 0) {`);
  lines.push(`    return { present: false, devMode: true, sub: null, email: null, name: null, roleClaim: null };`);
  lines.push(`  }`);
  lines.push(`  try {`);
  lines.push(`    const parts = header.split('.');`);
  lines.push(`    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));`);
  lines.push(`    return {`);
  lines.push(`      present: true,`);
  lines.push(`      devMode: payload.dev === true,`);
  lines.push(`      sub: typeof payload.sub === 'string' ? payload.sub : null,`);
  lines.push(`      email: typeof payload.email === 'string' ? payload.email : null,`);
  lines.push(`      name: typeof payload.name === 'string' ? payload.name : null,`);
  lines.push(`      roleClaim: typeof payload.role === 'string' ? payload.role : null,`);
  lines.push(`    };`);
  lines.push(`  } catch {`);
  lines.push(`    return { present: true, devMode: false, sub: null, email: null, name: null, roleClaim: null };`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');
  return lines.join('\n');
}

function pythonSource() {
  const lines = [];
  lines.push(`# AUTO-GENERATED — DO NOT EDIT OR REWRITE — pre-staged OIDC identity parser.`);
  lines.push(`# Use parse_oidc_identity(request) as the ONLY reader of x-amzn-oidc-data.`);
  lines.push(`"""Semantics (reference/user-identity.md):`);
  lines.push('');
  lines.push(`- present: an x-amzn-oidc-data header was supplied.`);
  lines.push(`- dev_mode: the token carries dev=true (synthetic personas only — the ALB`);
  lines.push(`  overwrites these headers in production) OR no header at all.`);
  lines.push(`- role_claim: the token's role claim. On user first-login, use it when`);
  lines.push(`  non-null; otherwise the app's default (least-privileged) role.`);
  lines.push(`"""`);
  lines.push('');
  lines.push(`import base64`);
  lines.push(`import json`);
  lines.push(`from typing import Optional, TypedDict`);
  lines.push('');
  lines.push('');
  lines.push(`class OidcIdentity(TypedDict):`);
  lines.push(`    present: bool`);
  lines.push(`    dev_mode: bool`);
  lines.push(`    sub: Optional[str]`);
  lines.push(`    email: Optional[str]`);
  lines.push(`    name: Optional[str]`);
  lines.push(`    role_claim: Optional[str]`);
  lines.push('');
  lines.push('');
  lines.push(`def parse_oidc_identity(request) -> OidcIdentity:`);
  lines.push(`    header = request.headers.get("x-amzn-oidc-data")`);
  lines.push(`    if not header:`);
  lines.push(`        return {"present": False, "dev_mode": True, "sub": None, "email": None, "name": None, "role_claim": None}`);
  lines.push(`    try:`);
  lines.push(`        payload_part = header.split(".")[1]`);
  lines.push(`        padded = payload_part + "=" * (-len(payload_part) % 4)`);
  lines.push(`        payload = json.loads(base64.urlsafe_b64decode(padded))`);
  lines.push(`        return {`);
  lines.push(`            "present": True,`);
  lines.push(`            "dev_mode": payload.get("dev") is True,`);
  lines.push(`            "sub": payload.get("sub"),`);
  lines.push(`            "email": payload.get("email"),`);
  lines.push(`            "name": payload.get("name"),`);
  lines.push(`            "role_claim": payload.get("role"),`);
  lines.push(`        }`);
  lines.push(`    except Exception:`);
  lines.push(`        return {"present": True, "dev_mode": False, "sub": None, "email": None, "name": None, "role_claim": None}`);
  lines.push('');
  return lines.join('\n');
}
