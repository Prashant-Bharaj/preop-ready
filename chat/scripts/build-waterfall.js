#!/usr/bin/env node
/**
 * build-waterfall.js — print a phase-by-phase timing waterfall for builds by
 * parsing the dev-server log (the tlog lines every phase already emits).
 *
 * Usage:
 *   node scripts/build-waterfall.js <path-to-dev-log> [--last]
 *
 * Finds each build (fresh or iterate) and prints where the wall-clock went:
 * planner, per-scope agents, gates, reconciler, compose, migrations, probe,
 * visual check. Use it after a test build to see what to optimize next —
 * and before/after a harness change to prove the change moved the number.
 */

import fs from 'node:fs';

const file = process.argv[2];
const lastOnly = process.argv.includes('--last');
if (!file || !fs.existsSync(file)) {
  console.error('usage: node scripts/build-waterfall.js <dev-log-path> [--last]');
  process.exit(1);
}

const TS_RE = /^\[\d+\] \[(\d{2}):(\d{2}):(\d{2})\]/;
function tsOf(line) {
  const m = TS_RE.exec(line);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// Marker → phase label. First match starts the phase; a phase ends when the
// next phase starts (or the build ends at app_ready).
const MARKERS = [
  [/Router responded .*action=clarify/, 'planner: clarify round'],
  [/two-agent\] contract result/, 'planner: contract agent done'],
  [/hybrid-router\] running modules/, 'planner: hybrid modules'],
  [/build-dispatcher: \d+ tasks/, 'dispatch: agents start'],
  [/\[agent:database\] .*attempt_completion/, 'agent: database done'],
  [/\[agent:backend\] .*attempt_completion/, 'agent: backend done'],
  [/\[agent:frontend\] .*attempt_completion/, 'agent: frontend done'],
  [/\[agent:integration\] .*attempt_completion/, 'agent: integration done'],
  [/Investigator-driven iterate finished|dispatch finished|All \d+ tasks completed/, 'dispatch: all agents done'],
  [/type-gate-phase\] start/, 'gate: type/runtime start'],
  [/type-gate-phase\] done/, 'gate: type/runtime done'],
  [/reconciler-loop\] start/, 'reconciler: start'],
  [/reconciler-loop\] done/, 'reconciler: done'],
  [/auto-recovery\] done/, 'auto-recovery: done'],
  [/Auto-start: compose build \(/, 'compose: build done'],
  [/Auto-start: compose up \(/, 'compose: up done'],
  [/\[migrations\] applied|\[migrations\] FAILED/, 'migrations'],
  [/endpoint-probe\] starting/, 'probe: start'],
  [/endpoint-probe\] done/, 'probe: done'],
  [/ui-sanity\] verdict|ui-sanity\] skipped/, 'visual check'],
  [/app_ready_prompt emitted/, 'BUILD READY'],
];

const BUILD_START_RE = /concierge\] decision action=(dispatch_iterate|diagnose)|Router responded .*action=execute|session\] Init: ready/;

const lines = fs.readFileSync(file, 'utf-8').split('\n');
const builds = [];
let current = null;

for (const line of lines) {
  const t = tsOf(line);
  if (t == null) continue;
  if (BUILD_START_RE.test(line) && /action=execute|action=dispatch_iterate|action=diagnose/.test(line)) {
    current = { start: t, kind: /execute/.test(line) ? 'fresh' : 'iterate', events: [] };
    builds.push(current);
    continue;
  }
  if (!current) continue;
  for (const [re, label] of MARKERS) {
    if (re.test(line)) {
      current.events.push({ t, label });
      if (label === 'BUILD READY') current = null;
      break;
    }
  }
}

const done = builds.filter((b) => b.events.some((e) => e.label === 'BUILD READY'));
const toShow = lastOnly ? done.slice(-1) : done;
if (!toShow.length) {
  console.log('no completed builds found in log');
  process.exit(0);
}

for (const b of toShow) {
  const end = b.events.find((e) => e.label === 'BUILD READY').t;
  const total = end - b.start;
  console.log(`\n=== ${b.kind.toUpperCase()} build — total ${fmt(total)} ===`);
  let prev = b.start;
  for (const e of b.events) {
    const delta = e.t - prev;
    console.log(`  +${fmt(e.t - b.start).padStart(6)}  ${e.label}${delta > 0 ? `  (+${fmt(delta)})` : ''}`);
    prev = e.t;
  }
}

function fmt(s) {
  if (s < 0) s += 86400; // midnight rollover
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}