/**
 * W2.CASCADE — Contract cascade module (HARNESS_EVOLUTION.md §G).
 *
 * Router emits `iterate` with `affected_scopes[]`; W2.DISPATCH routes by that
 * set. But the router can MISS scopes — e.g. user says "rename users.full_name
 * to first_name + last_name", router emits `affected_scopes: [database,
 * backend]` but forgets the frontend even though `<UserCard>` displays
 * `user.full_name`. Without cascade the dispatch leaves the now-renamed
 * column referenced in the UI; compose comes up but the UI silently breaks.
 *
 * Two-step detection:
 *  1. **Trust router** — router has the contract diff and emits affected_scopes.
 *  2. **Verify by grep** — for breaking diffs (renamed/removed/retyped items),
 *     grep the workspace for occurrences of the affected identifiers. If
 *     matches surface in scopes NOT in `affected_scopes`, escalate (add them
 *     to the dispatch set) + emit a structured `cascade_escalation` event so
 *     `runs-report.js` can later aggregate "how often does the router miss".
 *
 * Cascade is BEST-EFFORT — failures (grep crash, malformed contract, fs IO
 * error) fall through `logAndSwallow` and return a no-escalation result. The
 * dispatcher must continue with router-emitted scopes if cascade can't run.
 *
 * Performance: capped at CASCADE_GREP_TIMEOUT_MS (30s default). On timeout
 * we return `incomplete: true` + emit a `cascade_incomplete` event; dispatch
 * proceeds fail-open with the router-emitted set.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { logAndSwallow } from '../util/log-helpers.js';
import { CASCADE_GREP_TIMEOUT_MS } from '../config/defaults.js';

// ──────────────────────────────────────────────────────────────────────────
// File-type whitelist + path-exclusion + content filters (Addition 2)
// ──────────────────────────────────────────────────────────────────────────

// Greppable code extensions only. Markdown is documentation, not enforcement;
// generated files are regenerated downstream; .harness/ is harness state.
const GREPPABLE_EXTENSIONS = new Set(['.sql', '.ts', '.tsx', '.js', '.jsx', '.py', '.json']);

// Path exclusions (substring match against workspace-relative path). Skips
// directories the cascade would otherwise traverse fruitlessly.
const EXCLUDED_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/generated/',
  '/.harness/',
  '/docs/',
  '/.git/',
];

// Top-level workspace dirs ↔ scope. Files at the workspace root (e.g.
// docker-compose.yml) are tagged 'integration' since that's the dispatch
// scope responsible for compose / infra wiring.
const SCOPE_BY_TOP_DIR = {
  backend: 'backend',
  frontend: 'frontend',
  database: 'database',
  vectordb: 'vectordb',
  integration: 'integration',
};

// Single-line comment markers per extension family. Matches lines that
// begin (after whitespace) with these tokens.
const COMMENT_LINE_PATTERNS = [
  /^\s*\/\//,    // JS / TS / JSX / TSX
  /^\s*#/,       // Python (also shell — fine to treat as comment-class)
  /^\s*--/,      // SQL line comment
  /^\s*\*/,      // JSDoc / C-style block continuation
];

// Block-comment heuristic (Addition 2): a line inside /* ... */ usually
// starts with "*" — already covered by COMMENT_LINE_PATTERNS above. Lines
// containing a `/*` open or `*/` close are also dropped as a rough filter;
// precise multi-line tracking is overkill per the addition's guidance.
const BLOCK_COMMENT_OPEN = /\/\*/;
const BLOCK_COMMENT_CLOSE = /\*\//;

// ──────────────────────────────────────────────────────────────────────────
// Identifier-variant helpers (Addition 2)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Given a single identifier (in any case), return the snake/camel/Pascal/
 * kebab variants. Used so that searching for `full_name` ALSO finds
 * `fullName`, `FullName`, and `full-name`.
 *
 * Heuristic — split on `_`, `-`, or case boundary, then re-emit.
 */
export function identifierVariants(name) {
  if (!name || typeof name !== 'string') return [];

  // Split into word parts. Accept inputs in any casing convention.
  const parts = name
    .replace(/[-_]+/g, ' ')                       // snake_case / kebab-case → space-separated
    .replace(/([a-z])([A-Z])/g, '$1 $2')           // camelCase → "camel Case"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')     // ACRONYMSyrupt → "ACRONYM Syrupt"
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());

  if (parts.length === 0) return [name];

  const snake = parts.join('_');
  const kebab = parts.join('-');
  const camel = parts[0] + parts.slice(1).map(capitalize).join('');
  const pascal = parts.map(capitalize).join('');
  // De-duplicate while preserving order.
  return Array.from(new Set([snake, kebab, camel, pascal, name]));
}

function capitalize(s) {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ──────────────────────────────────────────────────────────────────────────
// classifyDiff — Addition 1
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decide whether a contract section's before→after diff is BREAKING (removed
 * / renamed / retyped) or ADDITIVE-ONLY (new tables, new optional columns,
 * new endpoints, ...). Only breaking diffs trigger cascade.
 *
 * Heuristic for renames: when a column disappears AND a new column with
 * similar type appears in the same table within the same diff, treat as
 * rename. Same family of heuristic for endpoints + fields.
 *
 * @param {*} prior   — section value from .harness/contracts.json (may be undefined)
 * @param {*} next    — section value from the iterate emit
 * @param {string} sectionName — 'data_model' | 'api_contract' | 'ui_contract' | 'business_logic_contract' | 'vector_engine'
 * @returns {{ breaking: boolean, removedIdentifiers: Array, renames: Array }}
 */
export function classifyDiff(prior, next, sectionName) {
  const result = { breaking: false, removedIdentifiers: [], renames: [] };

  // Sections we don't cascade on.
  if (sectionName === 'business_logic_contract' || sectionName === 'vector_engine') {
    return result;
  }

  try {
    if (sectionName === 'data_model') {
      classifyDataModel(prior, next, result);
    } else if (sectionName === 'api_contract') {
      classifyApiContract(prior, next, result);
    } else if (sectionName === 'ui_contract') {
      classifyUiContract(prior, next, result);
    }
  } catch (err) {
    logAndSwallow(err, `[cascade] classifyDiff(${sectionName}) failed`);
    // Fail-open: treat as non-breaking so cascade doesn't spuriously escalate.
    return { breaking: false, removedIdentifiers: [], renames: [] };
  }

  result.breaking = result.removedIdentifiers.length > 0 || result.renames.length > 0;
  return result;
}

// ── data_model classifier ─────────────────────────────────────────────────

function classifyDataModel(prior, next, result) {
  const priorTables = collectTables(prior);
  const nextTables = collectTables(next);

  // Tables removed (and not present in next).
  for (const tname of Object.keys(priorTables)) {
    if (!nextTables[tname]) {
      result.removedIdentifiers.push({ kind: 'table', name: tname, scope: 'database' });
    }
  }

  // For tables present in both: compare columns.
  for (const tname of Object.keys(priorTables)) {
    if (!nextTables[tname]) continue;
    const priorCols = priorTables[tname];   // Map<name, type>
    const nextCols = nextTables[tname];

    const removedCols = [];
    for (const cname of Object.keys(priorCols)) {
      if (!(cname in nextCols)) {
        removedCols.push({ name: cname, type: priorCols[cname] });
      }
    }
    const addedCols = [];
    for (const cname of Object.keys(nextCols)) {
      if (!(cname in priorCols)) {
        addedCols.push({ name: cname, type: nextCols[cname] });
      }
    }

    // Rename heuristic — one removed col, ≥1 added cols of similar type.
    // Conservative: still record the rename (with first matching added col)
    // AND record the removed as a removed identifier so the grep also picks
    // up any leftover usage of the OLD name even if the new name didn't
    // surface yet.
    for (const rm of removedCols) {
      const matching = addedCols.find((a) => similarType(a.type, rm.type));
      if (matching) {
        result.renames.push({
          kind: 'column',
          oldName: rm.name,
          newName: matching.name,
          scope: 'database',
          table: tname,
        });
      }
      result.removedIdentifiers.push({
        kind: 'column',
        name: rm.name,
        scope: 'database',
        table: tname,
        evidence: `removed from ${tname}; type=${rm.type}`,
      });
    }

    // Type change on a still-present column (e.g. INTEGER → VARCHAR).
    for (const cname of Object.keys(priorCols)) {
      if (!(cname in nextCols)) continue;
      const before = priorCols[cname];
      const after = nextCols[cname];
      if (!similarType(before, after)) {
        // Type change is breaking — treat the column as a removed identifier
        // for grep purposes so callers update consumers.
        result.removedIdentifiers.push({
          kind: 'column',
          name: cname,
          scope: 'database',
          table: tname,
          evidence: `type changed: ${before} → ${after}`,
        });
      }
    }
  }
}

function collectTables(dm) {
  // Accept several shapes the router has emitted historically:
  //   { tables: [{ name, columns: [{ name, type }, ...] }, ...] }
  //   { tables: { users: { columns: { id: 'INT', ... } } } }
  //   { users: { columns: [{ name, type }] } }  // legacy
  const out = {};
  if (!dm || typeof dm !== 'object') return out;
  const tables = dm.tables || dm;
  if (Array.isArray(tables)) {
    for (const t of tables) {
      if (!t || typeof t !== 'object' || !t.name) continue;
      out[t.name] = collectColumns(t.columns);
    }
    return out;
  }
  if (typeof tables === 'object') {
    for (const [tname, t] of Object.entries(tables)) {
      if (!t || typeof t !== 'object') continue;
      out[tname] = collectColumns(t.columns);
    }
  }
  return out;
}

function collectColumns(cols) {
  // Returns Map<colName, typeString>. Accepts array-of-{name,type} or object.
  const out = {};
  if (!cols) return out;
  if (Array.isArray(cols)) {
    for (const c of cols) {
      if (!c || typeof c !== 'object' || !c.name) continue;
      out[c.name] = String(c.type || '').toUpperCase();
    }
    return out;
  }
  if (typeof cols === 'object') {
    for (const [cname, type] of Object.entries(cols)) {
      out[cname] = String(type || '').toUpperCase();
    }
  }
  return out;
}

function similarType(a, b) {
  // VARCHAR(255) vs VARCHAR(100): both VARCHAR family — but VARCHAR(100) is
  // a SHRINK that is breaking. Heuristic: extract base type word, compare
  // base. Then if both are VARCHAR with size, the smaller size is breaking.
  if (a === b) return true;
  if (!a || !b) return false;
  const baseA = String(a).split(/[\s(]/)[0].toUpperCase();
  const baseB = String(b).split(/[\s(]/)[0].toUpperCase();
  if (baseA !== baseB) return false;
  // Same base — check VARCHAR/CHAR/NUMERIC size shrinkage.
  const sizeA = parseInt((String(a).match(/\((\d+)/) || [])[1] || '0', 10);
  const sizeB = parseInt((String(b).match(/\((\d+)/) || [])[1] || '0', 10);
  if (sizeA > 0 && sizeB > 0 && sizeB < sizeA) {
    // Shrink — type change is breaking.
    return false;
  }
  return true;
}

// ── api_contract classifier ───────────────────────────────────────────────

function classifyApiContract(prior, next, result) {
  const priorEndpoints = collectEndpoints(prior);
  const nextEndpoints = collectEndpoints(next);

  // Endpoints removed (method+path).
  const priorKeys = new Set(Object.keys(priorEndpoints));
  const nextKeys = new Set(Object.keys(nextEndpoints));
  const removed = [...priorKeys].filter((k) => !nextKeys.has(k));
  const added = [...nextKeys].filter((k) => !priorKeys.has(k));

  for (const key of removed) {
    const [method, ...pathParts] = key.split(' ');
    const epPath = pathParts.join(' ');
    // Rename heuristic — same trailing segment, similar path.
    const rename = added.find((a) => {
      const [aMethod, ...aPathParts] = a.split(' ');
      if (aMethod !== method) return false;
      const aPath = aPathParts.join(' ');
      return sameTrailingSegment(aPath, epPath) || editDistance(aPath, epPath) <= 3;
    });
    if (rename) {
      const [, ...rPathParts] = rename.split(' ');
      result.renames.push({
        kind: 'endpoint',
        oldName: epPath,
        newName: rPathParts.join(' '),
        scope: 'backend',
        method,
      });
    }
    // Record the removed endpoint path as an identifier (for backend +
    // frontend grep — frontend fetches reference paths).
    result.removedIdentifiers.push({
      kind: 'endpoint',
      name: epPath,
      scope: 'backend',
      evidence: `${method} ${epPath} removed`,
    });
  }

  // Field-level diffs on endpoints present in both.
  for (const key of priorKeys) {
    if (!nextKeys.has(key)) continue;
    const before = priorEndpoints[key];
    const after = nextEndpoints[key];

    diffFields(before.requestFields, after.requestFields, 'requestField', key, result);
    diffFields(before.responseFields, after.responseFields, 'responseField', key, result);
  }
}

function collectEndpoints(api) {
  // Returns Map<"METHOD path", { requestFields: Map<name, type>, responseFields: ... }>
  const out = {};
  if (!api || typeof api !== 'object') return out;
  const endpoints = api.endpoints || api;
  const arr = Array.isArray(endpoints) ? endpoints : Object.values(endpoints);
  for (const ep of arr) {
    if (!ep || typeof ep !== 'object') continue;
    const method = String(ep.method || 'GET').toUpperCase();
    const epPath = ep.path || ep.route || '';
    if (!epPath) continue;
    out[`${method} ${epPath}`] = {
      requestFields: collectFields(ep.requestBody || ep.request || ep.requestFields),
      responseFields: collectFields(ep.responseBody || ep.response || ep.responseFields),
    };
  }
  return out;
}

function collectFields(spec) {
  const out = {};
  if (!spec) return out;
  if (Array.isArray(spec)) {
    for (const f of spec) {
      if (!f || typeof f !== 'object' || !f.name) continue;
      out[f.name] = String(f.type || '').toLowerCase();
    }
    return out;
  }
  if (typeof spec === 'object') {
    for (const [name, type] of Object.entries(spec)) {
      // Accept { name: 'fieldName', type: 'string' } as a value too.
      if (typeof type === 'object' && type && type.type) {
        out[name] = String(type.type).toLowerCase();
      } else {
        out[name] = String(type || '').toLowerCase();
      }
    }
  }
  return out;
}

function diffFields(before, after, kind, scopeContext, result) {
  for (const name of Object.keys(before)) {
    if (!(name in after)) {
      result.removedIdentifiers.push({
        kind,
        name,
        scope: 'backend',
        evidence: `${kind} ${name} removed from ${scopeContext}`,
      });
      continue;
    }
    if (before[name] !== after[name]) {
      result.removedIdentifiers.push({
        kind,
        name,
        scope: 'backend',
        evidence: `${kind} ${name} retyped on ${scopeContext}: ${before[name]} → ${after[name]}`,
      });
    }
  }
}

function sameTrailingSegment(a, b) {
  const aTail = a.split('/').filter(Boolean).pop();
  const bTail = b.split('/').filter(Boolean).pop();
  return Boolean(aTail) && aTail === bTail;
}

function editDistance(a, b) {
  // Levenshtein, bounded. Inputs short (URL paths); naive DP is fine.
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// ── ui_contract classifier ────────────────────────────────────────────────

function classifyUiContract(prior, next, result) {
  const priorComps = collectComponents(prior);
  const nextComps = collectComponents(next);

  const priorNames = new Set(Object.keys(priorComps));
  const nextNames = new Set(Object.keys(nextComps));
  const removed = [...priorNames].filter((n) => !nextNames.has(n));
  const added = [...nextNames].filter((n) => !priorNames.has(n));

  for (const rname of removed) {
    const rmComp = priorComps[rname];
    // Rename heuristic — same role text, different name.
    const renameTo = added.find((n) => {
      const a = nextComps[n];
      return a && rmComp && a.role && rmComp.role && a.role === rmComp.role;
    });
    if (renameTo) {
      result.renames.push({
        kind: 'component',
        oldName: rname,
        newName: renameTo,
        scope: 'frontend',
      });
    }
    result.removedIdentifiers.push({
      kind: 'component',
      name: rname,
      scope: 'frontend',
      evidence: `component ${rname} removed`,
    });
  }
}

function collectComponents(ui) {
  const out = {};
  if (!ui || typeof ui !== 'object') return out;
  const comps = ui.components || ui;
  const arr = Array.isArray(comps) ? comps : Object.values(comps);
  for (const c of arr) {
    if (!c || typeof c !== 'object' || !c.name) continue;
    out[c.name] = { role: c.role || c.purpose || '' };
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Grep — gripForIdentifiers (Addition 2)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Walk `workspaceDir` looking for occurrences of any identifier (or its
 * snake/camel/Pascal/kebab variants). Returns matches grouped by scope.
 *
 * Wall-clock bounded by CASCADE_GREP_TIMEOUT_MS via the `deadline` argument.
 * Walk is purely synchronous (cheap on typical user-app workspaces ~few
 * hundred files); deadline check happens between files to keep the cap
 * tight even on a slow disk.
 *
 * @param {string} workspaceDir       — user-app workspace root.
 * @param {Array<{name?: string, oldName?: string}>} identifiers
 * @param {number} [deadline]         — Date.now()-aligned millisecond cutoff.
 * @returns {{ matches: Map<scope, Match[]>, incomplete: boolean }}
 *
 *   Match shape: { file, scope, line, col, identifier, variant }
 */
export function gripForIdentifiers(workspaceDir, identifiers, deadline) {
  const matches = new Map();
  let incomplete = false;

  if (!workspaceDir || !existsSync(workspaceDir)) {
    return { matches, incomplete: false };
  }
  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    return { matches, incomplete: false };
  }

  // Build the variant list once. De-dup variants so the search loop is tight.
  const variantToOrigin = new Map();   // variant → first-seen identifier (with kind, name)
  for (const id of identifiers) {
    const base = id.oldName || id.name;
    if (!base) continue;
    for (const variant of identifierVariants(base)) {
      if (!variantToOrigin.has(variant)) {
        variantToOrigin.set(variant, { ...id, name: id.name || id.oldName });
      }
    }
  }

  const variants = [...variantToOrigin.keys()];
  if (variants.length === 0) return { matches, incomplete: false };

  // Walk synchronously. Each file: read, line-scan, accumulate matches.
  const files = [];
  try {
    walkWorkspace(workspaceDir, files, deadline);
  } catch (err) {
    if (err && err.message === '__cascade_deadline__') {
      incomplete = true;
    } else {
      logAndSwallow(err, '[cascade] walkWorkspace failed');
    }
  }

  for (const file of files) {
    if (deadline && Date.now() > deadline) {
      incomplete = true;
      break;
    }
    try {
      const rel = path.relative(workspaceDir, file);
      const scope = scopeForRelativePath(rel);
      if (!scope) continue;

      const contents = readFileSync(file, 'utf-8');
      const lines = contents.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        for (const variant of variants) {
          const col = findWholeWordIndex(line, variant);
          if (col === -1) continue;
          // Found a match. Tag with origin identifier metadata.
          const origin = variantToOrigin.get(variant);
          const m = {
            file: rel,
            scope,
            line: i + 1,
            col,
            identifier: origin?.name || variant,
            variant,
            kind: origin?.kind || null,
          };
          if (!matches.has(scope)) matches.set(scope, []);
          matches.get(scope).push(m);
          break; // one match per line per identifier is enough for escalation
        }
      }
    } catch (err) {
      logAndSwallow(err, '[cascade] read+scan file failed');
    }
  }

  return { matches, incomplete };
}

function walkWorkspace(dir, out, deadline) {
  if (deadline && Date.now() > deadline) {
    const e = new Error('__cascade_deadline__');
    throw e;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logAndSwallow(err, '[cascade] readdir failed');
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Path-exclusion check (against the eventual relative form).
      if (isExcludedPath(full)) continue;
      walkWorkspace(full, out, deadline);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (!GREPPABLE_EXTENSIONS.has(ext)) continue;
      if (isExcludedPath(full)) continue;
      out.push(full);
    }
  }
}

function isExcludedPath(absPath) {
  // Normalize to forward slashes so the segment checks work on macOS/Linux.
  const norm = absPath.replace(/\\/g, '/') + '/';
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (norm.includes(seg)) return true;
  }
  return false;
}

function scopeForRelativePath(rel) {
  if (!rel || rel.startsWith('..')) return null;
  const norm = rel.replace(/\\/g, '/');
  const top = norm.split('/')[0];
  return SCOPE_BY_TOP_DIR[top] || null;
}

function isCommentLine(line) {
  for (const re of COMMENT_LINE_PATTERNS) {
    if (re.test(line)) return true;
  }
  // Lines that are pure block-comment content (e.g. " * @param") already
  // match /^\s*\*/. Lines with /* or */ embedded: rough drop if the comment
  // marker appears BEFORE any non-space content.
  const trimmed = line.trimStart();
  if (BLOCK_COMMENT_OPEN.test(trimmed) && trimmed.indexOf('/*') < 4) {
    // The block-comment open marker appears at the very start — treat as comment.
    return true;
  }
  if (BLOCK_COMMENT_CLOSE.test(trimmed) && trimmed.indexOf('*/') === 0) {
    return true;
  }
  return false;
}

// Whole-word boundary match. Returns index or -1. Identifier-friendly boundary
// chars: anything not [A-Za-z0-9_$] terminates a word. (We DON'T treat `.` as
// a boundary because `user.full_name` should still match `full_name`.)
function findWholeWordIndex(line, needle) {
  if (!needle || !line) return -1;
  let from = 0;
  while (true) {
    const idx = line.indexOf(needle, from);
    if (idx === -1) return -1;
    const prev = idx === 0 ? '' : line[idx - 1];
    const next = idx + needle.length >= line.length ? '' : line[idx + needle.length];
    const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
    if (!isWordChar(prev) && !isWordChar(next)) return idx;
    from = idx + 1;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// analyzeCascade — entrypoint (Section G)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Top-level cascade analysis. Called from `dispatchIterate` BEFORE the
 * scope-shape branch.
 *
 * @param {object} args
 * @param {string} args.workspaceDir          — user-app workspace root.
 * @param {object} args.contractDiffs         — router-emitted contractDiffs
 *   keyed by section: { data_model?, api_contract?, ui_contract?, ... }
 * @param {string[]} args.affectedScopes      — router-emitted affected_scopes[]
 * @param {object} [args.priorContracts]      — `.harness/contracts.json` data
 *   (the `.data` payload, NOT the envelope). Used as the "before" state.
 * @returns {{
 *   originalScopes: string[],
 *   escalatedScopes: string[],         // scopes added by cascade (subset of finalScopes)
 *   finalScopes: string[],             // originalScopes ∪ escalatedScopes
 *   breakingDiffs: Array,              // per-section classifyDiff payloads
 *   escalationReasons: Array,          // human-readable + structured (per identifier)
 *   incomplete?: boolean,              // true when grep timed out
 * }}
 */
export function analyzeCascade({ workspaceDir, contractDiffs, affectedScopes, priorContracts }) {
  const originalScopes = Array.isArray(affectedScopes) ? [...affectedScopes] : [];
  const result = {
    originalScopes,
    escalatedScopes: [],
    finalScopes: [...originalScopes],
    breakingDiffs: [],
    escalationReasons: [],
  };

  try {
    // 1. Classify each section of the diff.
    const sectionKeys = ['data_model', 'api_contract', 'ui_contract', 'business_logic_contract', 'vector_engine'];
    const priorData = (priorContracts && priorContracts.data) || priorContracts || {};
    const allRemoved = [];   // flat list of identifiers to grep for

    for (const section of sectionKeys) {
      const nextSection = contractDiffs && (contractDiffs[section] || contractDiffs[toCamel(section)]);
      if (nextSection == null) continue;
      const priorSection = priorData[section] || priorData[toCamel(section)] || null;
      const classification = classifyDiff(priorSection, nextSection, section);
      if (classification.breaking) {
        result.breakingDiffs.push({ section, ...classification });
        for (const id of classification.removedIdentifiers) {
          allRemoved.push(id);
        }
        for (const rn of classification.renames) {
          // Search for the old name only — new name is presumably what the
          // user wants now; we care about leftover usages of the old name.
          allRemoved.push({ kind: rn.kind, name: rn.oldName, oldName: rn.oldName, newName: rn.newName, scope: rn.scope });
        }
      }
    }

    // 1b. Declared removals (remove_endpoints / remove_components verbs).
    //     The section classifiers above only see removal via whole-object
    //     replacement; an explicit remove_* entry never surfaces there, so a
    //     declared removal would dispatch without grepping for surviving
    //     call sites (e.g. api-client usage in a frontend the router forgot).
    const declared = collectDeclaredRemovals(contractDiffs);
    if (declared.length > 0) {
      result.breakingDiffs.push({ section: 'declared_removals', breaking: true, removedIdentifiers: declared, renames: [] });
      allRemoved.push(...declared);
    }

    // 2. If nothing breaking, no cascade.
    if (allRemoved.length === 0) {
      return result;
    }

    // 3. Run the grep with a wall-clock deadline.
    const deadline = Date.now() + CASCADE_GREP_TIMEOUT_MS;
    const { matches, incomplete } = gripForIdentifiers(workspaceDir, allRemoved, deadline);
    if (incomplete) {
      result.incomplete = true;
      return result;
    }

    // 4. Compute the escalation set: scopes with matches NOT already in
    //    originalScopes. Cap at the five subagent scopes.
    const originalSet = new Set(originalScopes);
    const escalatedSet = new Set();
    const reasonsByScope = new Map();
    for (const [scope, scopeMatches] of matches.entries()) {
      if (originalSet.has(scope)) continue;
      if (!SCOPE_BY_TOP_DIR[scope]) continue;
      if (scopeMatches.length === 0) continue;
      escalatedSet.add(scope);
      reasonsByScope.set(scope, scopeMatches);
    }

    if (escalatedSet.size === 0) {
      return result;
    }

    result.escalatedScopes = [...escalatedSet];
    result.finalScopes = [...new Set([...originalScopes, ...result.escalatedScopes])];

    // Build per-identifier escalation reasons. Aggregate {kind,name,foundInScopes[]}.
    const idIndex = new Map();   // identKey → reason entry
    for (const [scope, scopeMatches] of reasonsByScope) {
      for (const m of scopeMatches) {
        const key = `${m.kind || 'unknown'}::${m.identifier}`;
        if (!idIndex.has(key)) {
          // Find the rename (if any) for nicer display.
          const fromBreaking = result.breakingDiffs
            .flatMap((d) => d.renames || [])
            .find((r) => r.oldName === m.identifier);
          idIndex.set(key, {
            kind: m.kind,
            name: m.identifier,
            oldName: fromBreaking?.oldName,
            newName: fromBreaking?.newName,
            foundInScopes: [],
          });
        }
        const entry = idIndex.get(key);
        if (!entry.foundInScopes.includes(scope)) entry.foundInScopes.push(scope);
      }
    }
    result.escalationReasons = [...idIndex.values()];
  } catch (err) {
    logAndSwallow(err, '[cascade] analyzeCascade threw — returning no-escalation');
    return {
      originalScopes,
      escalatedScopes: [],
      finalScopes: [...originalScopes],
      breakingDiffs: [],
      escalationReasons: [],
    };
  }

  return result;
}

function toCamel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Pull explicit remove_endpoints / remove_components entries out of a diff in
 * either dialect (scope-keyed `{backend: {remove_endpoints}}` or kind-keyed
 * `{api_contract: {remove_endpoints}}`) as grep-ready removed identifiers.
 * Malformed entries are skipped — cascade stays best-effort.
 */
export function collectDeclaredRemovals(contractDiffs) {
  const out = [];
  if (!contractDiffs || typeof contractDiffs !== 'object') return out;
  const containers = [
    contractDiffs,
    ...Object.values(contractDiffs).filter((v) => v && typeof v === 'object' && !Array.isArray(v)),
  ];
  for (const c of containers) {
    for (const r of Array.isArray(c.remove_endpoints) ? c.remove_endpoints : []) {
      const method = typeof r === 'string' ? r.split(' ')[0] : r?.method;
      const epPath = typeof r === 'string' ? r.split(' ').slice(1).join(' ') : r?.path;
      if (typeof epPath !== 'string' || !epPath) continue;
      out.push({
        kind: 'endpoint',
        name: epPath,
        scope: 'backend',
        evidence: `${String(method || '').toUpperCase()} ${epPath} declared removed`,
      });
    }
    for (const r of Array.isArray(c.remove_components) ? c.remove_components : []) {
      const name = typeof r === 'string' ? r : r?.name;
      if (typeof name !== 'string' || !name) continue;
      out.push({
        kind: 'component',
        name,
        scope: 'frontend',
        evidence: `component ${name} declared removed`,
      });
    }
  }
  return out;
}
