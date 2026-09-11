#!/usr/bin/env node
/**
 * bench/run.mjs — automated hand-test playbook pass.
 *
 * Drives the LIVE dev server through fresh builds (clean → prompt → clarify
 * → confirm → app-ready), then asserts BEHAVIOR against the generated app
 * (real HTTP, real data — the 3-action tests from docs/HAND_TEST_PLAYBOOK.md).
 *
 * Scoring per the playbook:
 *   accuracy    — scenarios whose 3-action test passed with zero incidents
 *   containment — of scenarios WITH incidents, how many the harness itself
 *                 flagged (failed report / probe failures / visual defects).
 *                 Silent failures (broken app + all-green harness) must be 0.
 *
 * Usage:
 *   node bench/run.mjs                 # all scenarios
 *   node bench/run.mjs crud-logbook    # one scenario
 *
 * Costs real MGA tokens (~1 fresh build per scenario). Requires the dev
 * server on :5050 and Docker running.
 *
 * NOT a duplicate of tests/smoke/: smoke boots a sandboxed server on a temp
 * workspace with MGA_SKIP_PRESTAGE and asserts harness MECHANICS (events,
 * files, gates). The bench targets the LIVE server + real MGA + real Docker
 * and asserts USER-VISIBLE BEHAVIOR of the generated app over HTTP. Run
 * smoke before landing harness changes; run the bench to score the product.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSession, cleanProject, driveFreshBuild, driveIterate, readEvents, BASE_URL, ROOT } from './lib/harness-client.mjs';
import { resetPersonaWarmup } from './lib/app-client.mjs';
import pathMod from 'node:path';

import crudLogbook from './scenarios/crud-logbook.mjs';
import deviationTracker from './scenarios/deviation-tracker.mjs';
import aiRootCause from './scenarios/ai-root-cause.mjs';
import sopAssistant from './scenarios/sop-assistant.mjs';
import vaguePrompt from './scenarios/vague-prompt.mjs';
import realtimeStatusBoard from './scenarios/realtime-status-board.mjs';
import iterateEvolution from './scenarios/iterate-evolution.mjs';
import opsDashboard from './scenarios/ops-dashboard.mjs';
import publicBoard from './scenarios/public-board.mjs';
import webhookIntegration from './scenarios/webhook-integration.mjs';

const SCENARIOS = [
  crudLogbook, deviationTracker, aiRootCause, sopAssistant, vaguePrompt,
  realtimeStatusBoard, iterateEvolution, opsDashboard, publicBoard, webhookIntegration,
];

function contractSnapshot() {
  try {
    const env = JSON.parse(fs.readFileSync(pathMod.join(ROOT, '.harness', 'contracts.json'), 'utf-8'));
    return {
      endpoints: (env?.data?.apiContract?.endpoints || []).length,
      revisions: (env?.data?.revisions || []).length,
    };
  } catch { return { endpoints: 0, revisions: 0 }; }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const SUMMARIES_DIR = path.join(__dirname, '..', 'server', 'agent', 'run-logs', '_summaries');

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

function latestRunSummary(sinceMs) {
  try {
    const rows = [];
    for (const f of fs.readdirSync(SUMMARIES_DIR)) {
      for (const line of fs.readFileSync(path.join(SUMMARIES_DIR, f), 'utf-8').trim().split('\n')) {
        try { const r = JSON.parse(line); if (r.startedAt >= sinceMs) rows.push(r); } catch { /* skip */ }
      }
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return rows[0] || null;
  } catch { return null; }
}

async function runScenario(scenario) {
  const marker = `b${Date.now().toString(36)}`;
  const startedAt = Date.now();
  log(`━━━ ${scenario.name} (marker=${marker}) ━━━`);

  // Fresh slate: clean via a throwaway session, then a new session builds.
  const cleaner = await startSession();
  await cleanProject(cleaner);
  await new Promise((r) => setTimeout(r, 8000));
  const sessionId = await startSession();
  log(`session ${sessionId}`);

  const result = { scenario: scenario.name, marker, sessionId, startedAt };
  try {
    const build = await driveFreshBuild(sessionId, scenario, log);
    Object.assign(result, build);
    log(`app ready in ${Math.round(build.buildMs / 1000)}s — report=${build.reportStatus} probe=${build.probe ? `${build.probe.probed}p/${(build.probe.stillBroken || []).length}broken` : 'n/a'}`);

    // Behavior: the 3-action test. Fresh app → no persona has "loaded" it yet.
    resetPersonaWarmup();
    result.actions = await scenario.threeAction(marker);
    for (const a of result.actions) log(`  ${a.ok ? 'PASS' : 'FAIL'} ${a.name} — ${a.detail}`);

    // Expectations (scope discipline both directions + planner behavior).
    result.expectationIncidents = [];
    if (scenario.expectations?.aiApp === false && /MGA|assistant/i.test(result.appReadyText)) {
      result.expectationIncidents.push('non-AI case but app-ready message mentions MGA');
    }
    if (scenario.expectations?.aiApp === true && !/MGA|assistant/i.test(result.appReadyText)) {
      result.expectationIncidents.push('AI case but app-ready message has no MGA provisioning confirmation');
    }
    if (scenario.expectations?.mustClarify && !(result.clarifyRounds >= 1)) {
      result.expectationIncidents.push('vague prompt did not trigger clarify questions (planner guessed)');
    }

    // Session 2 — iterate ladder (opt-in: BENCH_LADDER=1). Each step: drive
    // the iterate, then REGRESSION-run the 3-action test with a fresh marker
    // (nothing an iterate touches may break what already worked), and check
    // the contract's revision log grew.
    if ((process.env.BENCH_LADDER === '1' || scenario.ladder === 'always') && Array.isArray(scenario.iterates)) {
      for (const step of scenario.iterates) {
        const before = contractSnapshot();
        log(`[ladder] ${step.name}`);
        const it = await driveIterate(sessionId, step.message, log);
        const after = contractSnapshot();
        result.actions.push({
          name: `ladder/${step.name}: iterate completed`,
          ok: it.reportStatus === 'built' || it.reportStatus === 'partial',
          detail: `report=${it.reportStatus} in ${Math.round(it.iterateMs / 1000)}s`,
        });
        result.actions.push({
          name: `ladder/${step.name}: contract revision logged`,
          ok: after.revisions > before.revisions || after.endpoints !== before.endpoints,
          detail: `revisions ${before.revisions}→${after.revisions} endpoints ${before.endpoints}→${after.endpoints}`,
        });
        const regressionMarker = `b${Date.now().toString(36)}`;
        resetPersonaWarmup(); // iterate may have recreated containers/rows
        const regression = await scenario.threeAction(regressionMarker);
        for (const a of regression) {
          result.actions.push({ ...a, name: `ladder/${step.name}: regression — ${a.name}` });
        }
        if (step.verify) {
          const extra = await step.verify(regressionMarker);
          for (const a of extra) result.actions.push({ ...a, name: `ladder/${step.name}: ${a.name}` });
        }
        for (const a of result.actions.slice(-(regression.length + 2))) log(`  ${a.ok ? 'PASS' : 'FAIL'} ${a.name}`);
      }
    }
  } catch (err) {
    result.driveError = String(err?.message || err);
    log(`DRIVE ERROR: ${result.driveError}`);
    result.actions = result.actions || [];
    result.expectationIncidents = result.expectationIncidents || [];
  }

  // Scoring.
  const failedActions = (result.actions || []).filter((a) => !a.ok);
  const incidents = [
    ...failedActions.map((a) => `action failed: ${a.name} (${a.detail})`),
    ...(result.expectationIncidents || []),
    ...(result.driveError ? [`drive error: ${result.driveError}`] : []),
  ];
  const authzFlagged = readEvents(result.sessionId || '').some(
    (e) => e?.type === 'authz_posture_change' && (e.payload?.expansions || []).length > 0);
  const harnessFlagged =
    result.reportStatus === 'failed' ||
    (result.probe && (result.probe.stillBroken || []).length > 0) ||
    (result.visual && result.visual.sane === false) ||
    authzFlagged ||
    !!result.driveError;
  result.incidents = incidents;
  result.pass = incidents.length === 0;
  result.silentFailure = incidents.length > 0 && !harnessFlagged;
  result.telemetry = latestRunSummary(startedAt);
  result.wallMs = Date.now() - startedAt;
  return result;
}

async function main() {
  // --assert-only <scenario>: skip clean/build, run the 3-action test against
  // the CURRENTLY running app (cheap re-validation after bench-spec fixes).
  if (process.argv[2] === '--assert-only') {
    const name = process.argv[3];
    const s = SCENARIOS.find((x) => x.name === name);
    if (!s) { console.error(`no scenario named '${name}'`); process.exit(1); }
    const marker = `b${Date.now().toString(36)}`;
    const actions = await s.threeAction(marker);
    for (const a of actions) console.log(`${a.ok ? 'PASS' : 'FAIL'}  ${a.name} — ${a.detail}`);
    process.exit(actions.every((a) => a.ok) ? 0 : 1);
  }
  const filter = process.argv[2];
  const toRun = filter ? SCENARIOS.filter((s) => s.name === filter) : SCENARIOS;
  if (!toRun.length) { console.error(`no scenario named '${filter}'`); process.exit(1); }

  // Preflight: server AND Docker must be healthy before spending tokens —
  // a sick Docker daemon (observed post-reboot: 500 on every API call) lets
  // agents build for hours and then fails at compose.
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) { console.error(`dev server not healthy at ${BASE_URL} (HTTP ${health})`); process.exit(1); }
  const { execSync } = await import('node:child_process');
  try { execSync('docker info', { stdio: 'pipe', timeout: 15_000 }); }
  catch { console.error('docker daemon not healthy (docker info failed) — fix Docker Desktop before running the bench'); process.exit(1); }

  const results = [];
  for (const s of toRun) results.push(await runScenario(s));

  const passed = results.filter((r) => r.pass).length;
  const withIncidents = results.filter((r) => !r.pass);
  const silent = results.filter((r) => r.silentFailure).length;

  console.log('\n══════════ BENCH SCORECARD ══════════');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}  build=${r.buildMs ? Math.round(r.buildMs / 1000) + 's' : 'n/a'}  tokens=${r.telemetry ? Math.round((r.telemetry.tokens?.total || 0) / 1000) + 'k' : '?'}  cost=$${r.telemetry?.costUsd?.toFixed?.(2) ?? '?'}`);
    for (const i of r.incidents) console.log(`      incident: ${i}`);
  }
  console.log(`accuracy:    ${passed}/${results.length}`);
  console.log(`containment: ${withIncidents.length - silent}/${withIncidents.length} harness-flagged${silent > 0 ? `  ⚠ SILENT FAILURES: ${silent}` : ''}`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ ranAt: Date.now(), results }, null, 2));
  console.log(`scorecard: ${path.relative(process.cwd(), outPath)}`);

  process.exit(silent > 0 ? 2 : (passed === results.length ? 0 : 1));
}

main().catch((err) => { console.error(err); process.exit(1); });