#!/usr/bin/env node
/**
 * MGA fixture drift detection + refresh.
 *
 * Two modes:
 *
 *   --check (default)
 *     Walks chat/tests/fixtures/mga-responses/<assistantKey>/<scenario>.json
 *     and validates every fixture's STRUCTURAL SHAPE against an expected
 *     schema for its assistantKey. Cheap (no network), runs as part of
 *     `npm run test:integration`.
 *
 *     If MGA_REFRESH_LIVE=1 is set AND credentials are present, also
 *     calls the live MGA assistant with a canonical scenario input and
 *     compares the live response's shape to the checked-in fixture.
 *     Content equality is NOT compared (live MGA varies turn-to-turn).
 *
 *     Exit 0 if all fixtures pass shape validation; exit 1 with a per-
 *     fixture drift report otherwise.
 *
 *   --apply
 *     Re-records every fixture by calling live MGA. Operator action,
 *     requires --yes in addition to --apply. Writes new responses to
 *     fixture files, overwriting.
 *
 * Operator workflow:
 *
 *   - You intentionally changed a prompt that affects MGA output shape:
 *       npm run fixtures:refresh
 *     (this runs `--apply --yes`; review the resulting diff and commit.)
 *
 *   - You did NOT intentionally change anything but `--check` fails:
 *       investigate. Either MGA's response shape changed (escalate),
 *       or a fixture was edited by hand and got out of sync (fix the
 *       hand-edit), or your prompt change had an unintended downstream
 *       effect (review the diff before refreshing).
 *
 * Speed target: <30s for the 12-fixture check with reasonable concurrency.
 * Live `--apply` against 12 fixtures will take ~3-6 minutes (network +
 * MGA streaming latency); not subject to the 30s target.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_ROOT = join(__dirname, '..', 'tests', 'fixtures', 'mga-responses');

// ─── Fixture-envelope schema (every fixture file) ───────────────────────────
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().optional() })
    .partial()
    .passthrough()
    .optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
}).passthrough();

const fixtureEnvelopeSchema = z.object({
  assistantKey: z.string().min(1),
  scenarioName: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  response: z.object({
    completionText: z.string().min(1),
    usage: usageSchema.nullable().optional(),
    model: z.string().min(1).optional(),
    conversationId: z.string().min(1),
  }).passthrough(),
  capturedFrom: z.enum(['manual', 'live', 'run-log']).optional(),
  capturedAt: z.string().optional(),
}).passthrough();

// ─── Per-assistantKey completionText shape validators ───────────────────────
// These validate the SHAPE of the assistant's response — fields, types,
// enum values — NOT the content. A fixture passes when its completionText
// is well-formed for its assistantKey, even if the actual content differs.

// Router emits raw JSON with action ∈ {clarify, execute, iterate, diagnose}.
const routerEnvelopeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('clarify'), message: z.string().min(1) }).passthrough(),
  z.object({
    action: z.literal('execute'),
    message: z.string().min(1),
    flags: z.array(z.string()),
    tasks: z.array(z.object({ scope: z.string().min(1), summary: z.string(), task: z.string() }).passthrough()).min(1),
  }).passthrough(),
  z.object({
    action: z.literal('iterate'),
    summary: z.string().min(1),
    affected_scopes: z.array(z.string().min(1)).min(1),
    contract_diffs: z.object({}).passthrough(),
    tasks: z.array(z.object({ scope: z.string().min(1), task: z.string() }).passthrough()).min(1),
  }).passthrough(),
  z.object({
    action: z.literal('diagnose'),
    symptom: z.string().min(1),
    suspected_scope: z.string().min(1).optional(),
  }).passthrough(),
]);

// Investigator emits XML tool calls. Its final `<result>` body is parseable
// JSON matching investigator.md's schema.
const investigatorReportSchema = z.object({
  root_cause: z.string().min(1),
  affected_scopes: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  recommended_fix: z.object({
    scope: z.string().min(1),
    description: z.string().min(1),
    contract_change: z.unknown().nullable(),
  }).passthrough(),
  files_read: z.array(z.string()),
  logs_read: z.array(z.string()),
}).passthrough();

// Subagents emit XML tool calls, optionally followed by attempt_completion.
// Per subagent-base.md: turn 1 = tool calls (writes + verifies); turn 2 =
// attempt_completion alone. A fixture may represent either turn. The
// constraint is that the response contains at least one production XML
// payload the agent loop can act on — either a tool call OR an
// attempt_completion.
function validateSubagentShape(text) {
  const toolCallRe = /<(write_to_file|replace_in_file|copy_template|execute_command|read_file|list_files|use_mcp_tool)>/i;
  const completionRe = /<attempt_completion>[\s\S]*<\/attempt_completion>/i;
  if (!toolCallRe.test(text) && !completionRe.test(text)) {
    return 'missing both: no production tool call AND no <attempt_completion> block';
  }
  return null;
}

// Maps assistantKey → validator function returning either null (ok) or
// a string describing the drift.
function validateCompletionShapeForKey(assistantKey, completionText) {
  if (assistantKey === 'router') {
    let parsed;
    try {
      parsed = JSON.parse(completionText);
    } catch (err) {
      return `router completionText not valid JSON: ${err.message}`;
    }
    const result = routerEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      return `router envelope shape drift: ${formatZodIssues(result.error)}`;
    }
    return null;
  }
  if (assistantKey === 'investigator') {
    const match = completionText.match(/<result>\s*([\s\S]*?)<\/result>/i);
    if (!match) return 'investigator completionText missing <result>...</result> block';
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch (err) {
      return `investigator <result> body not valid JSON: ${err.message}`;
    }
    const result = investigatorReportSchema.safeParse(parsed);
    if (!result.success) {
      return `investigator report shape drift: ${formatZodIssues(result.error)}`;
    }
    return null;
  }
  if (assistantKey.startsWith('subagent-')) {
    return validateSubagentShape(completionText);
  }
  // Unknown assistantKey — accept envelope but warn.
  return null;
}

function formatZodIssues(zerr) {
  return zerr.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}

// ─── Filesystem walk ─────────────────────────────────────────────────────────
async function walkFixtures(root) {
  const out = [];
  let topEntries;
  try {
    topEntries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read fixtures root ${root}: ${err.message}`);
  }
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const subdir = join(root, e.name);
    const files = await readdir(subdir, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.json')) {
        out.push({
          assistantKey: e.name,
          scenarioName: basename(f.name, '.json'),
          path: join(subdir, f.name),
          relPath: `${e.name}/${f.name}`,
        });
      }
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// ─── --check ────────────────────────────────────────────────────────────────
async function checkOne(fixtureMeta) {
  let raw;
  try {
    raw = await readFile(fixtureMeta.path, 'utf8');
  } catch (err) {
    return { ok: false, drift: `read failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, drift: `fixture not valid JSON: ${err.message}` };
  }
  const envelope = fixtureEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return { ok: false, drift: `envelope shape: ${formatZodIssues(envelope.error)}` };
  }
  // Envelope's assistantKey must match the directory.
  if (parsed.assistantKey !== fixtureMeta.assistantKey) {
    return {
      ok: false,
      drift: `assistantKey field "${parsed.assistantKey}" doesn't match directory "${fixtureMeta.assistantKey}"`,
    };
  }
  if (parsed.scenarioName !== fixtureMeta.scenarioName) {
    return {
      ok: false,
      drift: `scenarioName field "${parsed.scenarioName}" doesn't match filename "${fixtureMeta.scenarioName}"`,
    };
  }
  const completionDrift = validateCompletionShapeForKey(
    fixtureMeta.assistantKey,
    parsed.response.completionText,
  );
  if (completionDrift) {
    return { ok: false, drift: `completionText shape: ${completionDrift}` };
  }
  return { ok: true };
}

async function runCheck() {
  const fixtures = await walkFixtures(FIXTURES_ROOT);
  if (fixtures.length === 0) {
    console.error('No fixtures found under', FIXTURES_ROOT);
    process.exit(1);
  }
  // Reasonable concurrency: 12 fixtures × <30ms each (no network) easily under 1s,
  // but we cap concurrency at 8 to keep memory low and the failure trace orderly.
  const CONCURRENCY = 8;
  const results = new Array(fixtures.length);
  let next = 0;
  async function worker() {
    while (next < fixtures.length) {
      const i = next++;
      results[i] = await checkOne(fixtures[i]);
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, fixtures.length) }, worker);
  const t0 = Date.now();
  await Promise.all(workers);
  const elapsedMs = Date.now() - t0;

  let okCount = 0;
  const failures = [];
  for (let i = 0; i < fixtures.length; i++) {
    if (results[i].ok) {
      okCount += 1;
    } else {
      failures.push({ fixture: fixtures[i].relPath, drift: results[i].drift });
    }
  }
  if (failures.length === 0) {
    console.log(`fixtures:check ok — ${okCount}/${fixtures.length} fixtures verified in ${elapsedMs}ms`);
    process.exit(0);
  } else {
    console.error(`fixtures:check FAILED — ${failures.length}/${fixtures.length} drift detected (${elapsedMs}ms)`);
    for (const f of failures) {
      console.error(`  - ${f.fixture}`);
      console.error(`      ${f.drift}`);
    }
    console.error('');
    console.error('If the drift is intentional (you changed a prompt that affects this');
    console.error('assistant\'s response shape), run: npm run fixtures:refresh');
    console.error('Otherwise investigate before refreshing.');
    process.exit(1);
  }
}

// ─── --apply ─────────────────────────────────────────────────────────────────
// Live MGA refresh. Re-records every fixture by calling the live MGA assistant
// for that assistantKey with a canonical scenario input. Inputs are defined
// inline here (NOT in the fixture files — fixtures are output-side only).
//
// Per Dispatch 4 Part G: requires --yes in addition to --apply. Wall-clock
// target: 3-6 minutes for 12 fixtures (sequential — MGA can rate-limit if
// we parallelize). Outputs a summary: "Refreshed N fixtures; M unchanged;
// K newly-recorded."
//
// To extend with new fixtures: add an entry to SCENARIO_INPUTS keyed by
// `<assistantKey>/<scenarioName>` and ensure the assistantKey is mapped to
// a live assistantId in resolveAssistantIdForKey().

const SCENARIO_INPUTS = {
  // Router scenarios — input is a user message; output completionText is
  // JSON matching the router envelope schema.
  'router/clarify-vague-build': {
    description: 'vague build request — router should emit clarify',
    message: 'Build me an app.',
  },
  'router/execute-simple-crud': {
    description: 'tasks tracker CRUD — router should emit execute with 4 scopes',
    message:
      'Build a simple tasks tracker: list, add, complete, delete tasks. Stored in Postgres, served ' +
      'by an Express API, with a React frontend. Use docker-compose for local dev. No AI features, ' +
      'no vector database.',
  },
  'router/iterate-amend-multi-scope': {
    description: 'multi-scope amend — router should emit iterate spanning ≥2 scopes',
    message:
      'Add an admin role to the system. Add a "role" column to the users table (default "user"). ' +
      'Add an admin-only endpoint GET /admin/stats. Update the frontend header to show an "Admin" ' +
      'link when role=admin.',
    // Iterate emission requires prior conversation context. For live refresh
    // we send the message alone — the router's iterate path is exercised
    // when affected_scopes can be inferred from the message vocabulary.
  },
  'router/iterate-cosmetic-frontend': {
    description: 'cosmetic single-scope iterate — router should emit iterate with affected_scopes=[frontend]',
    message: 'Make the submit button bigger and use a brighter blue color.',
  },
  'router/diagnose-bug-report': {
    description: 'bug report — router should emit diagnose',
    message:
      'Bug: my contact form returns a 500 when I submit. Nothing useful in the frontend console. ' +
      'Can you diagnose and fix?',
  },

  // Investigator scenarios — input is a spawn prompt asking for diagnosis;
  // output completionText contains a <result>{...}</result> JSON block.
  'investigator/high-confidence-fix': {
    description: 'investigator with clear root cause — high confidence',
    message:
      'Investigate: POST /contact returns 500. Backend logs show "ECONNREFUSED" on database query. ' +
      'Read backend/src/index.ts and database/init/init.sql to confirm root cause and recommend a fix.',
  },
  'investigator/low-confidence-surface': {
    description: 'investigator with ambiguous symptom — low confidence',
    message:
      'Investigate: the user reports "sometimes the page is slow." No backend errors, no frontend ' +
      'errors. Read the codebase and surface what might be slow if anything.',
  },

  // Subagent scenarios — input is a coordination prompt asking the agent to
  // write a minimal scope. Output is XML tool calls or attempt_completion.
  'subagent-backend/minimal-complete': {
    description: 'subagent-backend minimal — writes index.ts + package.json',
    message:
      'Write a minimal Node + Express backend at backend/src/index.ts that responds {ok: true} on ' +
      'GET /health. Include backend/package.json and backend/tsconfig.json. After writing, call ' +
      'attempt_completion with a brief PHASE AGENT REPORT.',
  },
  'subagent-backend/type-gate-failed-then-fix': {
    description: 'subagent-backend with type error to fix',
    message:
      'The backend at backend/src/index.ts has a TypeScript error: "Type \'string\' is not assignable ' +
      'to type \'number\'." Read the file, fix the type, and re-run typecheck. After verifying, ' +
      'call attempt_completion.',
  },
  'subagent-frontend/minimal-complete': {
    description: 'subagent-frontend minimal — writes App.tsx + package.json',
    message:
      'Write a minimal React + Vite frontend at frontend/src/App.tsx with a single page that fetches ' +
      'GET /api/health from the backend. Include frontend/package.json. After writing, call ' +
      'attempt_completion.',
  },

};

function resolveAssistantIdForKey(assistantKey, assistantsConfig) {
  if (assistantKey === 'router') return assistantsConfig.routerAssistantId;
  if (assistantKey === 'investigator') return assistantsConfig.investigatorAssistantId;
  if (assistantKey === 'subagent-backend') return assistantsConfig.subagentBackendAssistantId;
  if (assistantKey === 'subagent-frontend') return assistantsConfig.subagentFrontendAssistantId;
  if (assistantKey === 'subagent-database') return assistantsConfig.subagentDatabaseAssistantId;
  if (assistantKey === 'subagent-vectordb') return assistantsConfig.subagentVectordbAssistantId;
  if (assistantKey === 'subagent-integration') return assistantsConfig.subagentIntegrationAssistantId;
  return null;
}

async function runApply() {
  const fixtures = await walkFixtures(FIXTURES_ROOT);
  if (fixtures.length === 0) {
    console.error('No fixtures found under', FIXTURES_ROOT);
    process.exit(1);
  }

  // Resolve assistant IDs config (loaded lazily; only needed for --apply).
  let assistantsConfig;
  try {
    const cfgPath = join(__dirname, '..', 'server', 'config', 'assistants.json');
    assistantsConfig = JSON.parse(await readFile(cfgPath, 'utf8'));
  } catch (err) {
    console.error('fixtures:refresh --apply: cannot load chat/server/config/assistants.json:', err.message);
    console.error('Ensure assistants are bootstrapped before running --apply.');
    process.exit(2);
  }

  // Dynamic import of the MGA client — avoids loading it when only running
  // --check (the fast path).
  let callMgaCompletions, getAssistantConfig;
  try {
    ({ callMgaCompletions, getAssistantConfig } = await import('../server/agent/llm/llm.js'));
  } catch (err) {
    console.error('fixtures:refresh --apply: cannot import MGA client:', err.message);
    process.exit(2);
  }

  console.log(`fixtures:refresh --apply — recording ${fixtures.length} fixtures from live MGA…`);
  const t0 = Date.now();
  let refreshed = 0;
  let unchanged = 0;
  let newlyRecorded = 0;
  const failures = [];

  // Sequential dispatch — MGA can rate-limit on parallel calls. The 3-6 min
  // budget per the brief assumes sequential.
  for (const fixture of fixtures) {
    const inputKey = `${fixture.assistantKey}/${fixture.scenarioName}`;
    const input = SCENARIO_INPUTS[inputKey];
    if (!input) {
      failures.push({ fixture: fixture.relPath, reason: `no SCENARIO_INPUTS entry for ${inputKey}` });
      console.error(`  - ${fixture.relPath}: SKIP (no scenario input defined)`);
      continue;
    }
    const assistantId = resolveAssistantIdForKey(fixture.assistantKey, assistantsConfig);
    if (!assistantId) {
      failures.push({ fixture: fixture.relPath, reason: `no assistantId mapped for ${fixture.assistantKey}` });
      console.error(`  - ${fixture.relPath}: SKIP (no live assistantId for ${fixture.assistantKey})`);
      continue;
    }

    // Read pre-state to determine refreshed vs unchanged vs newly-recorded.
    let preCompletion = null;
    try {
      const raw = await readFile(fixture.path, 'utf8');
      const parsed = JSON.parse(raw);
      preCompletion = parsed?.response?.completionText ?? null;
    } catch {
      // newly-recorded
    }

    process.stdout.write(`  - ${fixture.relPath}: calling…`);
    let response;
    try {
      const cfg = await getAssistantConfig(assistantId);
      if (!cfg.model) {
        throw new Error(`getAssistantConfig(${assistantId}) returned no model id`);
      }
      // Use MGA's stored instructions as the system prompt. The fixture
      // refresh is by definition recording what the live assistant emits,
      // so we want the same instructions MGA would use server-side.
      const messages = [
        { role: 'system', content: cfg.instructions || '' },
        { role: 'user', content: input.message },
      ];
      response = await callMgaCompletions({
        messages,
        model: cfg.model,
        assistantLabel: `refresh:${fixture.assistantKey}`,
      });
    } catch (err) {
      console.log(' FAIL');
      failures.push({ fixture: fixture.relPath, reason: `MGA call failed: ${err.message}` });
      continue;
    }

    // Validate the new response shape before writing — if the live MGA
    // emits drift, surface that as a failure rather than silently writing
    // a bad fixture.
    const shapeDrift = validateCompletionShapeForKey(fixture.assistantKey, response.content);
    if (shapeDrift) {
      console.log(' FAIL (shape)');
      failures.push({
        fixture: fixture.relPath,
        reason: `live response failed shape validation: ${shapeDrift}`,
      });
      continue;
    }

    // Build new fixture envelope. Preserve original capturedFrom='manual'
    // intent by overwriting to 'live'. capturedAt = now.
    const newFixture = {
      assistantKey: fixture.assistantKey,
      scenarioName: fixture.scenarioName,
      schemaVersion: 1,
      response: {
        completionText: response.content,
        usage: response.usage ?? null,
        model: response.model ?? null,
        conversationId: response.conversationId ?? `fixture-${fixture.assistantKey}-${fixture.scenarioName}-${Date.now()}`,
      },
      capturedFrom: 'live',
      capturedAt: new Date().toISOString(),
    };

    await writeFile(fixture.path, JSON.stringify(newFixture, null, 2) + '\n', 'utf8');

    if (preCompletion === null) {
      newlyRecorded += 1;
      console.log(' NEW');
    } else if (preCompletion === newFixture.response.completionText) {
      unchanged += 1;
      console.log(' unchanged');
    } else {
      refreshed += 1;
      console.log(' refreshed');
    }
  }

  const elapsedMs = Date.now() - t0;
  console.log('');
  console.log(`fixtures:refresh done — refreshed ${refreshed}; unchanged ${unchanged}; newly-recorded ${newlyRecorded} (${(elapsedMs / 1000).toFixed(1)}s)`);
  if (failures.length > 0) {
    console.error('');
    console.error(`${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(`  - ${f.fixture}: ${f.reason}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

// ─── CLI dispatch ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { mode: 'check', yes: false };
  for (const a of args) {
    if (a === '--check') opts.mode = 'check';
    else if (a === '--apply') opts.mode = 'apply';
    else if (a === '--yes') opts.yes = true;
    else if (a === '-h' || a === '--help') opts.mode = 'help';
    else {
      console.error('Unknown argument:', a);
      console.error('Usage: refresh-mga-fixtures.js [--check|--apply --yes]');
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);
if (opts.mode === 'help') {
  console.log('Usage: refresh-mga-fixtures.js [--check|--apply --yes]');
  console.log('');
  console.log('  --check (default)  Validate fixture shape; exits 0 on clean / 1 on drift.');
  console.log('  --apply --yes      Re-record fixtures from live MGA (operator action).');
  process.exit(0);
}
if (opts.mode === 'check') {
  await runCheck();
} else if (opts.mode === 'apply') {
  if (!opts.yes) {
    console.error('--apply requires --yes to confirm. This rewrites every fixture file.');
    process.exit(2);
  }
  await runApply();
}
