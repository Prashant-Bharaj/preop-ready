/**
 * auth-helper-generator.js — emits `backend/src/lib/auth.ts` with a
 * caller-identity helper whose header names come LITERALLY from the
 * contract's business_logic_contract.rules text.
 *
 * Emitted when the rules text references identity headers (X-User-Id,
 * X-User-Role, X-User-Email, etc.). Otherwise returns null.
 *
 * The helper exports:
 *   getCallerIdentity(req) → { userId, role, ... }
 *   requireRole(role) → RequestHandler middleware (403 on mismatch)
 *
 * Field names + header names come from the contract — so a contract that
 * says "X-User-Email" produces a helper that reads X-User-Email. The
 * subagent can't drift to a different header because the helper is the
 * only API surface.
 */

// Capture X-... headers mentioned in rule prose. Each rule string may
// mention multiple headers. Order doesn't matter; we dedupe.
const HEADER_RE = /\bX-[A-Z][A-Za-z]*(?:-[A-Z][A-Za-z]*)*\b/g;

const KNOWN = {
  'X-User-Id':    { field: 'userId',   parse: 'number', default: '1' },
  'X-User-Role':  { field: 'role',     parse: 'string', default: "'user'" },
  'X-User-Email': { field: 'email',    parse: 'string', default: "'anon@example.com'" },
  'X-Workspace':  { field: 'workspace',parse: 'string', default: "''" },
  'X-Tenant-Id':  { field: 'tenantId', parse: 'number', default: '0' },
};

export function detectIdentityHeaders(contract) {
  const rules = contract?.businessLogicContract?.rules || contract?.business_logic_contract?.rules || [];
  if (!Array.isArray(rules)) return [];
  const seen = new Set();
  for (const rule of rules) {
    if (typeof rule !== 'string') continue;
    HEADER_RE.lastIndex = 0;
    let m;
    while ((m = HEADER_RE.exec(rule)) !== null) seen.add(m[0]);
  }
  return [...seen];
}

export function generateAuthHelper(contract) {
  const headers = detectIdentityHeaders(contract);
  if (headers.length === 0) return null;

  // Build the Caller interface fields + the parsing block for each header.
  const fields = [];
  const parses = [];
  let hasRole = false;
  for (const h of headers) {
    const meta = KNOWN[h] || { field: identFromHeader(h), parse: 'string', default: `''` };
    fields.push(`  ${meta.field}: ${meta.parse};`);
    if (meta.parse === 'number') {
      parses.push(`  const ${meta.field}Raw = req.header('${h}');`);
      parses.push(`  const ${meta.field} = Number(${meta.field}Raw ?? ${meta.default});`);
      parses.push(`  if (!Number.isFinite(${meta.field})) {`);
      parses.push(`    throw new Error(\`invalid ${h} header: \${${meta.field}Raw}\`);`);
      parses.push(`  }`);
    } else {
      parses.push(`  const ${meta.field} = req.header('${h}') ?? ${meta.default};`);
    }
    if (meta.field === 'role') hasRole = true;
  }
  const returnFields = headers.map(h => (KNOWN[h]?.field) || identFromHeader(h)).join(', ');

  const lines = [];
  lines.push(`// AUTO-GENERATED — DO NOT EDIT — emitted from business_logic_contract.rules`);
  lines.push(`// Generated ${new Date().toISOString()}`);
  lines.push(`// Headers detected: ${headers.join(', ')}`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Identity + role gate helpers. Use these in every handler — do NOT`);
  lines.push(` * read identity headers directly. The header names below come from the`);
  lines.push(` * contract's business_logic_contract.rules verbatim.`);
  lines.push(` */`);
  lines.push(`import type { Request, Response, NextFunction, RequestHandler } from 'express';`);
  lines.push('');
  lines.push(`export interface Caller {`);
  lines.push(...fields);
  lines.push(`}`);
  lines.push('');
  lines.push(`export function getCallerIdentity(req: Request): Caller {`);
  lines.push(...parses);
  lines.push(`  return { ${returnFields} };`);
  lines.push(`}`);
  lines.push('');

  if (hasRole) {
    lines.push(`export function requireRole(requiredRole: string): RequestHandler {`);
    lines.push(`  return (req: Request, res: Response, next: NextFunction) => {`);
    lines.push(`    let caller: Caller;`);
    lines.push(`    try { caller = getCallerIdentity(req); }`);
    lines.push(`    catch (err) {`);
    lines.push(`      res.status(400).json({ error: (err as Error).message });`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    if (caller.role !== requiredRole) {`);
    lines.push(`      res.status(403).json({ error: \`requires role \${requiredRole}\` });`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(`    next();`);
    lines.push(`  };`);
    lines.push(`}`);
    lines.push('');
  }

  return { source: lines.join('\n'), headers };
}

function identFromHeader(h) {
  // X-Some-Header → someHeader
  return h.replace(/^X-/, '')
    .split('-')
    .map((part, i) => i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}
