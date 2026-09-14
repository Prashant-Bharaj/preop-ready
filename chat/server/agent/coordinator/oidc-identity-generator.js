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
  lines.push(`// Use \`await parseOidcIdentity(req)\` as the ONLY reader of x-amzn-oidc-data.`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Semantics (reference/user-identity.md):`);
  lines.push(` * - present: an x-amzn-oidc-data header was supplied (ALB in production,`);
  lines.push(` *   synthetic persona token in local dev).`);
  lines.push(` * - verified: the token's ES256 signature was checked against the ALB's`);
  lines.push(` *   regional public key, it is unexpired, and its \`signer\` / \`iss\` match`);
  lines.push(` *   the platform pins (PLATFORM_ALB_ARN, ALB_EXPECTED_ISSUER). Verification`);
  lines.push(` *   runs wherever AWS_REGION is set (every deployed task); a present but`);
  lines.push(` *   invalid token yields no identity — never fall back to the claims.`);
  lines.push(` * - devMode: the token carries \`dev: true\` (synthetic personas only —`);
  lines.push(` *   the ALB overwrites these headers in production) OR no header at all`);
  lines.push(` *   (bare local dev before a persona is chosen). Never true once verified.`);
  lines.push(` * - roleClaim: the token's \`role\` claim. On user first-login, use it`);
  lines.push(` *   when non-null; otherwise the app's default (least-privileged) role.`);
  lines.push(` */`);
  lines.push(`import type { Request } from 'express';`);
  lines.push(`import { createPublicKey, verify as cryptoVerify } from 'node:crypto';`);
  lines.push('');
  lines.push(`export interface OidcIdentity {`);
  lines.push(`  present: boolean;`);
  lines.push(`  verified: boolean;`);
  lines.push(`  devMode: boolean;`);
  lines.push(`  sub: string | null;`);
  lines.push(`  email: string | null;`);
  lines.push(`  name: string | null;`);
  lines.push(`  roleClaim: string | null;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`// Platform-injected pins (empty = not pinned) and the region whose ALB key`);
  lines.push(`// endpoint serves the signing keys. Deployed tasks always have AWS_REGION;`);
  lines.push(`// locally there is no ALB, so tokens are unsigned synthetic personas.`);
  lines.push(`const EXPECTED_SIGNER = process.env.PLATFORM_ALB_ARN || '';`);
  lines.push(`const EXPECTED_ISSUER = process.env.ALB_EXPECTED_ISSUER || '';`);
  lines.push(`const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';`);
  lines.push(`const VERIFY_TOKENS = REGION.length > 0;`);
  lines.push(`if (VERIFY_TOKENS && !EXPECTED_SIGNER) {`);
  lines.push(`  console.warn('OIDC verify: PLATFORM_ALB_ARN not set — accepting tokens signed by any load balancer in the region');`);
  lines.push(`}`);
  lines.push('');
  lines.push(`const albKeyCache = new Map<string, string>();`);
  lines.push('');
  lines.push(`async function getAlbPublicKeyPem(kid: string): Promise<string> {`);
  lines.push(`  const cached = albKeyCache.get(kid);`);
  lines.push(`  if (cached) return cached;`);
  lines.push(`  // Endpoint per AWS docs: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`);
  lines.push(`  const url = \`https://public-keys.auth.elb.\${REGION}.amazonaws.com/\${encodeURIComponent(kid)}\`;`);
  lines.push(`  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });`);
  lines.push(`  if (!res.ok) throw new Error(\`ALB key fetch failed: \${res.status}\`);`);
  lines.push(`  const pem = await res.text();`);
  lines.push(`  albKeyCache.set(kid, pem);`);
  lines.push(`  return pem;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`type JwtHeader = { kid?: string; alg?: string; signer?: string; iss?: string };`);
  lines.push('');
  lines.push(`// ES256 signature against the regional ALB key, expiry, and the platform pins.`);
  lines.push(`// The pins live in the JWT HEADER (signer, iss), not the payload.`);
  lines.push(`async function verifyOidcToken(parts: string[], header: JwtHeader, payload: Record<string, unknown>): Promise<boolean> {`);
  lines.push(`  try {`);
  lines.push(`    if (parts.length !== 3 || !header.kid) return false;`);
  lines.push(`    if (header.alg !== 'ES256') return false;`);
  lines.push(`    const key = createPublicKey(await getAlbPublicKeyPem(header.kid));`);
  lines.push(`    const signingInput = Buffer.from(\`\${parts[0]}.\${parts[1]}\`);`);
  lines.push(`    const signature = Buffer.from(parts[2], 'base64url');`);
  lines.push(`    if (!cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature)) return false;`);
  lines.push(`    const exp = typeof payload.exp === 'number' ? payload.exp : 0;`);
  lines.push(`    if (!exp || exp * 1000 < Date.now()) return false;`);
  lines.push(`    if (EXPECTED_SIGNER && header.signer !== EXPECTED_SIGNER) {`);
  lines.push(`      console.error('OIDC verify: signer is not the platform load balancer');`);
  lines.push(`      return false;`);
  lines.push(`    }`);
  lines.push(`    if (EXPECTED_ISSUER && header.iss !== EXPECTED_ISSUER) {`);
  lines.push(`      console.error('OIDC verify: issuer is not the platform identity provider');`);
  lines.push(`      return false;`);
  lines.push(`    }`);
  lines.push(`    return true;`);
  lines.push(`  } catch (error) {`);
  lines.push(`    console.error('OIDC verify failed:', error instanceof Error ? error.message : String(error));`);
  lines.push(`    return false;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');
  lines.push(`const NO_IDENTITY = { sub: null, email: null, name: null, roleClaim: null };`);
  lines.push('');
  lines.push(`export async function parseOidcIdentity(req: Request): Promise<OidcIdentity> {`);
  lines.push(`  const header = req.headers['x-amzn-oidc-data'];`);
  lines.push(`  if (typeof header !== 'string' || header.length === 0) {`);
  lines.push(`    return { present: false, verified: false, devMode: true, ...NO_IDENTITY };`);
  lines.push(`  }`);
  lines.push(`  try {`);
  lines.push(`    const parts = header.split('.');`);
  lines.push(`    const jwtHeader = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8')) as JwtHeader;`);
  lines.push(`    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;`);
  lines.push(`    const claims = {`);
  lines.push(`      sub: typeof payload.sub === 'string' ? payload.sub : null,`);
  lines.push(`      email: typeof payload.email === 'string' ? payload.email : null,`);
  lines.push(`      name: typeof payload.name === 'string' ? payload.name : null,`);
  lines.push(`      roleClaim: typeof payload.role === 'string' ? payload.role : null,`);
  lines.push(`    };`);
  lines.push(`    if (VERIFY_TOKENS) {`);
  lines.push(`      const ok = await verifyOidcToken(parts, jwtHeader, payload);`);
  lines.push(`      if (!ok) return { present: true, verified: false, devMode: false, ...NO_IDENTITY };`);
  lines.push(`      return { present: true, verified: true, devMode: false, ...claims };`);
  lines.push(`    }`);
  lines.push(`    // Local dev: synthetic persona tokens are unsigned by design.`);
  lines.push(`    return { present: true, verified: false, devMode: payload.dev === true, ...claims };`);
  lines.push(`  } catch {`);
  lines.push(`    return { present: true, verified: false, devMode: false, ...NO_IDENTITY };`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');
  return lines.join('\n');
}

function pythonSource() {
  const lines = [];
  lines.push(`# AUTO-GENERATED — DO NOT EDIT OR REWRITE — pre-staged OIDC identity parser.`);
  lines.push(`# Use parse_oidc_identity(request) as the ONLY reader of x-amzn-oidc-data.`);
  lines.push(`# Requires the \`cryptography\` package (add \`cryptography>=42\` to requirements.txt).`);
  lines.push(`"""Semantics (reference/user-identity.md):`);
  lines.push('');
  lines.push(`- present: an x-amzn-oidc-data header was supplied.`);
  lines.push(`- verified: the token's ES256 signature was checked against the ALB's regional`);
  lines.push(`  public key, it is unexpired, and its signer / iss match the platform pins`);
  lines.push(`  (PLATFORM_ALB_ARN, ALB_EXPECTED_ISSUER). Verification runs wherever AWS_REGION`);
  lines.push(`  is set (every deployed task); a present but invalid token yields no identity.`);
  lines.push(`- dev_mode: the token carries dev=true (synthetic personas only — the ALB`);
  lines.push(`  overwrites these headers in production) OR no header at all. Never true once`);
  lines.push(`  verified.`);
  lines.push(`- role_claim: the token's role claim. On user first-login, use it when`);
  lines.push(`  non-null; otherwise the app's default (least-privileged) role.`);
  lines.push(`"""`);
  lines.push('');
  lines.push(`import base64`);
  lines.push(`import json`);
  lines.push(`import os`);
  lines.push(`import time`);
  lines.push(`import urllib.request`);
  lines.push(`from typing import Any, Dict, Optional, TypedDict`);
  lines.push('');
  lines.push(`# Platform-injected pins (empty = not pinned); deployed tasks always have AWS_REGION.`);
  lines.push(`_EXPECTED_SIGNER = os.environ.get("PLATFORM_ALB_ARN", "")`);
  lines.push(`_EXPECTED_ISSUER = os.environ.get("ALB_EXPECTED_ISSUER", "")`);
  lines.push(`_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or ""`);
  lines.push(`_VERIFY_TOKENS = bool(_REGION)`);
  lines.push(`if _VERIFY_TOKENS and not _EXPECTED_SIGNER:`);
  lines.push(`    print("OIDC verify: PLATFORM_ALB_ARN not set - accepting tokens signed by any load balancer in the region")`);
  lines.push('');
  lines.push(`_alb_key_cache: Dict[str, Any] = {}`);
  lines.push(`_NO_IDENTITY = {"sub": None, "email": None, "name": None, "role_claim": None}`);
  lines.push('');
  lines.push('');
  lines.push(`class OidcIdentity(TypedDict):`);
  lines.push(`    present: bool`);
  lines.push(`    verified: bool`);
  lines.push(`    dev_mode: bool`);
  lines.push(`    sub: Optional[str]`);
  lines.push(`    email: Optional[str]`);
  lines.push(`    name: Optional[str]`);
  lines.push(`    role_claim: Optional[str]`);
  lines.push('');
  lines.push('');
  lines.push(`def _b64url_decode(segment: str) -> bytes:`);
  lines.push(`    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))`);
  lines.push('');
  lines.push('');
  lines.push(`def _get_alb_public_key(kid: str):`);
  lines.push(`    """Fetch (and cache) the ALB public key: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>"""`);
  lines.push(`    from cryptography.hazmat.primitives import serialization`);
  lines.push(`    if kid in _alb_key_cache:`);
  lines.push(`        return _alb_key_cache[kid]`);
  lines.push(`    url = f"https://public-keys.auth.elb.{_REGION}.amazonaws.com/{kid}"`);
  lines.push(`    with urllib.request.urlopen(url, timeout=5) as res:`);
  lines.push(`        pem = res.read()`);
  lines.push(`    key = serialization.load_pem_public_key(pem)`);
  lines.push(`    _alb_key_cache[kid] = key`);
  lines.push(`    return key`);
  lines.push('');
  lines.push('');
  lines.push(`def _verify_oidc_token(parts, header: Dict[str, Any], payload: Dict[str, Any]) -> bool:`);
  lines.push(`    """ES256 signature against the regional ALB key, expiry, and the platform pins`);
  lines.push(`    (signer and iss live in the JWT HEADER, not the payload)."""`);
  lines.push(`    try:`);
  lines.push(`        from cryptography.hazmat.primitives import hashes`);
  lines.push(`        from cryptography.hazmat.primitives.asymmetric import ec, utils`);
  lines.push(`        if len(parts) != 3 or not header.get("kid") or header.get("alg") != "ES256":`);
  lines.push(`            return False`);
  lines.push(`        key = _get_alb_public_key(header["kid"])`);
  lines.push(`        signature = _b64url_decode(parts[2])`);
  lines.push(`        half = len(signature) // 2`);
  lines.push(`        der_sig = utils.encode_dss_signature(`);
  lines.push(`            int.from_bytes(signature[:half], "big"), int.from_bytes(signature[half:], "big")`);
  lines.push(`        )`);
  lines.push(`        key.verify(der_sig, f"{parts[0]}.{parts[1]}".encode(), ec.ECDSA(hashes.SHA256()))`);
  lines.push(`        exp = payload.get("exp")`);
  lines.push(`        if not isinstance(exp, (int, float)) or exp < time.time():`);
  lines.push(`            return False`);
  lines.push(`        if _EXPECTED_SIGNER and header.get("signer") != _EXPECTED_SIGNER:`);
  lines.push(`            print("OIDC verify: signer is not the platform load balancer")`);
  lines.push(`            return False`);
  lines.push(`        if _EXPECTED_ISSUER and header.get("iss") != _EXPECTED_ISSUER:`);
  lines.push(`            print("OIDC verify: issuer is not the platform identity provider")`);
  lines.push(`            return False`);
  lines.push(`        return True`);
  lines.push(`    except Exception as error:`);
  lines.push(`        print(f"OIDC verify failed: {error}")`);
  lines.push(`        return False`);
  lines.push('');
  lines.push('');
  lines.push(`def parse_oidc_identity(request) -> OidcIdentity:`);
  lines.push(`    header = request.headers.get("x-amzn-oidc-data")`);
  lines.push(`    if not header:`);
  lines.push(`        return {"present": False, "verified": False, "dev_mode": True, **_NO_IDENTITY}`);
  lines.push(`    try:`);
  lines.push(`        parts = header.split(".")`);
  lines.push(`        jwt_header = json.loads(_b64url_decode(parts[0]))`);
  lines.push(`        payload = json.loads(_b64url_decode(parts[1]))`);
  lines.push(`        claims = {`);
  lines.push(`            "sub": payload.get("sub"),`);
  lines.push(`            "email": payload.get("email"),`);
  lines.push(`            "name": payload.get("name"),`);
  lines.push(`            "role_claim": payload.get("role"),`);
  lines.push(`        }`);
  lines.push(`        if _VERIFY_TOKENS:`);
  lines.push(`            if not _verify_oidc_token(parts, jwt_header, payload):`);
  lines.push(`                return {"present": True, "verified": False, "dev_mode": False, **_NO_IDENTITY}`);
  lines.push(`            return {"present": True, "verified": True, "dev_mode": False, **claims}`);
  lines.push(`        # Local dev: synthetic persona tokens are unsigned by design.`);
  lines.push(`        return {"present": True, "verified": False, "dev_mode": payload.get("dev") is True, **claims}`);
  lines.push(`    except Exception:`);
  lines.push(`        return {"present": True, "verified": False, "dev_mode": False, **_NO_IDENTITY}`);
  lines.push('');
  return lines.join('\n');
}
