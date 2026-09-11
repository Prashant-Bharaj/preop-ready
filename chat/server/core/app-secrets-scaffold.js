/**
 * App secrets — boot-time scaffold + line-oriented .env editor.
 *
 * The set of usable app secrets is closed: the deploy job in
 * .github/workflows/deploy.yml hardcodes a fixed `secrets:` block. Anything
 * outside that allow-list never reaches the deployed container, so we
 * publish the same list here as the menu the user fills in. PREDEFINED_SLOTS
 * is the single source of truth — both the scaffolder and the panel route
 * import from this file.
 *
 * Slots are tagged `kind: 'named' | 'generic'`. Named slots ship with a
 * fixed description in code; generic slots (SECRET_1/2/3) are reusable
 * parking spots where the user types their own description (e.g. "Stripe
 * API key") — stored as a `# SLOT: description` comment above the value
 * line in backend/.env.
 *
 * On boot we drop a commented-out template at <workspace>/backend/.env if
 * the file doesn't exist (or is empty — see ensureBackendEnvScaffold). The
 * file is gitignored (verified by scripts/preflight-check.sh) and never
 * committed, so we side-step the cybersec rule against committed
 * .env.example files: this is generated at runtime per-Codespace.
 *
 * Read/write helpers preserve unrelated comments and ordering. Setting a
 * value uncomments the matching line; clearing one re-comments it. Setting
 * a description upserts a `# SLOT: ...` line directly above the slot;
 * clearing the description removes that comment line. We never rewrite the
 * file from scratch — that would lose any header/comment additions the
 * user makes by hand.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';

// Mirror of .github/workflows/deploy.yml lines 148–157. If you add a slot
// there, add it here too — and vice versa. The two lists must stay aligned.
//
// `kind: 'named'`   — fixed-purpose slot; description in code is canonical.
// `kind: 'generic'` — reusable slot; the user types a description per app.
export const PREDEFINED_SLOTS = [
  { name: 'OPENAI_KEY',     kind: 'named',   description: 'OpenAI API key (sk-...)' },
  { name: 'DATABASE_URL',   kind: 'named',   description: 'External database connection string (only when not using the bundled db service)' },
  { name: 'API_KEY',        kind: 'named',   description: 'Generic API key for an external service' },
  { name: 'API_SECRET',     kind: 'named',   description: 'Generic API secret paired with API_KEY' },
  { name: 'JWT_SECRET',     kind: 'named',   description: 'Signing secret for JWT tokens issued by the backend' },
  { name: 'WEBHOOK_SECRET', kind: 'named',   description: 'Shared secret for verifying inbound webhook signatures' },
  { name: 'ENCRYPTION_KEY', kind: 'named',   description: 'Symmetric encryption key (prefer 32-byte hex)' },
  { name: 'SECRET_1',       kind: 'generic', description: null },
  { name: 'SECRET_2',       kind: 'generic', description: null },
  { name: 'SECRET_3',       kind: 'generic', description: null },
];

export const PREDEFINED_SLOT_NAMES = PREDEFINED_SLOTS.map((s) => s.name);

// Secret names are validated upstream, but they still become RegExp source here.
function escapeRegExp(v) {
  return String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSlotMeta(name) {
  return PREDEFINED_SLOTS.find((s) => s.name === name) || null;
}

const SCAFFOLD_HEADER = `# Local app secrets. Gitignored — never committed.
# The APP_ prefix is added at deploy time; in this file use the bare names.
# Uncomment and fill the slots your app needs. The list below mirrors the
# GitHub Actions allow-list in .github/workflows/deploy.yml.
# See .platform-rules/reference/secrets.md for usage.
`;

function backendEnvPath(workspaceDir) {
  return path.join(workspaceDir, 'backend', '.env');
}

function buildScaffold() {
  const lines = [SCAFFOLD_HEADER.trimEnd(), ''];
  for (const slot of PREDEFINED_SLOTS) {
    if (slot.description) {
      lines.push(`# ${slot.name}: ${slot.description}`);
    }
    lines.push(`# ${slot.name}=`);
    lines.push('');
  }
  // Trim the trailing blank line for a tidier file footer.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

/**
 * Idempotently scaffold backend/.env. If the file already exists with
 * non-zero size we leave it alone — never clobber user values. An empty
 * file (size 0) carries no information; treat it as missing so the user
 * gets the helpful header on first boot.
 */
export function ensureBackendEnvScaffold(workspaceDir) {
  const backendDir = path.join(workspaceDir, 'backend');
  if (!existsSync(backendDir)) return { skipped: 'no-backend-dir' };

  const envPath = backendEnvPath(workspaceDir);

  if (existsSync(envPath)) {
    let size = -1;
    try { size = statSync(envPath).size; } catch { /* fall through */ }
    if (size > 0) return { skipped: 'exists' };
  }

  writeFileSync(envPath, buildScaffold(), { mode: 0o600 });
  // writeFileSync's mode is best-effort if the file already existed — make it explicit.
  try { chmodSync(envPath, 0o600); } catch { /* non-fatal */ }
  return { created: envPath };
}

// ── parsers ──

const VALUE_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const COMMENTED_VALUE_LINE_RE = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
// Description comment uses `:` (not `=`) to disambiguate from a commented value line.
const DESCRIPTION_LINE_RE = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/;

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Read backend/.env and return a map of slot → { isSet, value, description }
 * for every predefined slot. Slots not present in the file count as unset.
 *
 * `description` resolution:
 *   - Named slots: always the hardcoded description in PREDEFINED_SLOTS
 *     (the file may also have a `# SLOT: ...` comment from scaffold output;
 *     we ignore parse mismatches because the canonical source is code).
 *   - Generic slots: parsed from the `# SLOT: ...` line if present, else null.
 */
export function readBackendEnv(workspaceDir) {
  const envPath = backendEnvPath(workspaceDir);
  const result = {};
  for (const slot of PREDEFINED_SLOTS) {
    result[slot.name] = {
      isSet: false,
      value: '',
      description: slot.kind === 'named' ? slot.description : null,
    };
  }

  if (!existsSync(envPath)) return result;

  let text;
  try { text = readFileSync(envPath, 'utf-8'); } catch { return result; }

  for (const line of text.split('\n')) {
    const valueMatch = VALUE_LINE_RE.exec(line);
    if (valueMatch) {
      const [, name, rawValue] = valueMatch;
      if (!result[name]) continue;
      const value = unquote(rawValue);
      result[name].isSet = value.length > 0;
      result[name].value = value;
      continue;
    }
    const descMatch = DESCRIPTION_LINE_RE.exec(line);
    if (descMatch) {
      const [, name, desc] = descMatch;
      if (!result[name]) continue;
      // Only override the in-code description for generic slots — named
      // slots have an authoritative description in PREDEFINED_SLOTS.
      const meta = findSlotMeta(name);
      if (meta?.kind === 'generic') {
        result[name].description = desc;
      }
      continue;
    }
    // commented value line — leaves isSet:false, no description override
  }
  return result;
}

// ── writer ──

const MAX_DESCRIPTION_LEN = 120;

/**
 * Sanitize a description into a single safe line. Returns null if the input
 * collapses to empty (caller treats as "clear description"). Throws if the
 * input is unexpectedly large — the route validates length before reaching
 * here, so this is a safety net.
 */
export function sanitizeDescription(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .replace(/[\r\n\t]+/g, ' ')   // collapse newlines/tabs
    .replace(/\s+/g, ' ')         // collapse runs of whitespace
    .trim();
  // Strip leading `#` so the user can't sneak a comment-of-a-comment in.
  s = s.replace(/^#+\s*/, '');
  if (!s) return null;
  if (s.length > MAX_DESCRIPTION_LEN) {
    throw new Error(`Description too long (max ${MAX_DESCRIPTION_LEN} chars)`);
  }
  return s;
}

/**
 * Write a single slot to backend/.env, preserving comments and ordering.
 *
 * Args (all optional individually; at least one of value/description must
 * be a string for any work to happen):
 *   - value:       string. '' clears the value (re-comments the line);
 *                  undefined leaves the value alone.
 *   - description: string. '' clears the description (removes the comment
 *                  line); undefined leaves the description alone. Only
 *                  meaningful for generic slots — passing it on a named
 *                  slot throws.
 *
 * Returns { ok, isSet, description }.
 */
export function writeBackendEnv(workspaceDir, name, { value, description } = {}) {
  const meta = findSlotMeta(name);
  if (!meta) throw new Error(`Unknown slot: ${name}`);
  if (description !== undefined && meta.kind !== 'generic') {
    throw new Error(`Cannot edit description for named slot ${name}`);
  }

  const envPath = backendEnvPath(workspaceDir);
  if (!existsSync(envPath)) {
    const result = ensureBackendEnvScaffold(workspaceDir);
    if (!result.created) {
      throw new Error('backend/.env does not exist and could not be scaffolded — does backend/ exist?');
    }
  }

  const original = readFileSync(envPath, 'utf-8');
  let lines = original.split('\n');

  // ── 1. update the value line if requested ────────────────────────────────
  if (typeof value === 'string') {
    const isClearing = !value.trim();
    const liveRe = new RegExp(`^(\\s*)${escapeRegExp(name)}\\s*=.*$`);
    const commentedRe = new RegExp(`^(\\s*)#\\s*${escapeRegExp(name)}\\s*=.*$`);

    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (liveRe.test(lines[i]) || commentedRe.test(lines[i])) {
        lines[i] = isClearing ? `# ${name}=` : `${name}=${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(isClearing ? `# ${name}=` : `${name}=${value}`);
    }
  }

  // ── 2. update the description comment if requested ───────────────────────
  if (typeof description === 'string') {
    const desc = sanitizeDescription(description);
    const descRe = new RegExp(`^\\s*#\\s*${escapeRegExp(name)}\\s*:\\s*.+?\\s*$`);

    let descIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (descRe.test(lines[i])) { descIdx = i; break; }
    }

    if (desc === null) {
      // Clearing — drop the line if present.
      if (descIdx >= 0) lines.splice(descIdx, 1);
    } else if (descIdx >= 0) {
      // Update existing description line.
      lines[descIdx] = `# ${name}: ${desc}`;
    } else {
      // Insert a new description line directly above the slot's value line.
      const slotRe = new RegExp(`^\\s*(?:#\\s*)?${escapeRegExp(name)}\\s*=`);
      let slotIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (slotRe.test(lines[i])) { slotIdx = i; break; }
      }
      if (slotIdx >= 0) {
        lines.splice(slotIdx, 0, `# ${name}: ${desc}`);
      } else {
        // No value line at all — append both, in order.
        if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`# ${name}: ${desc}`);
        lines.push(`# ${name}=`);
      }
    }
  }

  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* non-fatal */ }

  // Re-read to report current authoritative state.
  const after = readBackendEnv(workspaceDir)[name];
  return { ok: true, isSet: after.isSet, description: after.description };
}

/**
 * Convenience for the redaction pipeline: list current non-empty values from
 * backend/.env. Caller passes them to setSensitiveStrings so Cline output
 * containing any of these gets [REDACTED] before it's logged or persisted.
 */
export function listAppSecretValues(workspaceDir) {
  const env = readBackendEnv(workspaceDir);
  return Object.values(env).filter((s) => s.isSet).map((s) => s.value);
}

/**
 * Read-only status of the harness-managed MGA credentials in the
 * workspace-root .env (NOT backend/.env — different file, written at
 * /confirm time by session/routes.js). Never returns the API key value;
 * assistant ids are non-secret UUIDs and returned in full.
 *
 * @returns {{ present: boolean, baseUrl: string|null, apiKeySet: boolean,
 *             assistants: Array<{ envVar: string, id: string, set: boolean }> }}
 */
export function readWorkspaceMgaEnv(workspaceDir) {
  const out = { present: false, baseUrl: null, apiKeySet: false, assistants: [] };
  const envPath = path.join(workspaceDir, '.env');
  if (!existsSync(envPath)) return out;
  let content;
  try { content = readFileSync(envPath, 'utf-8'); } catch { return out; }
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(MGA_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    out.present = true;
    if (name === 'MGA_API_KEY') out.apiKeySet = value.length > 0;
    else if (name === 'MGA_BASE_URL') out.baseUrl = value || null;
    else if (name.startsWith('MGA_ASSISTANT_ID')) {
      out.assistants.push({ envVar: name, id: value, set: value.length > 0 });
    }
  }
  return out;
}

/**
 * Slot summaries for the Cline prompt env section: names + kind +
 * description + isSet, *never* values. Used by prompt-builder to render a
 * human-readable map of available slots so Cline picks the right one.
 */
export function listAppSecretSummaries(workspaceDir) {
  const env = readBackendEnv(workspaceDir);
  return PREDEFINED_SLOTS.map((slot) => ({
    name: slot.name,
    kind: slot.kind,
    description: env[slot.name].description,
    isSet: env[slot.name].isSet,
  }));
}
