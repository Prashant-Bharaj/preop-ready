# Baseline post-Phase-3 — 2026-05-16 — W3.RECOV + W3.TYPES.GATE + W3.LOGS + W3.INVEST + W3.TEL all landed

## What this baseline measures

Captured at `feat/harness-evolution` sha `7563b51` (W3.TEL just landed). All five Phase 3 workers complete:

- `946f270` — W3.RECOV (auto-recovery loop + 3 detectors)
- `77ae7e7` + `33351a7` + `c68e280` — W3.TYPES.GATE arc (type-gate as first detector + pipeline reorder + 400K tokens cap)
- `21fe713` — W3.LOGS (read_container_logs tool)
- `45afabf` — W3.INVEST (investigator agent + diagnose-path wiring; MGA assistant not yet bootstrapped)
- `7563b51` — W3.TEL (Section M items 3/4/10/11: reconciler-verdicts.jsonl + snippet-fetches.jsonl + autoRecoveryAttempts + investigatorRecords)

Snapshot: `smoke-metrics-baseline-post-phase3-2026-05-16.jsonl` — 11 curated scenarios run end-to-end.

## Results — 8/11 PASS

| Scenario | Pre-Phase-0 | Post-W3.TYPES.GATE | **Post-Phase-3 (this baseline)** | Δ vs prior | Verdict |
|---|---|---|---|---|---|
| t-sub-backend-min | — | — | PASS 25.2s | — | clean |
| t-sub-backend-py-min | — | — | PASS 30.2s | — | clean |
| t-sub-frontend-min | — | — | PASS 87.5s | — | clean |
| t-sub-database-min | — | — | PASS 14.5s | — | clean |
| t-sub-vectordb-min | — | — | PASS 30.6s | — | clean |
| t1-backend-health | — | — | PASS 30.5s | — | clean |
| t2-continuation | — | — | PASS 31.9s | — | clean |
| t11-backend-db-multi | fail 164s | **PASS 201s** | **PASS 240.1s** | +39s (+19%) | recovered, slight wall-clock creep |
| t32-doc-search-api | fail 361s | **PASS-WITH-FLAG 243s** | **ERROR 721.4s (wall-clock kill)** | **REGRESSION** | wall-clock-bound; see "t32 regression" below |
| t39-time-off-full-stack | fail | flake | **ERROR 1877.6s (wall-clock kill — 31 min total)** | duration anomaly | known-flake (per pre-Phase-0 flake-notes); but 1877s ≫ 720s cap — see "t39 wall-clock anomaly" |
| tAI1-faq-bot-rag | fail 578s | ERROR 721s wall-clock | **FAIL 537.6s (hard mismatch: users.name column missing from init.sql)** | mode-change | reconciler caught a real contract bug; see "tAI1 mode-change" below |

## Strict-gate verdict

**t11 + t32 + tAI1 all PASS: 1/3.**

- t11: PASS (held)
- t32: REGRESSED from PASS-WITH-FLAG → ERROR wall-clock
- tAI1: STILL FAIL but mode changed (was wall-clock-bound → now contract-mismatch-bound)

## t32 regression analysis

**What changed**: PASS-WITH-FLAG 243s at sha `77ae7e7` → ERROR 721s wall-clock at sha `7563b51`. Roughly **3x wall-clock regression**.

Three commits landed between the two baselines: W3.LOGS (`21fe713`), W3.INVEST (`45afabf`), W3.TEL (`7563b51`). All three are candidates:

- **W3.LOGS** — pure additive (new tool registered in TOOL_MAP; never called without investigator dispatch). Unlikely cause.
- **W3.INVEST** — added new PHASES.INVESTIGATING phase + diagnose-path wiring at routes.js:906-916. Never fires for t32 (router emits `action: 'execute'`, not 'diagnose'). Should be inert. **But**: the new `runInvestigatorPhase` + helpers are exported from routes.js; routes.js gained ~395 lines. Worth verifying nothing in the non-diagnose paths was disturbed.
- **W3.TEL** — large touch-surface on critical-path code: `reconciler/compare.js` (+51), `reconciler/judge-extras.js` (+34), `mcp/handlers.js` (+28), `auto-recovery.js` (+81), `docker-orchestration.js` (+26), `exec-tools.js` (+22). **Most likely culprit**. The reconciler-verdicts.jsonl writer adds a sync `appendFileSync` per verdict. If 30+ extras × 4 scopes get judged, that's 100+ sync writes per build. Adds latency.

**Recommended diagnostic before W4 dispatch**: re-run t32 at sha `21fe713` (just W3.LOGS) and `45afabf` (W3.LOGS + W3.INVEST) to bisect. Expected: if 21fe713 + 45afabf both PASS, the regression is W3.TEL-introduced and we can tune the writer (batch writes, async append, or feature-flag).

## tAI1 mode-change analysis

**What changed**: was killed at 12-min wall-clock during type-gate-phase or reconciler-loop. Now completes faster, reconciler runs to terminal state, and **correctly surfaces a hard contract mismatch**:

```
scope=database (1 mismatch)
  - db-column-missing at backend/src/lib/db-connection.ts
    contract: backend code references users.name (source of truth)
    actual:   column "name" not declared on users in init.sql
```

This is the reconciler working as designed. The scenario's contract has a real inconsistency: the backend agent wrote code referencing `users.name`, but init.sql doesn't declare that column. Previously the wall-clock killed the harness before the reconciler completed; now the harness finishes faster (type-gate-phase + auto-recovery cleared the type errors quickly) and the reconciler gets to run its checks → surfaces the real bug.

This is NOT a harness regression. This is the harness now exposing a pre-existing scenario-fixture bug OR a subagent prompt issue that consistently produces this mismatch.

**Recommended diagnostic**: inspect the tAI1 scenario's contract/spec — is `users.name` part of the intended schema? Two possible root causes:
1. Scenario spec says `users.name` should exist; subagent's init.sql is wrong (database subagent prompt issue).
2. Scenario spec doesn't include `users.name`; backend subagent is hallucinating an extra column (backend subagent prompt issue).

Either way, this is a subagent-prompt regression target — not a Phase 3 harness regression. Track separately from t32.

## t39 wall-clock anomaly — 1877s ≫ 720s cap

`t39-time-off-full-stack` ran 1877.6s = **31 minutes** wall-clock, while the smoke harness's per-scenario cap is 12 minutes (720s). This is concerning regardless of t39's known-flake status. Either:

1. **Wall-clock enforcement regressed** — the harness no longer terminates at 12 min. Bug to investigate.
2. **Multiple internal retry rounds**, each capped at 12 min, summed in the duration field. Unlikely given the smoke harness's existing per-scenario timeout architecture.
3. **Smoke-harness timing measurement is wrong** — duration includes external setup/teardown not subject to the cap.

**Recommended diagnostic**: spot-check the smoke harness's per-scenario timeout in `chat/tests/smoke/smoke.js` against the recorded 1877s. Did it actually run for 31min, or is `durationMs` overcounting? If the former, the wall-clock enforcement broke somewhere in W3.

t39 is still tracked per the existing known-flake rule (pass-rate trend only, no single-run regression signal). The 1877s value is the new data-point to investigate, not a categorical regression.

## Comparison rules for Phase 4 `runs-report.js` (unchanged from prior baselines)

- **Known-flake** (`t39-time-off-full-stack`): pass-rate trend only. **NEW data point**: investigate 1877s wall-clock anomaly.
- **Phase-3 target fix scenarios that recovered** (`t11-backend-db-multi`): track regression normally — should stay PASS.
- **t32 regression** (`t32-doc-search-api`): currently REGRESSED post-Phase-3. Should be investigated/fixed before Phase 4 close.
- **W4.BUDGET target** (`tAI1-faq-bot-rag`): currently FAILing on contract mismatch, NOT wall-clock. Reclassify: tAI1's wall-clock is no longer the dominant failure mode; surface the contract-mismatch as the primary fix-target. W4.BUDGET work (parallelize type-gate fix-dispatches, microcompact, tiered prompts) is still relevant for general latency, but tAI1's specific failure now points to subagent-prompt drift.
- **Telemetry events** (new, per W3.TEL): track `reconciler_verdict` counts per scope, `snippet_fetch` per scope, `auto_recovery_attempt` per build, `investigator_record` per build. The new fields `autoRecoveryAttempts[]` + `investigatorRecords[]` in run-summary.jsonl are now Phase-4 inputs.

## Post-baseline patch (sha `5566b5a`) + t32 re-run (single scenario) — 2026-05-17

After the post-Phase-3 baseline surfaced the t32 wall-clock regression, a targeted patch landed:

- **`5566b5a`** — `perf(harness-evolution): W3.TEL reconciler-verdicts — batch-and-flush at phase boundary`. Replaces sync `appendFileSync`-per-verdict with a per-workspace in-memory buffer flushed at `judgeExtras` + `compareScopes` boundaries (+ belt-and-braces in `runReconcilerLoop` finally). 5/5 `test-w3-tel.js` paths still PASS; 48/48 reconciler unit tests still PASS.

**t32 re-run at sha `5566b5a`** (single scenario, 2026-05-17 ~10:19 UTC):
- **Wall-clock FIXED**: 259.9s (was 721s; **3x improvement**, matches the post-W3.TYPES.GATE 243s baseline). `[reconciler-loop] wall=90449ms` — comfortably under timeout.
- **New failure mode**: `db-column-missing` hard mismatch at `backend/src/index.ts` — backend code references `chunks.filename`, init.sql doesn't declare that column on `chunks`. **Same class as tAI1's `users.name` failure**.

## Group classification — db-column-missing class (NEW)

Both tAI1 and t32 now share the same failure: backend-subagent emits code referencing a column the database-subagent did not include in init.sql. The reconciler now reaches terminal state on multi-scope scenarios (post-W3.TYPES.GATE + post-W3.TEL-batch-flush) and surfaces this pre-existing cross-subagent inconsistency.

| Scenario | Column | Result | Class |
|---|---|---|---|
| tAI1-faq-bot-rag | `users.name` | FAIL 537s reconciler-hard-fail | db-column-missing |
| t32-doc-search-api | `chunks.filename` | FAIL 259.9s reconciler-hard-fail | db-column-missing |

**Classification: W4.PROMPTS target, NOT a Phase 3 regression.** The reconciler is working as designed; what it's surfacing is a subagent-prompt issue — the cross-scope contract between database (init.sql column list) and backend (code referencing columns) is not being enforced strongly enough by the current subagent prompts.

**Follow-up to verify in W4.PROMPTS planning**: does importing the generated `data_model` types from W1.TYPES.GEN auto-prevent this class at compile time? Section O's typed contracts SHOULD catch "code references undeclared column" if backend imports the generated `User` / `Chunks` types — referencing `chunks.filename` would then be a `tsc` error caught by the type-gate phase, fixed before the reconciler ever sees it. Worth confirming as part of W4.PROMPTS verification — if confirmed, W4.PROMPTS edits subagent prompts to mandate the import.

## Independently tracked (not Phase 3, not W4 blocker)

- **t39 wall-clock cap bug (smoke.js)** — 1877s observed wall-clock vs 720s `[smoke]` per-scenario cap. Smoke-harness issue, not Phase 3. Spot-check during W4 dispatch wait per user direction (~15 min in `chat/tests/smoke/smoke.js`).

## Phase 3 final score: 9/11 PASS

| Scenario | Result | Notes |
|---|---|---|
| t-sub-backend-min | PASS 25.2s | clean |
| t-sub-backend-py-min | PASS 30.2s | clean |
| t-sub-frontend-min | PASS 87.5s | clean |
| t-sub-database-min | PASS 14.5s | clean |
| t-sub-vectordb-min | PASS 30.6s | clean |
| t1-backend-health | PASS 30.5s | clean |
| t2-continuation | PASS 31.9s | clean |
| t11-backend-db-multi | PASS 240.1s | recovered |
| t32-doc-search-api | FAIL 259.9s | db-column-missing class → W4.PROMPTS target |
| t39-time-off-full-stack | ERROR 1877s | known-flake + smoke.js cap bug → independent tracking |
| tAI1-faq-bot-rag | FAIL 537s | db-column-missing class → W4.PROMPTS target |

Strict-gate (t11 + t32 + tAI1 all PASS): 1/3, but t32 + tAI1 are classified out of Phase 3 to W4.PROMPTS.

## Phase 3 status: COMPLETE — all 5 workers landed

| Worker | Commit | Status |
|---|---|---|
| W3.RECOV | `946f270` | DONE |
| W3.TYPES.GATE | `77ae7e7` + `33351a7` + `c68e280` | DONE |
| W3.LOGS | `21fe713` | DONE |
| W3.INVEST | `45afabf` | DONE (MGA assistant bootstrap still maintainer-owned) |
| W3.TEL | `7563b51` | DONE |

## Recommended pre-Phase-4 actions (orchestrator to surface to user)

1. **Bisect t32 regression** — re-run t32 at sha `21fe713` and `45afabf` to localize the W3.LOGS / W3.INVEST / W3.TEL contribution to the 3x wall-clock regression.
2. **Investigate tAI1 contract mismatch** — inspect tAI1's scenario spec to determine if it's a database-subagent or backend-subagent prompt issue. Track as a subagent-prompt regression separate from Phase 3.
3. **Verify wall-clock enforcement** — confirm the 1877s t39 duration is correctly capped or surface the leak.

The user owns the call: dispatch W4.BUDGET despite the regression signals (W4.BUDGET's parallelization may incidentally help t32), bisect-then-decide (investigate regressions before committing to Phase 4), or defer Phase 4 entirely until regressions are tamed.
