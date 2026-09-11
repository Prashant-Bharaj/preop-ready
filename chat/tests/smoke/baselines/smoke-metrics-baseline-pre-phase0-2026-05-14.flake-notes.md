# Baseline pre-Phase-0 — 2026-05-14 — known flakes, baseline-failures, and comparison rules

## What this baseline measures

11-scenario curated subset of the full smoke suite, run against `feat/harness-evolution` (rooted at `feat/custom-agent-spike` HEAD `01cc11c`, then plan-import commits `88ebdc5` + `114e0b4` on top). Captures pre-Phase-0 token / cost / latency / pass-rate state before any harness-evolution worker dispatches.

Setup commits are documentation-only: `git diff feat/custom-agent-spike..HEAD --name-only` returns one file, `docs/HARNESS_EVOLUTION.md`. The pass/fail outcomes here therefore reflect pre-existing `feat/custom-agent-spike` behaviour, not anything introduced by Phase 0 setup.

Snapshot: `smoke-metrics-baseline-pre-phase0-2026-05-14.jsonl` — last 11 entries are this run (2026-05-14 ~19:29-19:57 UTC).

## Per-scenario result summary

| Scenario | Status | Duration | Notes |
|---|---|---|---|
| `t-sub-backend-min` | pass | 23.6s | apiCalls=2, promptTokens=25.6K |
| `t-sub-backend-py-min` | pass | 65.2s | apiCalls=4, promptTokens=52.6K |
| `t-sub-frontend-min` | pass | 64.4s | apiCalls=3, promptTokens=38.7K |
| `t-sub-database-min` | pass | 54.7s | apiCalls=4, promptTokens=44.8K |
| `t-sub-vectordb-min` | pass | 77.7s | apiCalls=4, promptTokens=42.0K |
| `t1-backend-health` | pass | 25.9s | apiCalls=2, promptTokens=25.6K |
| `t11-backend-db-multi` | pass | 164.2s | retries=0, composeMs=6.8K |
| `t2-continuation` | pass | 19.8s | apiCalls=2, promptTokens=25.8K |
| `t32-doc-search-api` | **FAIL** | 361.2s | outcome=skipped — reconciler hard-fail, baseline-class |
| `tAI1-faq-bot-rag` | **FAIL** | 578.4s | outcome=false, composeMs=7184 — reconciler hard-fail then compose-up exited non-zero, baseline-class |
| `t39-time-off-full-stack` | **FAIL** | 603.7s | outcome=skipped — reconciler hard-fail, known flake (recurring weeks) |

8 / 11 passed. Three failures share a root cause; see below.

## Failure classification

### Known-flake (excluded from regression comparison)

- **`t39-time-off-full-stack`** — flake-prone for weeks; recent failures span 2026-05-13 (`build_failed`), 2026-05-14 morning (`outcome=false composeMs=7115`), 2026-05-14 baseline run (`outcome=skipped composeMs=null`). Track as known-flake-pass-rate over time. Failure mode within the flake is the same `db-column-missing` reconciler hard-fail pattern as t32 + tAI1, just intermittent.

### Baseline-class failures (captured for Phase 4 to measure improvement against)

- **`t32-doc-search-api`** and **`tAI1-faq-bot-rag`** — failed in this baseline run with the same root cause:
  - Backend subagent references DB columns (`chunks.created_at`, `users.name`, `users.updated_at`, `users.email`) that the database subagent never declares in `init.sql`.
  - L.3 reconciler correctly detects `db-column-missing` hard mismatches, attempts up to `PER_SCOPE_REENGAGE_BUDGET=2` re-engages, gives up when the DB scope still doesn't add the columns.
  - Compose is then skipped (t32) or runs and exits non-zero (tAI1).
- **This is the failure class the harness-evolution plan is explicitly designed to fix.** Specifically:
  - **Section O (typed contracts, Phase 1)** — backend imports types generated from `data_model`; cannot reference a column not in the contract because `tsc` / `mypy --strict` would fail before compose.
  - **Section F (auto-recovery loop, Phase 3)** — re-dispatches the DB scope with explicit "backend code reads these columns: ..." failure context as the spawn message, not a re-engage of the same broad prompt.
  - **Section G (cascade, Phase 2)** — when `data_model` changes, regenerated types break compilation in exactly the scopes that referenced the renamed/removed item.
- Therefore: t32 and tAI1 are **expected to remain failing through Phase 0 and into Phase 1 first-cut**, and **expected to start passing during Phase 1 (O) / Phase 3 (F) verification** as those mechanisms land. Phase 4 measures the recovery: pre-Phase-0 baseline 0/2 → post-Phase-4 target 2/2 (or at minimum 1/2 with the remaining failure surfaced to the user via a clear "user-attention" report, not a silent skip).

## Why these are not blockers for Phase 0 worker dispatch

Earlier framing in this plan said "non-t39 failures would block Phase 0 workers." That was a guard against regressions introduced by setup itself. The failures here are **pre-existing on `feat/custom-agent-spike`** and **untouched by the harness-evolution work scoped for Phase 0** (W2.NARROW = subagent prompt edits for stack narrowing; W1.TYPES.SNIPPETS = TS/Tailwind/shadcn migration). Neither worker fixes the column-mismatch issue, but neither makes it worse either. The fix lands in Phases 1 and 3.

The blocker rule re-stated more precisely: a non-flake failure that **regresses** between pre-Phase-0 and post-Phase-0 baselines (i.e., a scenario that passed in this baseline starts failing after W2.NARROW / W1.TYPES.SNIPPETS) blocks Phase 1. A failure that's already in the baseline stays in the baseline.

## Comparison rules for Phase 4 `runs-report.js`

- **Known-flake scenarios** (`t39-time-off-full-stack`): report pass-rate trend over time, never single-run regression.
- **Baseline-class failures** (`t32-doc-search-api`, `tAI1-faq-bot-rag`): track as "fix scenarios" — Phase 4 explicitly verifies these moved from FAIL → PASS as a measure of Section O + Section F success. If they still fail at Phase 4 end, the plan did not deliver on its primary value claim.
- **All other scenarios**: report single-run regression normally; pre-Phase-0 → post-Phase-4 deltas in tokens / latency / cost / pass-rate.
- Token / latency / cost trends include all scenarios (most per-scenario MGA spend is upstream of compose-up, so failure status doesn't meaningfully degrade these signals).
