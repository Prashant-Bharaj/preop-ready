/**
 * Centralized runtime-tunable defaults — timeouts and per-call budgets.
 *
 * Values that were previously inline numeric literals scattered across
 * chat/server/. Consolidating them gives ops a single tuning surface
 * and makes the rationale for each value (observed worst-case latency,
 * dependent-service start-up cost, MGA SLA expectations) live next to
 * its peers rather than in 20 different file comments.
 *
 * Behaviour intentionally identical to pre-L.4: every value here matches
 * what was at the original site. Touch with care — tuning a timeout
 * down is the kind of change that should be paired with telemetry to
 * confirm it doesn't shed legitimate slow-but-completing operations.
 */

// ── Docker / Compose ──────────────────────────────────────────────────
// Default cap for `runCompose(cmd, ...)` callers that don't specify one.
// Generous because compose subcommands vary wildly: `config` is sub-second,
// `up -d` against a healthcheck chain can take minutes. Specific callers
// override with the targeted constants below.
export const COMPOSE_DEFAULT_MS = 120_000;
// `docker compose build`. Multi-stage Dockerfiles + npm install on cold
// cache can legitimately take 5-8 minutes. 10 min ceiling keeps build
// hangs from being silent without rejecting real builds.
export const COMPOSE_BUILD_MS = 600_000;
// `docker compose up -d --no-build`. With `depends_on: service_healthy`
// chains, the command waits for healthchecks to pass before returning.
// A 4-service stack (database + backend + frontend + auxiliary) can
// legitimately take 60-90s for postgres' default start_period. Observed
// t39 hit exactly 60022ms with 60s cap; 180s gives the chain headroom
// without making real failures slow to surface.
export const COMPOSE_UP_MS = 180_000;
// `docker compose down` (quick cleanup before a fresh up). Containers
// should stop in seconds; 30s is generous backstop.
export const COMPOSE_DOWN_MS = 30_000;
// `docker compose down -v --remove-orphans` (deeper cleanup at session
// delete). `-v` removes named volumes — postgres data dirs with init
// scripts can take a few seconds extra. 60s separates the deep cleanup
// from a normal compose-down.
export const COMPOSE_DOWN_DEEP_MS = 60_000;
// `docker compose logs backend --tail=80 --no-color`. Fast on healthy
// containers, slow if the log buffer is huge or container is stuck.
export const COMPOSE_LOGS_MS = 15_000;
// `docker info` — daemon-availability probe at boot. If docker is up
// it returns instantly; if not, fail fast so we surface a useful error.
export const DOCKER_INFO_PROBE_MS = 5_000;

// ── HTTP probe (waitForHttp) ──────────────────────────────────────────
// Total budget the smoke step gives the frontend to start serving HTTP.
// 30s sits above the slowest legitimate boot we've seen for a single-
// service nginx container; longer waits usually mean the backend it
// depends on never came up healthy.
export const HTTP_PROBE_TOTAL_MS = 30_000;
// Default poll interval between fetch attempts (function default).
export const HTTP_PROBE_POLL_MS = 1_000;
// Smoke-call override — polls 50% less often so the log isn't spammed
// during the typical 5-10s startup window.
export const HTTP_PROBE_POLL_LIVE_MS = 1_500;
// Per-fetch cap inside the polling loop. Short so a hung connection
// doesn't eat the whole poll-interval budget before the next attempt.
export const HTTP_PROBE_REQUEST_MS = 4_000;

// ── MGA platform fetches (chat/server/core/auth.js) ───────────────────
// Preflight-style `/models` listing with current stored creds. Used by
// settings UI to populate model dropdowns; should respond instantly on
// healthy MGA.
export const MGA_PREFLIGHT_MS = 10_000;
// Heavier `/models` listings: external-key validation (UI types a fresh
// key and we validate it against MGA) and the MGA-specific models route.
// First-auth-validated requests can take longer than steady-state ones.
export const MGA_VALIDATE_MS = 15_000;
// Health-route probes — `/models` quick GET and `/assistants/<id>` reach-
// ability check. Faster cap since these are diagnostic endpoints; a slow
// response here means MGA is degraded, surface fast.
export const MGA_HEALTH_PROBE_MS = 8_000;

// ── Reconciler (judge + loop) ─────────────────────────────────────────
// Per-call cap on a single MGA judge-extras request. Median ~10s on
// healthy MGA; max observed ~18s in clean runs, ~56s under burst load
// (3/30 calls in one t39 sample). 30s catches genuine hangs while
// letting healthy-burst stragglers complete. Aborted calls fall through
// to judgeExtras' kind-aware fallback — see [chat/server/reconciler/judge-extras.js].
export const JUDGE_CALL_TIMEOUT_MS = 30_000;
// Wall-time bound on the entire cross-scope reconciler loop. Observed
// worst-case t39 sample hit 338s with a database scope hitting budget
// 2/2; 5min cap lets the loop finish slow but bounded re-engages while
// preventing runaway. Aborts gracefully into the final-pass diagnostic.
export const RECONCILER_PHASE_TIMEOUT_MS = 5 * 60 * 1000;
// Max times a single scope can be re-engaged within one reconciler run.
// Maintains the pre-L.3 implicit cap (outer loop ran 2 rounds) but makes
// it explicit and scope-local: a scope that keeps generating mismatches
// no longer pointlessly delays scopes that already converged.
export const PER_SCOPE_REENGAGE_BUDGET = 2;

// ── Git / probe utilities ─────────────────────────────────────────────
// Read-only git calls (`log --oneline -10`, `status --porcelain`). Local
// repos answer in milliseconds; cap is purely a hang backstop.
export const GIT_QUICK_MS = 3_000;
// Heavier git operations (used by git-meta.js for SHA + branch lookups).
export const GIT_META_MS = 5_000;
// `git checkout HEAD -- <file>` for reverting per-file edits. Local fs
// operation; 10s is generous in case the working tree is large.
export const GIT_CHECKOUT_MS = 10_000;
// `lsof -i :<port>` style probe for host-port collision detection.
export const PORT_PROBE_MS = 5_000;
// Misc env-detection execSync — codespace detection, gh CLI presence.
export const ENV_DETECT_MS = 3_000;

// ── Subprocess / scripts ──────────────────────────────────────────────
// Bash scripts spawned by routes (post-confirm checks) and env-context
// (codespace info). Long enough for a couple of `gh api` round-trips,
// short enough to fail fast on a hung shell.
export const BASH_SCRIPT_MS = 10_000;
// Idle-kill timer for tool-execed user commands (e.g. `npm test` left
// idling). Resets on each chunk of stdout/stderr; final fire kills the
// process group.
export const EXEC_IDLE_KILL_MS = 5_000;

// ── Type generator (W1.TYPES.GEN — HARNESS_EVOLUTION.md §O) ───────────
// Per-call cap on the type-generator's `tsc --noEmit` self-test of its
// own emitted TS. Should complete in <2s on healthy systems; 10s ceiling
// backstops daemon hangs (corrupt npm cache, hung child).
export const TSC_SELF_TEST_MS = 10_000;

// ── Contract cascade (W2.CASCADE — HARNESS_EVOLUTION.md §G) ───────────
// Wall-clock cap on the cascade's filesystem grep across the user-app
// workspace. Typical user apps have a few hundred greppable source files
// (.sql/.ts/.tsx/.js/.jsx/.py/.json) so the scan finishes in <2s. The 30s
// ceiling backstops pathological cases (huge generated checkouts the
// path-exclusion filter missed, hung NFS-style mounts). On timeout the
// cascade emits a `cascade_incomplete` event + falls open: dispatch
// proceeds with the router-emitted affected_scopes unmodified.
export const CASCADE_GREP_TIMEOUT_MS = 30_000;

// ── Auto-recovery (W3.RECOV — HARNESS_EVOLUTION.md §F) ────────────────
// Max times a single scope can be re-dispatched by the auto-recovery loop
// for fix-attempts (distinct from PER_SCOPE_REENGAGE_BUDGET above, which
// governs reconciler re-engages within runReconcilerLoop). 2 = original
// attempt + 1 retry. Matches the reconciler value but the concepts are
// distinct: reconciler re-engages drive contract reconciliation;
// auto-recovery fix-attempts drive higher-level failure recovery
// (structural-check / file-structure-check / runtime-assert failures).
//
// Bumped 2 → 3 after wiring per-scope conversation continuity across
// fix rounds (auto-recovery.js + phase-tools.js, same date). Convergence
// trajectory on t6 went from "16 → 12 errors" (no continuity, exhausted)
// to "16 → 9 → 5 errors" (with continuity, exhausted at 2 rounds with
// clean fixable trajectory). The original "going to 3 rarely helps"
// note assumed amnesia between rounds — with continuity, each round
// actually builds on the last and 3 is now the right ceiling. Beyond 3,
// the agent likely needs a structural fix (prompt change, scaffold
// adjustment) rather than another retry.
export const MAX_FIX_ATTEMPTS_PER_SCOPE = 3;
// Defensive ceiling on cumulative MGA tokens spent inside the auto-
// recovery loop for a single build. Post-W3.TYPES.GATE empirical: tAI1
// (5-scope RAG, 24 type errors across backend+frontend in one round)
// used 244K real tokens in a single full fix-dispatch round; the prior
// 200K cap tripped before the type-gate could re-verify. 400K = ~2x
// observed multi-scope recovery usage; comfortable headroom. The
// pre-W3.TYPES.GATE rationale ("sized for 50-100K normal builds, 200K =
// 50-100% headroom") was based on simpler scenarios — multi-scope
// recovery is the new dominant cost source. Tune via Phase 4 telemetry
// as more multi-scope data accumulates. On trip, the recovery loop
// emits `[auto-recovery] tokens-budget-exhausted` (or `[type-gate-phase]
// tokens-budget-exhausted` from the pre-reconciler phase) and ends the
// recovery phase early, surfacing remaining failures to the user.
export const MAX_RECOVERY_TOKENS_PER_BUILD = 400_000;
// Post-compose endpoint verification (reconciler/endpoint-probe.js).
// Per-request cap; LLM-backed endpoints get the longer AI cap (an MGA
// round-trip runs 10-30s). Total phase ceiling bounds pathological
// contracts — probes past it are marked skipped, never failed.
export const ENDPOINT_PROBE_REQUEST_MS = 10_000;
export const ENDPOINT_PROBE_AI_REQUEST_MS = 45_000;
export const ENDPOINT_PROBE_TOTAL_MS = 240_000;
// Separate from MAX_FIX_ATTEMPTS_PER_SCOPE: the pre-compose phases may
// have already exhausted fixAttempts on the messiest builds — reusing
// that counter would silently disable runtime self-healing exactly when
// it's needed most.
export const MAX_PROBE_FIX_ATTEMPTS_PER_SCOPE = 2;
// Pre-staged file is considered "agent never filled it in" if its on-disk
// size is below this byte threshold. Used by file-structure-check to flag
// canonical entry files that the harness pre-staged but the subagent
// never wrote real content into (e.g. backend/src/index.ts left as the
// single-comment stub). 200 bytes is generous — even a minimal Express
// `app.listen(3000)` exceeds this.
export const STUB_SIZE_THRESHOLD = 200;

// ── Investigator (W3.LOGS — HARNESS_EVOLUTION.md §B + §N) ────────────────
// Byte ceiling on the post-stripAnsi log payload that `read_container_logs`
// returns to the investigator agent. 50 KB is roughly ~500 lines @ ~100
// bytes/line — enough for a meaningful crash trace (stack + a few seconds
// of surrounding context) without blowing the investigator's prompt budget.
// When the cap is hit the tool truncates from the HEAD and returns
// `truncated: true` so the investigator keeps the most-recent lines (which
// are also what `docker compose logs --tail=N` already biases toward; the
// head-truncation here only fires when --tail still emits >50 KB of bytes,
// e.g. a service has logged enormous JSON blobs).
export const MAX_LOG_FETCH_BYTES = 50 * 1024;

// ── Investigator (W3.INVEST — HARNESS_EVOLUTION.md §B / §D / §F) ─────────
// Confidence threshold the investigator's `confidence` field (float in
// [0.0, 1.0]) must meet or exceed for the orchestrator to AUTO-FIX without
// user friction (synthetic `iterate` dispatch to `affected_scopes`). Below
// this, the harness surfaces the diagnosis (root_cause + recommended_fix
// description) to the user as a cline `say:'text'` event and idles — the
// user decides next. 0.7 is "more likely than not, well-grounded" — at this
// confidence we trust the read-only investigator enough to spend tokens on
// a fix dispatch; under it, the cost of a wrong auto-fix (token spend +
// potential regression) outweighs the friction of surfacing the diagnosis.
// Tune via Phase 4 telemetry as `investigator_report` events accumulate
// (W3.TEL captures the distribution).
export const INVESTIGATOR_AUTO_FIX_CONFIDENCE = 0.7;
// Wall-clock cap on a single investigator run (one `runCustomAgent` call
// with phase=PHASES.INVESTIGATING). A read-only diagnostic agent reading a
// handful of files + container logs should complete in <60s; the 3-minute
// ceiling backstops hung MGA calls / stuck file reads without rejecting
// slow-but-completing diagnostics on a chatty service or a deep file scan.
// Mirrors L.3's RECONCILER_PHASE_TIMEOUT_MS pattern — wall-time bound on a
// distinct multi-call MGA phase, distinct from per-call MGA budgets.
export const INVESTIGATOR_PHASE_TIMEOUT_MS = 3 * 60 * 1000;

// ── Microcompact (W4.BUDGET — HARNESS_EVOLUTION.md §J) ─────────────────────
// Threshold for the between-iterations microcompact trigger: when the
// virtual-history token estimate exceeds this ratio of the model context
// window, the agent loop invokes the Summarizer assistant to compact the
// oldest tool-result blocks. v1 conservative threshold — well below the
// pre-existing rotation threshold (DEFAULT_COMPACT_THRESHOLD_TOKENS in
// triggers.js ≈ 80% of effective window) so microcompact fires earlier and
// catches growth before MGA's hard cap is in sight. Tune via Phase 4
// telemetry once `microcompact_fired` event volume + ratio data
// accumulates. 0.5 is intentionally cautious; first deploy should run a
// few rounds and confirm we're not pre-empting useful context.
export const MICROCOMPACT_HISTORY_THRESHOLD_RATIO = 0.5;
// Assumed model context window in tokens. Claude Opus ships with 200K. The
// `MICROCOMPACT_HISTORY_THRESHOLD_RATIO` is applied against this value to
// produce the absolute trigger threshold. If we ever route to a smaller
// model (Haiku 200K too; Sonnet 200K too — but if a future Bayer-served
// model shrinks the window, override here). Reactive `prompt-too-long`
// rotation in agent.js stays as the safety net regardless of this value.
export const MICROCOMPACT_MODEL_WINDOW_TOKENS = 200_000;
// Number of oldest tool-result blocks to summarise per microcompact firing.
// Section J: "smallest number that brings history back under 50% (typically
// 1-2 oldest blocks suffice)". v1 stays at 2 — picked over 1 to avoid
// firing repeatedly within a few iterations when a single large block
// only partially offsets the overage. Tune via telemetry.
export const MICROCOMPACT_OLDEST_BLOCKS_TO_SUMMARISE = 2;

// ── Type-gate (W3.TYPES.GATE — HARNESS_EVOLUTION.md §O) ──────────────────
// Wall-clock cap on a single `tsc --noEmit` / `mypy --strict` invocation
// run as the first detector inside the auto-recovery loop. Median
// invocation completes in <5s on a populated workspace; the 30s ceiling
// is a hang backstop for pathological cases (corrupt @types tree, hung
// child process pulling in a massive node_modules graph). On timeout the
// type-gate soft-skips so the existing downstream detectors (structural-
// checks / file-structure-check / runtime-asserts) still run.
export const TYPE_GATE_TIMEOUT_MS = 30_000;
// Byte ceiling on the formatted type-error block that becomes spawn-
// message context for the fix-dispatch subagent. Raw tsc output can be
// thousands of lines for severe failures (cascading errors from one root
// cause); 8 KB caps the prompt-budget impact while leaving room for the
// first ~10 errors per file with 3 lines of source context each. Format
// truncates at a file boundary so the agent never sees a half-rendered
// error frame. The first ~10 errors usually carry the signal; once those
// land the agent re-runs the gate and the cascade collapses.
export const MAX_TYPE_ERROR_CONTEXT_BYTES = 8_000;

// Runtime-gate (Alt A — per-scope docker build + run + minimal probe).
// Runs in the pre-reconciler phase right after type-gate. Catches
// crash-on-start, missing modules at runtime, Dockerfile errors, nginx
// config errors, init.sql parse errors — the class of failures that
// previously only surfaced at full compose-up.
//
// Build timeout: docker build can pull base layers + npm install + tsc;
// 120s covers cold first-run + warm rebuilds. Beyond this we assume the
// build is genuinely stuck and surface the failure.
export const RUNTIME_GATE_BUILD_TIMEOUT_MS = 120_000;
// Probe timeout: container start + service-listening + first 200 response.
// Postgres takes ~5s to be ready; Node/Express ~1-2s; nginx ~1s. 30s
// covers the slow side with margin.
export const RUNTIME_GATE_PROBE_TIMEOUT_MS = 30_000;
// Byte ceiling on rendered runtime-gate failure block (mirrors
// MAX_TYPE_ERROR_CONTEXT_BYTES). docker logs --tail 80 plus header lines
// stays well under this.
export const MAX_RUNTIME_GATE_CONTEXT_BYTES = 8_000;

// ── Per-phase subagent model selection ──────────────────────────────────
// Subagents (backend / frontend / database / vectordb / integration) pick
// their model based on whether this is the initial build of an app or an
// iterate / continuation pass:
//
//   Initial build → INITIAL_BUILD_MODEL — favours quality + determinism.
//     Smarter model pays off here: the contract is fresh, the scaffolding
//     has to be architecturally right the first time, and any drift
//     compounds through every subsequent fix round. Benchmark (t6-smart-
//     docs) 2026-05-23: Opus 4.7 produced fewer ghost-imports (18 vs 24)
//     and cleaner separation of concerns than Sonnet 4.5 at ~3% faster
//     wall-clock, for roughly 1.66x the token cost.
//
//     2026-05-24 — switched from Opus 4.7 to Opus 4.5: identical 1M
//     context window, but Opus 4.7 is an adaptive-thinking model that
//     owns sampling internally and REJECTS the `temperature` parameter
//     (MGA returns 400 "temperature is deprecated for this model"). Opus
//     4.5 accepts temperature=0 AND is deterministic on code generation
//     (5/5 valid, 2 unique hashes, 0.22% char-range spread — 1 char of
//     whitespace drift). Opus 4.7 measured 5-15% spread on equivalent
//     prompts. Opus 4.6 also accepts temperature but its 200K context
//     ceiling is too tight for hard scenarios (backend virtual-token
//     hits 260-290K). 4.5 is the only option that combines 1M context,
//     temperature support, and tight determinism.
//
//   Iterate / continuation → ITERATE_MODEL — favours cost. The surface
//     is already correct; iterate dispatches typically modify a handful
//     of files against a known-good baseline. Sonnet 4.6 is ~5x cheaper
//     per output token than Opus 4.7 and Anthropic's latest generation.
//     200K context is plenty for iterate work (the diff is small).
//
// Env override hooks for testing/experimentation:
//   MGA_MODEL_INITIAL=... overrides INITIAL_BUILD_MODEL
//   MGA_MODEL_ITERATE=... overrides ITERATE_MODEL
//   MGA_MODEL_OVERRIDE=... overrides BOTH (used to force a single model
//     for a whole run — see today's Opus-vs-Sonnet benchmark)
//   MGA_MODEL_OVERRIDE_<SCOPE>=... overrides for one scope (highest
//     precedence; same scope env-var the override chain has used since
//     the original /chat/completions migration).
export const INITIAL_BUILD_MODEL = 'claude-opus-4.5';
// 2026-07-08 — switched to Sonnet 5 (claude-sonnet-5). Live-verified on MGA:
// available, 1M input / 128K output context, vision, and — unlike Opus 4.7's
// adaptive-thinking rejection — ACCEPTS temperature=0 (HTTP 200 verified).
// MGA's own description: "performance close to Opus 4.8 at Sonnet pricing."
export const ITERATE_MODEL = 'claude-sonnet-5';

// Model for CODING subagents (backend/frontend/database/vectordb/integration
// + their fix agents) on INITIAL builds. Tested Sonnet-5 here 2026-07-21
// (matrix 6): crud 3x slower with report=partial, deviation-tracker DNF —
// Sonnet under-delivers on the from-scratch subagent prompts (missing
// scaffold files, fix-round spirals) though it's proven on narrow iterate
// diffs (ITERATE_MODEL, 4 clean ladders). Keep Opus until the subagent
// prompts are Sonnet-tuned; experiment via MGA_MODEL_CODER without touching
// the thinking phases.
export const CODER_MODEL = 'claude-opus-4.5';

// Guaranteed global default model. Used by pickModel for any phase without a
// more specific rule (e.g. CONCIERGE, INVESTIGATING). This is what makes the
// harness runtime-independent of MGA assistant config: every /chat/completions
// call resolves a model from config alone — no getAssistantConfig lookup, so no
// dependency on account-bound assistant IDs. Override with MGA_MODEL_DEFAULT.
export const DEFAULT_MODEL = process.env.MGA_MODEL_DEFAULT || INITIAL_BUILD_MODEL;

// ── Local-dev database connection identity — the single source of truth ──────
// FIXED platform values, NOT project-specific and NOT LLM-chosen. The db
// container (POSTGRES_*), the backend service env (DATABASE_*), and the
// generated backend/src/db.ts defaults must all use these verbatim. The
// synthesized DB report (pre-stage-scaffolds.js) renders them so the agents
// generate matching creds (Layer 1 — prevention), and the credential-
// consistency validator (validators/db/db-credential-consistency-validator.js)
// rewrites any drift back to these before `compose up` (Layer 2 — enforcement).
// Production credentials come from the deploy/app-secrets path, not here.
export const LOCAL_DB_CREDENTIALS = {
  host: 'database',
  port: 5432,
  name: 'myapp',
  user: 'myapp_user',
  password: 'localdev123',
};

// The platform's embedding identity — the ONE model the pre-staged embed
// helper calls (MGA_EMBEDDING_MODEL is not wired by compose generation, so
// this is what every generated app actually gets at runtime) and its vector
// dimension. Contract prompts, the vectordb scaffold, and the write-time
// canonicalizer must all agree with these or inserts fail with a dimension
// mismatch (observed live 2026-07-20: contract declared VECTOR(3072) per a
// text-embedding-3-large default while runtime embedded at 1536).
export const PLATFORM_EMBEDDING_MODEL = 'text-embedding-3-small';
export const PLATFORM_EMBEDDING_DIMENSION = 1536;
