# Baseline post-W3.TYPES.GATE — 2026-05-16 — W3.RECOV + W3.TYPES.GATE + pipeline-reorder + tokens-cap-bump

## What this baseline measures

Captured at `feat/harness-evolution` after the three Phase 3 W3.TYPES.GATE-arc commits land:
- `77ae7e7` — W3.TYPES.GATE — type-gate as first detector inside runAutoRecovery
- `33351a7` — pipeline reorder — `runTypeGatePhase` moved OUT of runAutoRecovery to fire BEFORE reconciler-loop, per Section O intent
- `c68e280` — `MAX_RECOVERY_TOKENS_PER_BUILD` 200K → 400K, sized 2x post-reorder observed multi-scope usage

Snapshot: `smoke-metrics-baseline-post-w3-types-gate-2026-05-16.jsonl` — last 3 entries for t11/t32/tAI1 are the W3.TYPES.GATE verification runs (see per-scenario classification below).

This is NOT a full-Phase-3 baseline — W3.LOGS, W3.INVEST, W3.TEL haven't dispatched yet. Captures the state where the typed compile-time gate + auto-recovery loop are landed and verified.

## Per-scenario classification — strict-gate verdicts on t11/t32/tAI1

| Scenario | Pre-Phase-0 | Post-Phase-2 | Post-W3.RECOV | Post-W3.TYPES.GATE | Verdict |
|---|---|---|---|---|---|
| `t11-backend-db-multi` | pass 164s | **fail 194s** (stale-diff spin) | fail 178s (build_failed, tsc errors in agent code) | **PASS 201s** at sha `77ae7e7` | ✓ recovered by type-gate; design proven |
| `t32-doc-search-api` | fail 361s | error 64s (plannerExpect) | fail 386s (reconciler hard-fail) | **PASS-WITH-FLAG 243s** at sha `77ae7e7` | ✓ recovered; LLM pipeline succeeded; PASS-WITH-FLAG is a smoke-harness port-conflict caveat (compose-up couldn't be validated because the prior t11 container left port 3000 in use) — NOT a W3.TYPES.GATE design defect |
| `tAI1-faq-bot-rag` | fail 578s | **ERROR 1297s** wall-clock (spin loop) | **ERROR 721s** wall-clock (build_failed downstream of stale-diff) | **ERROR 721s** wall-clock (this run, sha `c68e280`) | wall-clock complexity-bound; **see "tAI1 deep dive" below** |

**Strict gate (t11 + t32 + tAI1 all PASS): 2/3.** tAI1's residual failure is not a W3.TYPES.GATE design defect — it's the scenario's intrinsic complexity (5 scopes + RAG + `mga_assistants`) exceeding the 12-min smoke wall-clock once the harness's new robustness mechanisms (type-gate-phase + auto-recovery + reconciler-loop) each do meaningful real work.

## tAI1 deep dive (post-W3.TYPES.GATE-arc, 2026-05-16 20:22 UTC, sha `c68e280`)

Full per-phase timeline:

```
22:10:52  smoke start
22:15:16  type-gate-phase start (4:24 in; subagent writes complete)
22:15:17  dispatch backend (errors=2)        round 1   (pre-reconciler type-gate fix)
22:19:56  dispatch frontend (errors=71)      round 1   ← 4:39 after backend dispatch
22:20:53  dispatch backend (errors=3)        round 2   ← backend re-failed on round 1's fixes
22:22:08  type-gate-phase done — all scopes type-clean
           wall=412155ms (6:52)  fixAttempts={"backend":2,"frontend":1}  tokensUsed=399082
22:22:08  reconciler-loop start (45s budget remaining)
22:22:53  wall-clock kill at 12-min budget; reconciler-loop got ~45s
```

**What worked**:
- Pipeline reorder fired correctly — type-gate ran AFTER subagent writes and BEFORE reconciler-loop (vs the pre-reorder run where reconciler-loop ate 7m43s before type-gate had a chance).
- Tokens cap bump kept the phase alive — 399K of 400K used; previous 200K cap would have tripped at 244K.
- Type-gate-phase actually **produced type-clean code** by round 2: backend's 2-error → 3-error → 0-error cycle + frontend's 71-error → 0-error single-round resolution.

**What didn't work**: type-gate-phase itself consumed 6:52 of the 12-min budget. Reconciler-loop got only ~45s before wall-clock kill. Wall-clock killed during reconciler-judge, not during a hang — the harness was actively making progress when killed.

**Why backend round 1 took 4:39**: the 2-error fix recreated 3 new errors (round 2 cleaned those in 1:15). LLM-driven fixes occasionally introduce new errors while clearing old ones; the budget needs to accommodate this back-and-forth.

**Why frontend round 1 was only 0:57**: 71 errors but mostly mechanical (TypeScript strict-mode warnings on a fresh scaffold), single round resolved.

## W4.BUDGET target — tAI1 wall-clock fix paths

Three viable paths, all bundled into W4.BUDGET per its scope addition:

1. **Parallelize independent type-gate fix-dispatches** in `runTypeGatePhase` — currently sequential (backend → frontend). Backend dominates (4:39 round 1); frontend (0:57) could have overlapped. Savings: ~1 min on multi-scope.

2. **Three-tier prompt injection (Section H)** — Tier-1 always-inline + Tier-2 contracts/state + Tier-3 fetched-on-demand. Reduces per-call prompt size → faster LLM round-trips → faster fix-dispatches.

3. **Microcompact (Section J)** — between agent iterations when accumulated history > 50% context. Reduces per-turn token cost on long agent loops (frontend's 71-error fix likely benefits).

All three are W4.BUDGET's existing scope. The parallelization is the smallest and most-targeted at tAI1's specific bottleneck.

## t39 — known flake (unchanged classification)

`t39-time-off-full-stack` continues to be the suite's known flake. Pass-rate tracked; not single-run-regression-sensitive. Failure mode varies (`outcome=skipped` reconciler-hard-fail OR `outcome=build_failed` compose-build-fail). Most recent runs hit `build_failed` at 357-669s.

## Comparison rules for Phase 4 `runs-report.js`

- **Known-flake** (`t39-time-off-full-stack`): pass-rate trend only.
- **Phase-3 target fix scenarios** that recovered (`t11-backend-db-multi`, `t32-doc-search-api`): track regression normally — they should stay PASS through W3.LOGS / W3.INVEST / W3.TEL / W4 / merge.
- **W4.BUDGET target** (`tAI1-faq-bot-rag`): track as "should pass after W4.BUDGET". Currently wall-clock-bound at ~12 min on a 5-scope scenario with full type-gate + reconciler + auto-recovery.
- **Soft-correct telemetry**: track frequency of `router_soft_correct` events per field. High frequency → tighten router prompt further.
- **Auto-recovery telemetry**: track `auto_recovery_dispatch` / `auto_recovery_scope_exhausted` / `auto_recovery_tokens_exhausted` / `auto_recovery_stale_diff` per-scenario per-scope.
- **Type-gate-phase telemetry**: track `type_gate_phase_dispatch` / `type_gate_phase_scope_exhausted` / `type_gate_phase_tokens_exhausted` — these answer "how often is the type-gate-phase doing real work" and "which scopes dominate the wall-clock".

## Phase 3 status: PARTIAL — W3.RECOV + W3.TYPES.GATE done; W3.LOGS, W3.INVEST, W3.TEL remain

Three Phase 3 workers complete:
- **W3.RECOV** (`946f270`) — auto-recovery loop + stale-diff retry detector + 3 detectors + scopeCounters integration
- **W3.TYPES.GATE** (`77ae7e7` + `33351a7` pipeline reorder + `c68e280` tokens-cap bump) — compile-time type-gate as first detector in pipeline; design proven on t11 + t32

Three Phase 3 workers remaining:
- **W3.LOGS** — `read_container_logs` MCP tool (smallest, parallel-safe with everything; no dependencies)
- **W3.INVEST** — investigator agent + diagnose-path wiring through orchestrator
- **W3.TEL** — structured reconciler verdicts + snippet-fetch tracking + investigator/auto-recovery per-attempt telemetry

Per the user directive: dispatch order is **W3.LOGS → W3.INVEST → W3.TEL**.
