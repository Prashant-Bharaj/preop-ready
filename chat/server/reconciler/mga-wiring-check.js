/**
 * mga-wiring-check.js — deterministic MGA integration invariants.
 *
 * Activates only for MGA apps (the harness-written workspace-root .env
 * contains MGA_* vars — the disk fact that assistants were provisioned at
 * /confirm). Zero cost for every other build.
 *
 * What it catches (all observed in a real failed build):
 *   - backend never imports the pre-staged MGA client and hand-rolls its
 *     own transport (hallucinated hostname, no Authorization header)
 *   - hardcoded non-MGA LLM hosts / model names in backend source
 *   - docker-compose.yml backend service missing the MGA_* env wiring, so
 *     the container boots without credentials
 *
 * Violations use the structural-check shape ({ scope, rule, file, found,
 * expected }) so buildFixDirective renders them without new plumbing.
 * Line-based scanning, no external deps — same posture as
 * structural-checks.js.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Non-MGA LLM references that must never appear in generated backend source.
// Shared with the stop-hook validator (stop-hooks.js) so the in-context
// check and the pre-compose gate agree.
export const BANNED_LLM_PATTERNS = [
  { re: /api\.openai\.com/i, label: 'OpenAI API host' },
  { re: /api\.anthropic\.com/i, label: 'Anthropic API host' },
  { re: /generativelanguage\.googleapis/i, label: 'Google AI host' },
  { re: /mga\.platform\.[a-z.]+/i, label: 'hallucinated MGA host (real base URL comes from MGA_BASE_URL env)' },
  { re: /\bgpt-[34][a-z0-9.-]*\b/i, label: 'OpenAI model name (models are pinned on the MGA assistant, not in app code)' },
];

const PRE_STAGED_CLIENTS = [
  { rel: 'backend/src/lib/mga-client.ts', importRe: /mga-client(?:\.js)?['"]/ },
  { rel: 'backend/src/mga_client.py', importRe: /(?:from|import)\s+(?:src\.|\.)?mga_client\b/ },
];

const SOURCE_EXTS = new Set(['.ts', '.js', '.mjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git', '__pycache__']);

/** True when the harness provisioned MGA credentials for this app. */
export function isMgaApp(workspaceDir) {
  const envPath = path.join(workspaceDir, '.env');
  if (!existsSync(envPath)) return false;
  try {
    return /^\s*MGA_[A-Z0-9_]+\s*=/m.test(readFileSync(envPath, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * @param {string} workspaceDir
 * @param {string[]} scopes - scopes under check (backend / integration gate
 *                            their respective rules)
 * @returns {{ ok: boolean, skipped?: string, violations: Array<{scope, rule, file, found, expected}> }}
 */
export function runMgaWiringChecks(workspaceDir, scopes = []) {
  if (!isMgaApp(workspaceDir)) {
    return { ok: true, skipped: 'not-an-mga-app', violations: [] };
  }

  const violations = [];

  if (scopes.includes('backend')) {
    const files = listBackendSourceFiles(workspaceDir);
    checkClientUsage(workspaceDir, files, violations);
    checkBannedReferences(workspaceDir, files, violations);
    checkVectordbUsage(workspaceDir, files, violations);
  }

  if (scopes.includes('integration')) {
    checkComposeWiring(workspaceDir, violations);
  }

  return { ok: violations.length === 0, violations };
}

/**
 * When the build provisions a vectordb service, the backend must actually
 * connect to it (read VECTORDB_* env vars). Observed drift: the backend did
 * its vector work on the MAIN database pool — functionally alive only
 * because the platform postgres image happens to ship pgvector, while the
 * dedicated vectordb container ran empty.
 */
function checkVectordbUsage(workspaceDir, files, violations) {
  if (!existsSync(path.join(workspaceDir, 'vectordb', 'Dockerfile'))) return;
  const usesVectordb = files.some(({ content }) => /VECTORDB_/.test(content));
  if (usesVectordb) return;
  violations.push({
    scope: 'backend',
    rule: 'vectordb-unused',
    file: 'backend/src',
    found: 'a vectordb service is provisioned but no backend source reads VECTORDB_* env vars',
    expected: 'vector tables and similarity queries must use a pool connected via VECTORDB_HOST/PORT/NAME/USER/PASSWORD — never the main DATABASE_* pool',
  });
}

function checkClientUsage(workspaceDir, files, violations) {
  const staged = PRE_STAGED_CLIENTS.find((c) => existsSync(path.join(workspaceDir, c.rel)));

  if (staged) {
    const referenced = files.some(({ rel, content }) =>
      rel !== staged.rel && staged.importRe.test(content));
    if (!referenced) {
      violations.push({
        scope: 'backend',
        rule: 'mga-client-unused',
        file: staged.rel,
        found: 'the pre-staged MGA client is never imported by backend source',
        expected: staged.rel.endsWith('.py')
          ? 'from src.mga_client import chat_with_assistant — use it for every MGA call'
          : "import { chatWithAssistant, streamChat } from './lib/mga-client.js' — use it for every MGA call",
      });
    }
    return;
  }

  // No pre-staged client (older workspace / continuation path): the backend
  // must at least read the key from env and send Bearer auth somewhere.
  const readsKey = files.some(({ content }) => /MGA_API_KEY/.test(content));
  const sendsBearer = files.some(({ content }) => /Authorization/.test(content) && /Bearer/.test(content));
  if (!readsKey || !sendsBearer) {
    violations.push({
      scope: 'backend',
      rule: 'mga-env-bearer-missing',
      file: 'backend/src',
      found: `MGA_API_KEY read: ${readsKey}; Authorization Bearer header: ${sendsBearer}`,
      expected: 'read MGA_API_KEY/MGA_BASE_URL/MGA_ASSISTANT_ID from env and send `Authorization: Bearer` on every MGA call (see snippets/llm/mga-assistant-client)',
    });
  }
}

function checkBannedReferences(workspaceDir, files, violations) {
  for (const { rel, content } of files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { re, label } of BANNED_LLM_PATTERNS) {
        if (re.test(lines[i])) {
          violations.push({
            scope: 'backend',
            rule: 'banned-llm-reference',
            file: `${rel}:${i + 1}`,
            found: `${label} — ${lines[i].trim().slice(0, 160)}`,
            expected: 'MGA only: base URL from MGA_BASE_URL env (default chat.int.bayer.com/api/v2); no third-party LLM hosts or model names in app code',
          });
        }
      }
    }
  }
}

function checkComposeWiring(workspaceDir, violations) {
  const composePath = ['docker-compose.yml', 'docker-compose.yaml']
    .map((f) => path.join(workspaceDir, f))
    .find((p) => existsSync(p));
  if (!composePath) return; // file-structure checks own "compose missing"

  let content;
  try { content = readFileSync(composePath, 'utf-8'); } catch { return; }

  if (/MGA_API_KEY/.test(content)) return;

  const backendBlock = extractServiceBlock(content, 'backend');
  if (backendBlock && /env_file:/.test(backendBlock) && /\.env\b/.test(backendBlock)) return;

  violations.push({
    scope: 'integration',
    rule: 'compose-mga-env-missing',
    file: path.basename(composePath),
    found: 'backend service passes no MGA_* environment entries and no env_file: .env',
    expected: 'env_file: [.env] on the backend service plus MGA_API_KEY/MGA_BASE_URL/MGA_ASSISTANT_ID passthrough (subagent-integration.md — "MGA env wiring")',
  });
}

/**
 * Loose indent-based service block extraction — the same posture as the
 * compose scans elsewhere in the reconciler. Returns the text from the
 * `<name>:` line to the next service at the same indent, or null.
 */
function extractServiceBlock(content, name) {
  const lines = content.split('\n');
  const startRe = new RegExp(`^(\\s+)${name}:\\s*$`);
  let start = -1;
  let indent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(startRe);
    if (m) { start = i; indent = m[1]; break; }
  }
  if (start === -1) return null;
  const block = [lines[start]];
  const siblingRe = new RegExp(`^${indent}\\S`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && siblingRe.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

export function listBackendSourceFiles(workspaceDir) {
  const root = path.join(workspaceDir, 'backend');
  const out = [];
  walk(root, out);
  return out.map((abs) => {
    let content = '';
    try { content = readFileSync(abs, 'utf-8'); } catch { /* unreadable — skip content */ }
    return { rel: path.relative(workspaceDir, abs), content };
  });
}

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out);
    else if (SOURCE_EXTS.has(path.extname(entry))) out.push(abs);
  }
}
