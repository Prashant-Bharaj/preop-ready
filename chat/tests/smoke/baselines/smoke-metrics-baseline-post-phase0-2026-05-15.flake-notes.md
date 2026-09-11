# Baseline post-Phase-0 — 2026-05-15 — known flakes, baseline-class deltas, and comparison rules

## What this baseline measures

Same 11-scenario curated subset as the pre-Phase-0 baseline, run against `feat/harness-evolution` HEAD `8c37607` (after all Phase 0 commits landed: W2.NARROW, W2.NARROW.RULES, smoke-scenario drops, W1.TYPES.SNIPPETS, W1.PATHS.CANONICAL, orchestrator-side snippet-filename residual closure).

Captures the state after Phase 0's stack standardization (Postgres + pgvector + TS + Tailwind + shadcn) and before any Phase 1 worker dispatches. Phase 4 then reports both the total delta (pre-Phase-0 -> post-Phase-4) and the Phase-1-to-4 delta (this snapshot -> post-Phase-4) so harness-evolution improvements are isolated from stack-standardization cost/benefit.

Snapshot: `smoke-metrics-baseline-post-phase0-2026-05-15.jsonl` — last 11 entries are this run.

## Per-scenario result summary + delta vs pre-Phase-0

| Scenario | Pre | Post | Delta | Classification |
|---|---|---|---|---|
| `t1-backend-health` | 25.9s pass | 33.4s pass | +29% | TS scaffold cost |
| `t2-continuation` | 19.8s pass | 26.9s pass | +36% | TS scaffold cost |
| `t11-backend-db-multi` | 164s pass | 207s pass | +26% | TS+multi-stage cost |
| `t-sub-backend-min` | 23.6s pass | 40.7s pass | +72% (small base) | TS scaffold dominates |
| `t-sub-frontend-min` | 64.4s pass | 101s pass | +57% | TS+Tailwind cost |
| `t-sub-backend-py-min` | 65.2s pass | 59.8s pass | -8% | wash (Python untouched) |
| `t-sub-database-min` | 54.7s pass | 18.2s pass | **-67%** | W2.NARROW.RULES win |
| `t-sub-vectordb-min` | 77.7s pass | 30.2s pass | **-61%** | W2.NARROW.RULES win |
| `t32-doc-search-api` | 361s **fail** | 455s **fail** | +26% slower, same root cause | baseline-class failure unchanged |
| `tAI1-faq-bot-rag` | 578s **fail** | 257s **PASS** | **-56% AND recovered** | **baseline-class FAIL -> PASS** |
| `t39-time-off-full-stack` | 604s fail | 279s fail | -54% but different failure mode | flake (mode shifted) |

**Net: 9 PASS / 2 FAIL (pre was 8 PASS / 3 FAIL).** One baseline-class failure recovered (tAI1).

## Failure-mode classification (post-Phase-0)

### Known-flake scenarios

- `t39-time-off-full-stack` — flake; failure mode CHANGED:
  - Pre-Phase-0: `outcome=skipped` (reconciler hard-fail on `db-column-missing` for `requests.name`, `requests.email`; never reached compose).
  - Post-Phase-0: `outcome=build_failed` (reconciler passed; `docker compose build` returned non-zero at 16.9s).
  - Interpretation: Phase 0 narrowing tightened cross-scope alignment enough to clear the reconciler stage, but the new multi-stage `Dockerfile.node` (with `tsc` build) trips on a different issue. Likely candidates: subagent didn't include `typescript` in devDependencies, or `tsc` found type errors in the generated backend code. **W3.TYPES.GATE (Phase 1) is designed exactly for this** — wiring `tsc --noEmit` into the auto-recovery loop as a fast pre-compose check.
  - Tracked as known-flake-pass-rate; excluded from regression comparison.

### Baseline-class failures (still failing — explicitly Phase 1's job)

- `t32-doc-search-api` — same `db-column-missing` failure as pre-Phase-0. Backend's `vectordb-connections.ts` references `documents.title`, `documents.metadata`, `documents.updated_at`, `chunks.metadata`; init.sql doesn't declare them. Reconciler hard-fails. Phase 0 didn't address this (snippet migration is upstream of the contract enforcement). **Section O type generator (W1.TYPES.GEN in Phase 1) is the planned fix** — backend imports types from `.harness/contracts.json` and tsc fails if it references a column outside the contract.

### Baseline-class failures recovered in Phase 0

- `tAI1-faq-bot-rag` — pre-Phase-0 failed with `db-column-missing` for `users.name`, `users.updated_at` (same class as t32 + t39 pre). **Post-Phase-0 PASSES.** Why this one recovered without W1.TYPES.GEN: the narrowed prompts (W2.NARROW.RULES dropped ~50% of vectordb prompt + simplified DB scope guidance) plus the cleaner canonical-path discipline (W1.PATHS.CANONICAL) appear to have reduced the cross-scope ambiguity that drove the schema misalignment. Single data point; could regress on a re-run. Worth re-verifying as part of Phase 1 verification.

## Phase 0 cost/benefit summary

**Net costs:**
- TS scaffold overhead on Node + frontend subagents: +25-70% per scenario (one extra LLM turn for tsconfig.json, larger package.json, more verbose typed scaffolds).
- Multi-stage `Dockerfile.node` adds 3-10s per `docker compose build` invocation (Stage 1 runs `tsc`).
- Slightly larger inlined prompts (~+1.5% per MGA call from cumulative platform-rules + base-prompt growth across W2.NARROW.RULES + W1.PATHS.CANONICAL + orchestrator residuals).

**Net wins:**
- `t-sub-database-min` -67%, `t-sub-vectordb-min` -61% (smaller prompts after engine narrowing).
- `tAI1-faq-bot-rag` FAIL -> PASS (-56% faster AND recovered — one baseline-class failure resolved without W1.TYPES.GEN).
- `t39` flake duration cut in half (failure mode shifted from reconciler-stage to compose-build-stage — diagnostic clarity improved).

## Comparison rules for Phase 4 `runs-report.js`

- **Known-flake scenarios** (`t39-time-off-full-stack`): report pass-rate trend; don't single-run-regress. Note that failure mode may shift across phases (currently `build_failed` post-Phase-0, was `skipped` pre-Phase-0) — track both outcomes.
- **Baseline-class fix scenarios** (`t32-doc-search-api`, formerly `tAI1-faq-bot-rag`): track explicitly. t32 should move FAIL -> PASS in Phase 1 verification (W1.TYPES.GEN), confirming Section O works as designed. tAI1 should STAY PASS through Phase 1 (and if it regresses, that's a real Phase 1 worker bug).
- **All other scenarios**: regression normally. Token / latency / cost trends pre-Phase-0 -> post-Phase-4 captures total benefit; this snapshot -> post-Phase-4 captures Phase 1-4 benefit isolated from Phase 0 stack-standardization cost.

## New drift observations from this run (for Phase 1 awareness)

- `frontend/vite.config.js` auto-fill safety net in `chat/server/agent/agent.js` still fires (observed at `[10:24:06] auto-filled missing frontend/vite.config.js`). After W1.PATHS.CANONICAL the snippet is `vite-react-config.ts` and the on-disk target should be `vite.config.ts`. The auto-fill helper appears to still produce `.js`. Minor — agent typically writes the config itself before the safety net fires — but worth a cleanup commit alongside the other agent.js + autoFillDockerfile residuals.
- `[summarizer] summarizerAssistantId not set` log line — purely informational; summarizer is an optional component, not deployed.
- Subagent prompt token counts grew but did not trigger the autocompact threshold; cache-hit behavior looks normal.
