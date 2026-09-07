/**
 * security-review.js — post-build security audit of the GENERATED app.
 *
 * The endpoint probe proves handlers respond and the authz gate checks role
 * enforcement; neither reviews the source for vulnerabilities. This phase reads
 * the generated `backend/ frontend/ database/ vectordb/` source and asks one
 * tool-less MGA call to flag security issues, held to a PRODUCTION bar (the
 * generated app is internet-facing at https://<repo>.vibe.intranet.cnb).
 *
 * Findings anchor to `.platform-rules/02-security.md` — the same rules the coder
 * was built under — so an auto-fix directive can reference them (and the coder
 * can `get_rules("security")`). Critical/High are auto-fixed (one round per
 * scope, orchestrated in docker-orchestration.js); Medium/Low are reported.
 *
 * SECURITY_REVIEW_SKIP=true → skipped silently (A/B + cost control), matching
 * ENDPOINT_PROBE_SKIP / UI_SANITY_SKIP. Every failure path degrades to
 * "skipped", never an error.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { callMgaCompletions } from '../agent/llm/llm.js';
import { pickModel } from '../agent/llm/model-picker.js';
import { tlog } from '../util/timestamped-log.js';

// Bounds on how much source we pack into the review call (keeps token cost
// predictable — the phase runs on every build).
const MAX_REVIEW_FILES = Number(process.env.SECURITY_REVIEW_MAX_FILES) || 40;
const MAX_REVIEW_BYTES = Number(process.env.SECURITY_REVIEW_MAX_BYTES) || 180_000;
const MAX_FILE_BYTES = 24_000; // per-file cap so one large file can't crowd out others

const SCOPE_DIRS = { backend: 'backend', frontend: 'frontend', database: 'database', vectordb: 'vectordb' };
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|sql|conf|ya?ml|toml)$/i;
const NAME_INCLUDE_RE = /^(dockerfile|nginx.*\.conf)$/i; // extensionless / config files worth reviewing
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'target', '__pycache__', 'coverage', '.venv', 'venv']);
const SKIP_FILE_RE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|\.min\.(js|css)$)/i;

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const SCOPES = Object.keys(SCOPE_DIRS);

const SYSTEM_PROMPT = `You are a principal application security reviewer auditing a freshly GENERATED
full-stack app before it goes live. This app IS internet-facing (deployed at
https://<repo>.vibe.intranet.cnb) — hold it to a PRODUCTION security bar.

Review ONLY the files provided below. Report concrete, rule-anchored security
defects across: injection (SQL built by string concatenation instead of
parameterized \\$1 placeholders; command injection via exec/spawn; path
traversal), broken access control / IDOR (ownership not checked; admin routes
not role-gated; identity trusted from a raw header instead of a verified ALB
OIDC token), secrets (hardcoded keys/passwords/connection strings; secrets
logged or returned), input validation (unbounded bodies/uploads; missing
server-side validation), output handling / XSS (unescaped user content into
HTML, dangerouslySetInnerHTML/innerHTML; stack traces leaked instead of JSON
errors), SSRF (user-controlled outbound URLs), and container/infra hardening
(root containers instead of USER appuser; missing nginx security headers /
server_tokens off; wildcard CORS on state-changing routes). Cover the OWASP Top
10, XSS, and CSRF.

GROUND RULES:
- Evidence-based: only report a defect you can point to in the provided code
  (file + line). Do NOT speculate about code you cannot see.
- VERIFY BEFORE REPORTING: for each candidate, try to REFUTE it (is it already
  parameterized? already role-gated? already non-root?). Only report survivors.
- Severity (do NOT inflate): Critical = remotely exploitable now (injection,
  auth bypass, leaked live secret); High = exploitable with conditions (IDOR,
  missing authz on a mutating route, root container on an internet-facing
  service); Medium = defense-in-depth gap; Low = hygiene.
- These map to the platform rules in .platform-rules/02-security.md
  (parameterized SQL, non-root containers, nginx security headers, verified
  ALB-header identity only, JSON error responses).

OUTPUT: STRICT JSON only, no prose, no markdown fences:
{"findings":[{"severity":"Critical|High|Medium|Low","scope":"backend|frontend|database|vectordb","file":"backend/src/x.ts","line":42,"summary":"one sentence","fix":"specific remediation"}]}
If there are no issues, return {"findings":[]}.`;

/** Recursively collect reviewable source files under a scope dir, bounded. */
function collectDir(absDir, relPrefix, budget) {
  const out = [];
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.files <= 0 || budget.bytes <= 0) break;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...collectDir(path.join(absDir, e.name), `${relPrefix}/${e.name}`, budget));
      continue;
    }
    if (!e.isFile()) continue;
    const name = e.name;
    if (SKIP_FILE_RE.test(name)) continue;
    const reviewable = SOURCE_RE.test(name) || NAME_INCLUDE_RE.test(name);
    if (!reviewable) continue;
    const abs = path.join(absDir, name);
    let content;
    try {
      if (statSync(abs).size > MAX_FILE_BYTES * 4) continue; // skip very large files outright
      content = readFileSync(abs, 'utf8');
    } catch { continue; }
    if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES) + '\n… (truncated)';
    const rel = `${relPrefix}/${name}`;
    out.push({ path: rel, content });
    budget.files -= 1;
    budget.bytes -= content.length;
  }
  return out;
}

/** Collect the generated source for the given scopes, bounded by file/byte caps. */
export function collectReviewFiles(workspaceDir, scopes) {
  const budget = { files: MAX_REVIEW_FILES, bytes: MAX_REVIEW_BYTES };
  const wanted = (scopes && scopes.length ? scopes : SCOPES).filter((s) => SCOPE_DIRS[s]);
  const files = [];
  for (const scope of wanted) {
    const dir = path.join(workspaceDir, SCOPE_DIRS[scope]);
    if (!existsSync(dir)) continue;
    files.push(...collectDir(dir, SCOPE_DIRS[scope], budget));
  }
  return files;
}

function normSeverity(s) {
  const t = String(s || '').trim().toLowerCase();
  return SEVERITIES.find((sev) => sev.toLowerCase() === t) || null;
}

function inferScope(file) {
  const seg = String(file || '').replace(/^\.?\//, '').split('/')[0];
  return SCOPES.find((s) => SCOPE_DIRS[s] === seg) || null;
}

/**
 * Parse the model's JSON verdict into normalized findings. Robust to fenced
 * code blocks and leading/trailing prose; returns [] on anything unparseable.
 * Pure — unit-tested.
 */
export function parseSecurityFindings(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  let raw = content.trim();
  // Strip a ```json … ``` fence if present.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* retry on outermost braces below */ }
  if (obj === null || typeof obj !== 'object') {
    // Tolerate prose around the JSON: trim to the outermost { … }.
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try { obj = JSON.parse(raw.slice(first, last + 1)); } catch { return []; }
    } else {
      return [];
    }
  }
  const arr = Array.isArray(obj) ? obj : (Array.isArray(obj?.findings) ? obj.findings : []);
  const out = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const severity = normSeverity(f.severity);
    if (!severity) continue;
    const file = typeof f.file === 'string' ? f.file : '';
    const scope = SCOPES.includes(f.scope) ? f.scope : inferScope(file);
    const summary = typeof f.summary === 'string' ? f.summary.trim() : '';
    if (!summary) continue;
    out.push({
      severity,
      scope,
      file,
      line: Number.isFinite(f.line) ? f.line : null,
      summary,
      fix: typeof f.fix === 'string' ? f.fix.trim() : '',
    });
  }
  return out;
}

/**
 * Split findings into the auto-fix set (Critical/High, grouped by scope) and
 * the report-only set (Medium/Low). Findings with no resolvable scope can't be
 * auto-fixed, so they fall to report-only. Pure — unit-tested.
 */
export function partitionFindings(findings) {
  const criticalHigh = [];
  const reportOnly = [];
  for (const f of findings || []) {
    if ((f.severity === 'Critical' || f.severity === 'High') && f.scope) criticalHigh.push(f);
    else reportOnly.push(f);
  }
  const byScope = new Map();
  for (const f of criticalHigh) {
    if (!byScope.has(f.scope)) byScope.set(f.scope, []);
    byScope.get(f.scope).push(f);
  }
  return { criticalHigh, reportOnly, byScope };
}

/** Human-readable finding line for chat summaries + fix directives. */
function fmtFinding(f) {
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
  return `  [${f.severity}] ${f.summary}${loc}${f.fix ? `\n      Fix: ${f.fix}` : ''}`;
}

/** Build the `formatted` block a `security` fix directive carries (per scope). */
export function formatSecurityFixDirective(scope, findings) {
  return [
    `=== SECURITY REVIEW — ${scope.toUpperCase()} FINDINGS (fix each) ===`,
    '',
    'A security review of the generated app found the issues below. Fix each one',
    'by editing the listed file(s), following .platform-rules/02-security.md',
    '(parameterized SQL, non-root containers, nginx security headers, verified',
    'ALB-header identity only, JSON error responses). Do NOT add new endpoints or',
    'schema — only close these holes.',
    '',
    ...findings.map(fmtFinding),
  ].join('\n');
}

/**
 * Run the security review over the generated app. Returns
 * { skipped } or { findings: [...normalized] }. Never throws.
 */
export async function reviewGeneratedApp({ workspaceDir, scopes }) {
  if (process.env.SECURITY_REVIEW_SKIP === 'true') return { skipped: 'env' };
  const files = collectReviewFiles(workspaceDir, scopes);
  if (files.length === 0) return { skipped: 'no-files' };

  const started = Date.now();
  const packed = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  try {
    const { model } = pickModel({ phase: 'CONTRACT' });
    const { content } = await callMgaCompletions({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Review these ${files.length} generated file(s):\n\n${packed}` },
      ],
      model,
      assistantLabel: 'security-review',
      phase: 'CONTRACT',
    });
    const findings = parseSecurityFindings(content);
    tlog('[security-review] %d file(s) → %d finding(s) (%dms)', files.length, findings.length, Date.now() - started);
    return { findings };
  } catch (err) {
    tlog('[security-review] review call failed: %s', err?.message || err);
    return { skipped: 'review-failed' };
  }
}
