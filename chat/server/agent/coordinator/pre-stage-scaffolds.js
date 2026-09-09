/**
 * pre-stage-scaffolds.js — orchestrates the deterministic file emission
 * that happens BEFORE subagents dispatch on a fresh build.
 *
 * Replaces what subagents used to write from scratch:
 *   - backend/src/generated/contracts.ts    (TS row/request/response types)
 *   - backend/src/lib/vector-search.ts       (when vector_engine=pgvector)
 *   - backend/src/lib/embed.ts               (when ai-rag flag set)
 *   - backend/src/lib/auth.ts                (when identity headers in rules)
 *   - backend/src/lib/mga-client.ts          (when ai-chat flag / mgaAssistants;
 *                                             .py variant for Python backends)
 *   - frontend/src/generated/contracts.ts    (mirror of backend's, fe scope)
 *   - frontend/src/generated/api-client.ts   (typed fetch wrappers)
 *   - frontend/src/components/<Name>.tsx     (one stub per ui_contract component)
 *   - database/init/01_schema.sql            (full CREATE TABLE + indexes)
 *   - database/Dockerfile                    (canonical copy — never LLM-written)
 *
 * Only fires on FRESH builds (`isIterate === false`). Iterate path keeps the
 * existing LLM dispatch unchanged until iterate-mode wiring lands.
 *
 * Returns a manifest of what was emitted + which scopes can be skipped from
 * dispatch (currently: database, when its schema + Dockerfile were both
 * emitted deterministically).
 *
 * All failures are telemetry-class (logAndSwallow) — a generator hiccup
 * must not block the build. The subagent path is the fallback.
 */

import fs from 'node:fs';
import path from 'node:path';
import { tlog } from '../../util/timestamped-log.js';
import { logAndSwallow } from '../../util/log-helpers.js';
import { WORKSPACE_DIR, CHAT_APP_DIR } from '../../core/paths.js';
import { emitTsContracts } from '../contract-types-generator.js';
import { generateApiClient } from './api-client-generator.js';
import { generateSchema } from './schema-generator.js';
import { generateReferenceData, REFERENCE_DATA_FILE } from './reference-data-generator.js';
import { generateIterateMigration } from './iterate-migration-generator.js';
import { generateVectorSearchHelper } from './vector-search-helper-generator.js';
import { generateVectordbInit, generateVectordbSearchHelper, synthesizeVectordbReport } from './vectordb-scaffold-generator.js';
import { generateEmbedHelper } from './embed-helper-generator.js';
import { generateAuthHelper } from './auth-helper-generator.js';
import { generateMgaClient } from './mga-client-generator.js';
import { generateDevRoleSwitcher } from './dev-role-switcher-generator.js';
import { generateErrorBoundary } from './error-boundary-generator.js';
import { stageFrontendKit } from './frontend-kit-generator.js';
import { generateOidcIdentity } from './oidc-identity-generator.js';
import { LOCAL_DB_CREDENTIALS } from '../../config/defaults.js';

// Project root for canonical templates — CHAT_APP_DIR is .../chat, so up one
// gets us the template repo root. The canonical Postgres Dockerfile lives at
// the component root (`database/Dockerfile.postgres`), whitelisted in
// .template-manifest.yml so it survives Clean.
const PROJECT_ROOT = path.resolve(CHAT_APP_DIR, '..');
const CANONICAL_DB_DOCKERFILE = path.join(PROJECT_ROOT, 'database', 'Dockerfile.postgres');
// Migration runner staged into every Node backend that has a database, so an
// iterate only has to drop backend/migrations/NNN_*.sql — the same runner
// applies it locally and in production (the Dockerfile ships migrations/).
const CANONICAL_MIGRATION_RUNNER = path.join(PROJECT_ROOT, 'snippets', 'database', 'migration-runner.ts');
export const MIGRATION_RUNNER_PATH = 'backend/src/lib/migrate.ts';

/**
 * Run every contract-driven generator that applies to this contract, write
 * the emitted files into the workspace, and return what got emitted.
 *
 * @param {object} args
 * @param {string} args.workspaceDir
 * @param {object} args.contract - { dataModel, apiContract, uiContract, vectorEngine, businessLogicContract, flags, mgaAssistants, tasks }
 * @param {boolean} args.isIterate
 * @returns {{
 *   filesEmitted: string[],
 *   files: Array<{relPath, content}>,  // full manifest with contents — surfaced into subagent user messages
 *   databaseHandled: boolean,         // true when schema + Dockerfile were both emitted
 *   databaseReport: string|null,      // synthesized PHASE AGENT REPORT for sibling injection
 *   scaffoldedComponents: string[],   // ui component names that got stubbed
 * }}
 */
export function preStageScaffolds({ workspaceDir, contract, isIterate, iterateDiffs = null, priorDataModel = null, iterateSummary = '' }) {
  const out = {
    filesEmitted: [],
    files: [],
    databaseHandled: false,
    databaseReport: null,
    vectordbHandled: false,
    vectordbReport: null,
    uiKitStaged: false,
    scaffoldedComponents: [],
  };
  if (isIterate) {
    const wdI = workspaceDir || WORKSPACE_DIR;
    // REGENERATE contract types + api-client from the (diff-merged) contract
    // before iterate agents spawn. build-dispatcher merges iterate-added
    // endpoints into contract.apiContract; without regeneration, new
    // endpoints have no generated types, so backend and frontend each invent
    // field names and drift (observed live twice: severity enum mismatch,
    // template_key/content vs module_type/prompt_text).
    try {
      if (contract && (contract.dataModel || contract.apiContract || contract.uiContract)) {
        const genEnvelope = {
          version: 1,
          data: {
            data_model: contract.dataModel || null,
            api_contract: contract.apiContract || null,
            ui_contract: contract.uiContract || null,
          },
        };
        const be = emitTsContracts(genEnvelope, { scope: 'backend' });
        const fe = emitTsContracts(genEnvelope, { scope: 'frontend' });
        writeFile(wdI, 'backend/src/generated/contracts.ts', be.source, out);
        writeFile(wdI, 'frontend/src/generated/contracts.ts', fe.source, out);
        if (contract.apiContract) {
          const client = generateApiClient(contract.apiContract);
          if (client) writeFile(wdI, 'frontend/src/generated/api-client.ts', client.source, out);
        }
        tlog('[pre-stage] iterate: regenerated contract types + api-client from merged contract (%d endpoint(s))',
          contract.apiContract?.endpoints?.length || 0);
      }
    } catch (err) {
      logAndSwallow(err, '[pre-stage] iterate contract regeneration failed');
    }

    // Also capture the CURRENT generated files into the manifest so iterate
    // agents see byte-exact type/wrapper names in their PRE-STAGED FILES
    // section. Without this, agents compose imports from imagination
    // (observed: routes.ts importing WhoamiResponse where the generated file
    // exports GETWhoamiResponse → tsc fails → failed iterate).
    const generatedPaths = [
      'backend/src/generated/contracts.ts',
      'backend/generated/models.py',
      'frontend/src/generated/contracts.ts',
      'frontend/src/generated/api-client.ts',
      'frontend/src/generated/DevRoleSwitcher.tsx',
      'frontend/src/generated/ErrorBoundary.tsx',
      'backend/src/lib/oidc-identity.ts',
      'backend/src/oidc_identity.py',
      'backend/src/lib/mga-client.ts',
      'backend/src/mga_client.py',
      'backend/src/lib/vector-search.ts',
      'backend/src/lib/embed.ts',
      MIGRATION_RUNNER_PATH,
    ];
    const wdIter = wdI;
    // Apps built before the runner existed get it on their first iterate —
    // the backend agent is told to `await runMigrations(pool)` and needs the
    // file to import.
    const runnerStaged = safeRun(() => stageMigrationRunner(wdIter, contract, out), '[pre-stage] migration runner staging failed');
    // Purely additive schema changes (new tables, new nullable/defaulted
    // columns) become a migration file deterministically — same idea as the
    // fresh-build schema generator. Anything with a rename, drop, type change
    // or NOT NULL backfill is left entirely to the backend agent.
    if (runnerStaged && priorDataModel) {
      const mig = safeRun(() => generateIterateMigration({
        priorDataModel,
        dataModel: contract?.dataModel,
        iterateDiffs,
        existingFiles: listMigrationFiles(wdIter),
        summary: iterateSummary,
      }), '[pre-stage] iterate migration generation failed');
      if (mig && !fs.existsSync(path.join(wdIter, mig.relPath))) {
        writeFile(wdIter, mig.relPath, mig.source, out);
        tlog('[pre-stage] iterate migration staged at %s (%s)', mig.relPath, mig.describe);
      } else if (mig === null) {
        tlog('[pre-stage] iterate schema change not purely additive (or none) — migration left to the backend agent');
      }
    }
    for (const rel of generatedPaths) {
      if (out.filesEmitted.includes(rel)) continue; // regenerated above
      const abs = path.join(wdIter, rel);
      if (!fs.existsSync(abs)) continue;
      try {
        const content = fs.readFileSync(abs, 'utf-8');
        out.filesEmitted.push(rel);
        out.files.push({ relPath: rel, content });
      } catch (err) {
        logAndSwallow(err, `[pre-stage] iterate capture failed for ${rel}`);
      }
    }
    tlog('[pre-stage] iterate mode — no writes; captured %d generated file(s) for spawn messages',
      out.filesEmitted.length);
    return out;
  }
  if (!contract) return out;

  const wd = workspaceDir || WORKSPACE_DIR;

  // ── 1. Shared: emit contracts.ts for backend + frontend ─────────────
  // Pre-dispatch emission means subagents can `import type { ... }` from
  // the generated file. Today's post-dispatch type-gen still runs as
  // belt-and-braces.
  if (contract.dataModel || contract.apiContract || contract.uiContract) {
    try {
      const envelope = {
        version: 1,
        data: {
          data_model: contract.dataModel || null,
          api_contract: contract.apiContract || null,
          ui_contract: contract.uiContract || null,
        },
      };
      const be = emitTsContracts(envelope, { scope: 'backend' });
      const fe = emitTsContracts(envelope, { scope: 'frontend' });
      writeFile(wd, 'backend/src/generated/contracts.ts', be.source, out);
      writeFile(wd, 'frontend/src/generated/contracts.ts', fe.source, out);
    } catch (err) {
      logAndSwallow(err, '[pre-stage] contracts.ts emission failed');
    }
  }

  // ── 2. Backend: conditional helpers only — NO routes.ts scaffold ─────
  // Experiment (2026-05-22): backend writes `routes.ts` from scratch
  // instead of editing a pre-staged stub. The scaffold-and-find-replace
  // workflow was empirically fragile — the LLM treated the stub as
  // decorative, composed replace_in_file SEARCH from imagination
  // (training-data prior, not disk), and spiralled through 19+ failed
  // turns trying to land edits. Letting `write_to_file` create the file
  // fresh aligns with the LLM's stronger training prior and removes the
  // SEARCH/disk mismatch failure mode. Conditional helpers below
  // (vector-search, embed, auth) stay pre-staged — they're tiny utility
  // shims, not the file the LLM was failing to edit.
  // Vector search: with a dedicated vectordb service the two-instance helper
  // is emitted from the SAME schema as vectordb/init (see § 4b) so backend
  // and vectordb cannot drift on the chunk table name. The single-instance
  // (same-DB join) variant remains for contracts without a vectordb scope.
  const hasVectordbTask = Array.isArray(contract.tasks)
    && contract.tasks.some((t) => t && t.scope === 'vectordb');
  try {
    const vec = hasVectordbTask
      ? generateVectordbSearchHelper(contract)
      : generateVectorSearchHelper(contract);
    if (vec) writeFile(wd, 'backend/src/lib/vector-search.ts', vec.source, out);
  } catch (err) { logAndSwallow(err, '[pre-stage] vector-search helper failed'); }

  try {
    const embed = generateEmbedHelper(contract);
    if (embed) writeFile(wd, 'backend/src/lib/embed.ts', embed.source, out);
  } catch (err) { logAndSwallow(err, '[pre-stage] embed helper failed'); }

  try {
    const auth = generateAuthHelper(contract);
    if (auth) writeFile(wd, 'backend/src/lib/auth.ts', auth.source, out);
  } catch (err) { logAndSwallow(err, '[pre-stage] auth helper failed'); }

  // Identity-parsing semantics are fully known — pre-stage the locked
  // parser so devMode/role-claim handling can't drift per app.
  try {
    const oidc = generateOidcIdentity(contract);
    if (oidc) writeFile(wd, oidc.relPath, oidc.source, out);
  } catch (err) { logAndSwallow(err, '[pre-stage] oidc identity failed'); }

  // The MGA transport is fully known ahead of time — pre-stage it so the
  // backend subagent imports it instead of hand-rolling a client (hallucinated
  // hostnames / missing Bearer auth were the top AI-app failure mode).
  try {
    const mga = generateMgaClient(contract);
    if (mga) {
      writeFile(wd, mga.relPath, mga.source, out);
      tlog('[pre-stage] mga client staged at %s', mga.relPath);
    }
  } catch (err) { logAndSwallow(err, '[pre-stage] mga client failed'); }

  // ── 2b. Backend: migration runner (any Node backend with a database) ──
  safeRun(() => stageMigrationRunner(wd, contract, out), '[pre-stage] migration runner staging failed');

  // ── 3. Frontend: api-client.ts + component stubs ─────────────────────
  if (contract.apiContract && Array.isArray(contract.apiContract.endpoints) && contract.apiContract.endpoints.length > 0) {
    try {
      const client = generateApiClient(contract.apiContract);
      if (client) writeFile(wd, 'frontend/src/generated/api-client.ts', client.source, out);
    } catch (err) { logAndSwallow(err, '[pre-stage] api-client failed'); }

    // Local-dev persona switcher — renders nothing in production or
    // single-role apps, so emitting it is always safe. See the generator
    // header + reference/user-identity.md for the trust model.
    try {
      const switcher = generateDevRoleSwitcher(contract.apiContract);
      if (switcher) writeFile(wd, 'frontend/src/generated/DevRoleSwitcher.tsx', switcher.source, out);
    } catch (err) { logAndSwallow(err, '[pre-stage] dev-role-switcher failed'); }

    // Render-crash containment: a readable error card instead of a blank page.
    try {
      const boundary = generateErrorBoundary(contract.apiContract);
      if (boundary) writeFile(wd, 'frontend/src/generated/ErrorBoundary.tsx', boundary.source, out);
    } catch (err) { logAndSwallow(err, '[pre-stage] error-boundary failed'); }

    // UI kit: styled primitives + app shell, staged once, composed by the
    // agent. Kills the ~10 hand-rolled ui/ components per build (speed) and
    // makes every generated app look consistent (quality). Contents are NOT
    // inlined into the spawn — the catalog section carries the API surface.
    try {
      const kitFiles = stageFrontendKit(wd);
      if (kitFiles) {
        out.filesEmitted.push(...kitFiles);
        out.uiKitStaged = true;
        tlog('[pre-stage] ui kit staged (%d files) at frontend/src/generated/kit/', kitFiles.length);
      }
    } catch (err) { logAndSwallow(err, '[pre-stage] ui kit failed'); }
  }

  // Component stubs were removed on 2026-05-22 alongside the backend routes.ts
  // scaffold. Same rationale (see § 2 above): the LLM treated stubs as
  // decorative, composed replace_in_file SEARCH from training-data priors,
  // and burned 8+ turns per component recovering from SEARCH mismatches.
  // Frontend now authors `src/components/<Name>.tsx` from scratch using
  // positive per-component specs in the subagent-frontend.md prompt.
  // The ghost-import validator still auto-stubs anything the LLM missed.

  // ── 4. Database: schema + Dockerfile (retires the subagent dispatch on fresh) ──
  if (contract.dataModel && Array.isArray(contract.dataModel.tables) && contract.dataModel.tables.length > 0) {
    const schema = safeRun(() => generateSchema(contract), '[pre-stage] schema-generator failed');
    const dockerCopied = safeRun(() => copyDockerfile(wd, out), '[pre-stage] db Dockerfile copy failed');
    if (schema && dockerCopied) {
      writeFile(wd, 'database/init/01_schema.sql', schema.source, out);
      // Reference tables (acted on via :id routes, never created by the API)
      // get placeholder rows — nothing else would ever populate them and the
      // planner's "seed N sample rows" prose has no reader on fresh builds.
      const referenceData = safeRun(() => generateReferenceData(contract), '[pre-stage] reference-data-generator failed');
      if (referenceData) {
        writeFile(wd, REFERENCE_DATA_FILE, referenceData.source, out);
        tlog('[pre-stage] reference data staged for %s', referenceData.seeded.map((s) => s.table).join(', '));
        for (const s of referenceData.skipped) tlog('[pre-stage] reference table %s not seeded: %s', s.table, s.reason);
      }
      out.databaseHandled = true;
      out.databaseReport = synthesizeDatabaseReport(contract, schema.tableNames || [], referenceData?.seeded || []);
      tlog('[pre-stage] database fully scaffolded (schema + Dockerfile); subagent dispatch will be skipped');
    } else {
      // Partial — let the database subagent take over rather than ship half-staged state.
      tlog('[pre-stage] database partial scaffold (schema=%s, dockerfile=%s) — falling back to subagent dispatch',
        !!schema, !!dockerCopied);
    }
  }

  // ── 4b. Vectordb: init.sql (retires the vectordb subagent dispatch) ──
  // The scope's whole content is a pgvector Dockerfile (staged by routes.js,
  // captured in § 5) + one init.sql derived from the contract — nothing an
  // LLM needs to invent. Emitting it here kills the cross-scope table-name
  // drift AND the vectordb agent's no-tool-call stall, both observed live.
  if (hasVectordbTask) {
    try {
      const init = generateVectordbInit(contract);
      const dockerfileStaged = fs.existsSync(path.join(wd, 'vectordb/Dockerfile'));
      if (init && dockerfileStaged) {
        writeFile(wd, 'vectordb/init/01_init.sql', init.source, out);
        out.vectordbHandled = true;
        out.vectordbReport = synthesizeVectordbReport(contract);
        tlog('[pre-stage] vectordb fully scaffolded (init.sql tables=[%s]%s); subagent dispatch will be skipped',
          init.tableNames.join(','), init.canonical ? ' canonical' : '');
      } else {
        tlog('[pre-stage] vectordb partial scaffold (init=%s, dockerfile=%s) — falling back to subagent dispatch',
          !!init, dockerfileStaged);
      }
    } catch (err) { logAndSwallow(err, '[pre-stage] vectordb scaffold failed'); }
  }

  // ── 5. Capture infra pre-staged by routes.js (Dockerfile + nginx) ────
  // session/routes.js writes these BEFORE runBuildDispatch fires. They are
  // platform-mandated and must not be authored by the LLM — they need a
  // specific base image (`dd-kitchen-sink:local`) and a multi-stage shape
  // the model won't infer from training data. Surfacing their content via
  // the PRE-STAGED FILES manifest gives the LLM both the existence signal
  // and the exact bytes so it knows there's nothing to write — and if it
  // ever does decide to edit, it has a verbatim SEARCH source.
  const infraPaths = [
    'backend/Dockerfile',
    'frontend/Dockerfile',
    'frontend/nginx.conf',
    'frontend/nginx.local.conf',
    'vectordb/Dockerfile',
    // database/Dockerfile already captured by copyDockerfile() above
  ];
  for (const rel of infraPaths) {
    const abs = path.join(wd, rel);
    if (!fs.existsSync(abs)) continue;
    if (out.filesEmitted.includes(rel)) continue; // already captured
    try {
      const content = fs.readFileSync(abs, 'utf-8');
      out.filesEmitted.push(rel);
      out.files.push({ relPath: rel, content });
    } catch (err) {
      logAndSwallow(err, `[pre-stage] failed to capture infra file ${rel}`);
    }
  }

  tlog('[pre-stage] emitted %d file(s); databaseHandled=%s; components=[%s]',
    out.filesEmitted.length, out.databaseHandled, out.scaffoldedComponents.join(','));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function writeFile(workspaceDir, relPath, content, out) {
  const full = path.join(workspaceDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  out.filesEmitted.push(relPath);
  out.files.push({ relPath, content });
}

function safeRun(fn, msg) {
  try { return fn(); }
  catch (err) { logAndSwallow(err, msg); return null; }
}

/**
 * Copy snippets/database/migration-runner.ts to backend/src/lib/migrate.ts
 * when the app has a database and a Node backend. Never overwrites — an
 * app that already carries the runner keeps its copy. Returns true when
 * the file is present afterwards.
 */
function stageMigrationRunner(workspaceDir, contract, out) {
  const tables = contract?.dataModel?.tables;
  const tasks = Array.isArray(contract?.tasks) ? contract.tasks : [];
  const hasDatabase = (Array.isArray(tables) && tables.length > 0) || tasks.some((t) => t && t.scope === 'database');
  const pythonBackend = tasks.some((t) => t && t.scope === 'backend' && /python/i.test(String(t.dockerfile || '')));
  if (!hasDatabase || pythonBackend) return false;
  const dest = path.join(workspaceDir, MIGRATION_RUNNER_PATH);
  if (fs.existsSync(dest)) return true;
  if (!fs.existsSync(CANONICAL_MIGRATION_RUNNER)) {
    tlog('[pre-stage] migration runner snippet missing at %s — skipping', CANONICAL_MIGRATION_RUNNER);
    return false;
  }
  writeFile(workspaceDir, MIGRATION_RUNNER_PATH, fs.readFileSync(CANONICAL_MIGRATION_RUNNER, 'utf-8'), out);
  tlog('[pre-stage] migration runner staged at %s', MIGRATION_RUNNER_PATH);
  return true;
}

function listMigrationFiles(workspaceDir) {
  try {
    return fs.readdirSync(path.join(workspaceDir, 'backend', 'migrations')).filter((f) => f.endsWith('.sql'));
  } catch { return []; }
}

function copyDockerfile(workspaceDir, out) {
  if (!fs.existsSync(CANONICAL_DB_DOCKERFILE)) {
    tlog('[pre-stage] canonical Dockerfile missing at %s — skipping copy', CANONICAL_DB_DOCKERFILE);
    return false;
  }
  const dest = path.join(workspaceDir, 'database', 'Dockerfile');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(CANONICAL_DB_DOCKERFILE, dest);
  // Capture content in the manifest so the inlined `=== PRE-STAGED FILES ===`
  // block in subagent user messages shows the LLM what's on disk.
  if (out) {
    try {
      const content = fs.readFileSync(CANONICAL_DB_DOCKERFILE, 'utf-8');
      out.filesEmitted.push('database/Dockerfile');
      out.files.push({ relPath: 'database/Dockerfile', content });
    } catch (err) {
      logAndSwallow(err, '[pre-stage] could not read canonical Dockerfile for manifest');
    }
  }
  return true;
}

/**
 * Build a PHASE AGENT REPORT block in the canonical format for the database
 * scope, sourced from the contract. Backend/integration subagents read this
 * via `=== COMPLETED: DATABASE ===` injection from the orchestration stash,
 * so they need the same shape they'd get from a real subagent run.
 */
function synthesizeDatabaseReport(contract, tableNames, seeded = []) {
  const tables = contract?.dataModel?.tables || [];
  const lines = [];
  lines.push('--- PHASE AGENT REPORT ---');
  lines.push('');
  lines.push('**Scope:** database');
  lines.push('');
  lines.push('**Status:** complete');
  lines.push('');
  lines.push('**Files written:**');
  lines.push('- database/init/01_schema.sql');
  if (seeded.length) lines.push(`- ${REFERENCE_DATA_FILE}`);
  lines.push('- database/Dockerfile');
  lines.push('');
  lines.push('**Summary:**');
  lines.push('');
  const tableList = tableNames.length > 0 ? tableNames.join(', ') : (tables.map(t => t.name).join(', ') || '(none)');
  lines.push(`Schema pre-staged deterministically from the data_model contract. Tables created in topological order: ${tableList}. Foreign-key references and ON DELETE behaviors preserved verbatim from the contract; conventional indexes added on FK columns and \`created_at\` (DESC). ${contract?.vectorEngine === 'pgvector' ? 'pgvector extension enabled; HNSW cosine indexes on every VECTOR column.' : ''}`.trim());
  if (seeded.length) {
    lines.push('');
    lines.push(`Reference tables pre-seeded with ${seeded[0].rows} placeholder rows each (SERIAL ids start at 1; inserted only when the table is empty): ${seeded.map((s) => `\`${s.table}\` (${s.columns.join(', ') || 'defaults'})`).join(', ')}. These tables have no create route in the API contract — routes that take their :id can rely on those rows existing.`);
  }
  lines.push('');
  lines.push('**Contracts for sibling scopes:**');
  lines.push('');
  lines.push('**Tables:**');
  for (const t of tables) {
    const cols = (t.columns || []).map(c => `${c.name} (${c.type})`).join(', ');
    lines.push(`- \`${t.name}\` — ${cols}`);
  }
  lines.push('');
  // Database connection identity is a FIXED platform constant — NOT chosen per
  // project. Emit the concrete values (not "set by integration" placeholders)
  // so the integration + backend agents wire identical creds on both services.
  // Renaming the db/user to the project name is the #1 cause of backend↔db
  // auth failures on fresh builds. (The credential-consistency validator
  // enforces this deterministically before compose up as a backstop.)
  const db = LOCAL_DB_CREDENTIALS;
  lines.push('**Database connection — FIXED platform values. Use these EXACTLY; do NOT rename');
  lines.push('the database or user to the project. Wire IDENTICAL values on BOTH the db');
  lines.push('service (POSTGRES_*) and the backend service (DATABASE_*):**');
  lines.push(`- \`DATABASE_HOST=${db.host}\``);
  lines.push(`- \`DATABASE_PORT=${db.port}\``);
  lines.push(`- \`DATABASE_NAME=${db.name}\`  ⇔  \`POSTGRES_DB=${db.name}\``);
  lines.push(`- \`DATABASE_USER=${db.user}\`  ⇔  \`POSTGRES_USER=${db.user}\``);
  lines.push(`- \`DATABASE_PASSWORD=${db.password}\`  ⇔  \`POSTGRES_PASSWORD=${db.password}\``);
  lines.push('');
  lines.push('**Ports:** `database:5432`');
  lines.push('');
  lines.push('--- END REPORT ---');
  return lines.join('\n');
}
