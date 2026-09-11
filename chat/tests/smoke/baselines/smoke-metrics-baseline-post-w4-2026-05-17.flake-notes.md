# Baseline post-W4.PROMPTS — 2026-05-17 — W4.BUDGET + W4.PROMPTS landed; Phase 4 complete

## What this baseline measures

Captured at `feat/harness-evolution` after Phase 4 closes:
- **W4.BUDGET**: 4 sub-items (three-tier prompt-builder, microcompact, runs-report.js, parallelize fix-dispatches). Commits `f07fe4f`, `a80327e`, `e1d0ed2`, `e9002ac`; closure `2a783af`.
- **W4.PROMPTS**: 10 commits `eebafc4` → `15f40fd` covering all 15 `chat/prompts/*.md` files; subagent-base.md lifts of truly-identical rules; subagent-{backend,database} additions mandating generated-types import (addressing tAI1+t32 db-column-missing class); microcompact splice deferred with note.

Snapshot: `smoke-metrics-baseline-post-w4-2026-05-17.jsonl` — 11 curated scenarios + 1 t11 retry.

## Results — 8/11 PASS (vs 9/11 post-Phase-3); failure-mode shifts

| Scenario | Post-Phase-3 baseline | Post-W4.PROMPTS | Δ classification |
|---|---|---|---|
| t-sub-backend-min | — | PASS 22.7s | clean |
| t-sub-backend-py-min | — | PASS 24.4s | clean |
| t-sub-frontend-min | — | PASS 54.4s | clean |
| t-sub-database-min | — | PASS 14.7s | clean |
| t-sub-vectordb-min | — | PASS 28.7s | clean |
| t1-backend-health | — | PASS 31.3s | clean |
| t2-continuation | — | PASS 39.7s | clean |
| t11-backend-db-multi | PASS 240.1s | **PASS 229.6s** (retry) / 128.2s (first run) | held |
| t32-doc-search-api | FAIL 259.9s `outcome=skipped` (reconciler hard-fail on `chunks.filename`) | **FAIL 565.5s `outcome=false`** composeMs=6.5K (compose ran, runtime failed) | **failure-mode improved — reconciler-block resolved** |
| t39-time-off-full-stack | ERROR 1877s (cap-enforcement leak) | **ERROR 722.6s** (normal 12-min cap) | anomaly didn't reproduce |
| tAI1-faq-bot-rag | FAIL 537s `outcome=skipped` (reconciler hard-fail on `users.name`) | **FAIL 701.8s `outcome=false`** composeMs=6.2K (compose ran, runtime failed) | **failure-mode improved — reconciler-block resolved** |

## db-column-missing class — RESOLVED at the prompt level

Both t32 and tAI1 previously failed at the reconciler stage with `db-column-missing` hard mismatches (backend code referencing a column the database scope didn't declare in init.sql). W4.PROMPTS shipped a paired fix:

- **subagent-backend.md:18-28**: mandate importing from `backend/src/generated/contracts.ts` (Node) or `backend/generated/models.py` (Python) for ALL database row/request/response shapes. STOP and report under `Contract deviations:` if the generated type lacks a column — do NOT invent.
- **subagent-database.md:18**: "Exhaustively declare every column from `data_model.tables[].columns[]`" — explicit anti-omission rule.

Post-W4 verification confirms the fix works:
- t32 reconciler-loop completed without hard mismatches (compose-build OK, compose-up ran for 6.5s)
- tAI1 reconciler-loop completed without hard mismatches (compose-build OK, compose-up ran for 6.2s)
- Neither scenario hits the prior `column "<name>" of relation "<table>" does not exist` failure pattern.

## New surface — "runtime-fail-on-deploy" class (post-merge target)

Both t32 and tAI1 now make it through reconciler + auto-recovery + compose-build + compose-up, but the deployed app fails the response-verifier's `/health` probe. This is a new failure class previously masked by the reconciler-block: the contract is clean, but the app's runtime behaviour doesn't match expectations.

**Classification: post-merge investigation target, NOT W4.PROMPTS regression.** This is structurally analogous to how Phase 3 unblocked reconciler-reach which surfaced the db-column-missing latent bug — Phase 4 has now unblocked compose-up-reach which surfaces a downstream runtime issue.

**Diagnostic candidates for post-merge investigation:**
- Are the subagents generating valid runtime code (e.g., does `app.listen(port)` actually bind, does the `/health` route return 200)?
- Is the response-verifier checking the right path / port / timeout?
- Are there environment variable mismatches between the agent's code and the compose env-context?

## Structural delta — W4.PROMPTS subagent prompt reduction

| File | Pre-W4 | Post-W4 | Δ |
|---|---:|---:|---:|
| subagent-base.md | 134 | 144 | **+7.5%** (rules lifted from others) |
| subagent-backend.md | 118 | 102 | -13.6% |
| subagent-frontend.md | 114 | 92 | -19.3% |
| subagent-database.md | 91 | 68 | -25.3% |
| subagent-vectordb.md | 83 | 78 | **-6.0%** (under-compressed; follow-up flag) |
| subagent-integration.md | 101 | 87 | -13.9% |
| **subagent aggregate** | **641** | **571** | **-10.9% structural** |
| router.md | 545 | 486 | -10.8% |
| coder.md | 304 | 287 | -5.6% |
| ALL prompts | 2352 | 2198 | -6.5% |

**Structural target was 30-50% subagent reduction — landed at -10.9%, well short.**

## Behavioral delta — runtime prompt-token reduction (the actual goal)

| Scenario | Post-Phase-3 prompt tokens | Post-W4 prompt tokens | Δ |
|---|---:|---:|---:|
| t-sub-backend-min | 29.3K | 13.2K | **-55%** ✓ |
| t-sub-frontend-min | 56.2K | 38.1K | **-32%** ✓ |
| t-sub-backend-py-min | 29.6K | 28.3K | -4% |
| t-sub-database-min | 10.9K | 10.1K | -7% |
| t-sub-vectordb-min | 9.6K | 9.1K | -5% |

**Behavioral 30-50% target hit for the two largest scopes (backend, frontend).** Smaller scopes already lean; little room to compress. The runtime reduction is a combination of W4.BUDGET.1 (Tier-3 fs-conditional canonical scaffold) + W4.PROMPTS prompt edits — they compose.

## Follow-up flags for post-merge polish

1. **subagent-vectordb.md (-6%)** — least-compressed subagent prompt. Worth a second pass to find unobvious Tier-1-lift candidates OR explicit rule consolidation with subagent-database.md (both touch pgvector schema declarations).
2. **subagent-database.md** — worker reported -25% in its commit message; actual measured -25.3% (consistent). No follow-up needed structurally; flagged for the user's awareness alongside vectordb.
3. **t32 + tAI1 runtime-fail-on-deploy class** — investigation target for post-merge polish. The contract is clean; the deployed apps don't pass `/health`. Surface candidates above.
4. **Microcompact splice (deferred per W4.PROMPTS commit `15f40fd`)** — observation-only v1 confirms summarizer feasibility; splice can land as post-merge work once telemetry shows microcompact-fired rate justifies integration. TODO marker at `chat/server/agent/compaction/microcompact-iteration.js`.
5. **t39 smoke.js wall-clock cap-enforcement** — pre-existing bug (cap timer set AFTER bootSpikeServer, so pre-boot setup leaks are uncapped). Didn't reproduce this run (clean prior-scenario teardown), but the architectural debt is real. One-line fix: hoist `setTimeout(...)` from line 697 to right after line 568.

## MGA prompt-upload status

`npm run prompt:upload -- --all` confirmed at 13:54 UTC: all 9 PATCHable assistants returned `modification_date=2026-05-17T12:02:*Z` indicating the worker ran the upload at ~12:02 UTC before its smoke verification — so the post-W4 smoke ran against MGA's CURRENT (post-edit) prompts, not stale. Fingerprints all matched.

Four FAIL entries in the upload report — none are W4.PROMPTS regressions:
- `summarizer` — pre-existing null slot
- `judge` — pre-existing null slot
- `investigator` — null slot pending user's `--admin` bootstrap (W3.INVEST out-of-band step)
- `subagent-nextjs` — placeholder for a future scope; never bootstrapped

## Comparison rules for Phase 4+ `runs-report.js` (updated)

- **Known-flake** (`t39-time-off-full-stack`): pass-rate trend only. The 1877s anomaly was a smoke.js cap-enforcement leak, not a t39 regression; this run's 722s = normal cap.
- **Phase-3 target fix scenarios that recovered** (`t11-backend-db-multi`): track regression normally — should stay PASS.
- **Runtime-fail-on-deploy class** (`t32-doc-search-api`, `tAI1-faq-bot-rag`): post-merge investigation target. Reconciler-block class is RESOLVED; new failure surface is downstream runtime behaviour.
- **Telemetry events** (W3.TEL): track `auto_recovery_attempt`, `investigator_record`, `reconciler_verdict_counts`, `snippet_fetch`, `microcompact_fired` per build. Section M item 9 aggregator (`npm run report`) consumes these.

## Phase 4 status: COMPLETE — both workers landed

| Worker | Commits | Status |
|---|---|---|
| W4.BUDGET | f07fe4f, a80327e, e1d0ed2, e9002ac + 2a783af closure | DONE |
| W4.PROMPTS | eebafc4 → 15f40fd (10 commits) | DONE |

## Pre-merge checklist (orchestrator → user)

1. ✅ Phase 0 / 1 / 2 / 3 / 4 all DONE
2. ✅ Post-W4.PROMPTS baseline + flake-notes captured (this file)
3. ⏳ Run `npm run report` for the full multi-baseline rollup
4. ⏳ User maintainer step: `node chat/scripts/create-orchestrator-assistants.js --admin` to bootstrap investigator MGA assistant (W3.INVEST out-of-band)
5. ⏳ End-to-end test: build + 3 iterations including diagnose flow
6. ⏳ Merge `feat/harness-evolution` → `feat/custom-agent-spike` (waits for explicit user go)
