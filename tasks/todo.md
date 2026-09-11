# Vibe platform — template-sync fix + 2.0 rollout safety + reference-data seeding

Status: PLAN — awaiting approval (2026-09-07). Nothing implemented yet.
Worktree: dd-template-repo-integration (feat/master-harness-integration). Fleet = child repos of
bayer-int/dd-template-repository (private, `internal` visibility, master = 1.4.11, tags template-v1.4.11 exist).

---

## Track 1 — BLOCKER: "Check Template Updates" fails on child repos

### Findings (verified on bayer-int/qa-nexus, run 34103772422, 2026-09-07; same failure weekly since 2026-08-17)
- Failing step: `Run update engine`. Engine output (0.2 s after start → auth, not network):
  `Could not fetch the template repo (bayer-int/dd-template-repository)` … `UPDATE_FAILED|Could not fetch template (git)`.
- The child's copy of template-sync.yml is byte-identical to master's. `permissions:` already has
  `pull-requests: write`; repo setting "Actions can create PRs" = true. Direction (c) is already done.
- Template repo visibility is ALREADY `internal`. That does not help: a workflow's GITHUB_TOKEN is
  scoped to the repo the workflow runs in, never to sibling repos, regardless of their visibility.
  Direction (b) is a no-op. The only fix is a cross-repo read token.
- `TEMPLATE_READ_TOKEN` is not reaching qa-nexus (org secret listing → 403 for my account, so I
  cannot tell whether it is missing or just not shared with the repo). Either way: org-admin action.
- Codespaces path works for ≥1.4 repos (users `gh auth login`); CI sync is dead fleet-wide →
  the weekly PR channel has delivered nothing since at least 2026-08-17. Pre-1.4 repos (246) are
  dead on BOTH paths (their scripts use `gh api`, which 403s in Codespaces too) — the token fixes
  CI for ≥1.4 repos only; legacy repos additionally need the workflow copy that uses
  TEMPLATE_READ_TOKEN, which they can only receive through… a working sync. Realistic recovery for
  legacy repos: their Codespaces engine run after the user does `gh auth login` (the 1.2.x
  auto-update path) picks up the new engine from `auto_update:` and self-heals from then on; CI
  heals on the next run after that.

### Constraint (2026-09-08): user is an org MEMBER, not owner → no org secrets, no GitHub App.
User IS admin on dd-template-repository and dd-platform-repository, and changes smart-aws by PR.
Template repo Actions access = `organization` (any org repo may `uses:` its workflows). Every
onboarded project has `vibe-<project>-deploy`, assumable only from platform reusable workflows
(repository_id + job_workflow_ref + sub pins). dd-platform-repository holds `GH_PAT` (user-authored
workflow, reads private org repos) as a fallback token value.

### Fix — Option A (APPROVED 2026-09-08): token in SSM behind the platform OIDC pattern
Worktrees: smart-aws-template-token (feat/template-sync-read-token, off prod-992872368362),
dd-platform-template-sync (feat/template-sync-reusable, off master),
dd-template-repo-sync-caller (feat/template-sync-platform-caller, off master).
- [x] A1 DONE 2026-09-08 (uncommitted, worktree smart-aws-template-token): fmt/validate/tflint/
      checkov clean; README row regenerated with pinned terraform-docs v0.16.0 (idempotent 2nd run);
      detect-secrets Passed; rendered shared policy ≈4.4 KB of the 6,144-byte cap.
      smart-aws: `aws_ssm_parameter.template_read_token` (`/vibe-platform/template-read-token`,
      SecureString, platform KMS key, placeholder value + `ignore_changes = [value]`, real value set
      in the Console); a dedicated `TemplateReadToken` Allow statement in the shared per-project
      managed policy (NOT the `platform_shared_ssm_param_arns` list — that list's docstring forbids
      secrets; the exception is documented inline); `template-sync.yml` added to
      `local.vibe_reusable_workflow_refs`. No new role: a fleet-wide role would need a wildcard on
      the repo name in `sub`, which cloudeng-ConfigOidcRule may rewrite.
- [x] A2 DONE 2026-09-08 (uncommitted, worktree dd-platform-template-sync; YAML parses):
      dd-platform-repository: reusable `.github/workflows/template-sync.yml` (workflow_call;
      inputs project-name, direct_commit, auto_merge; optional secret TEMPLATE_READ_TOKEN takes
      precedence over SSM so Option B still works if it ever lands). Ownership check as in
      stop-project.yml (a repo may only sync itself). Assume vibe-<project>-deploy → SSM read →
      checkout caller → engine → stage/PR. Missing role → clear notice, exit 0.
- [x] A3 DONE 2026-09-08 (uncommitted, worktree dd-template-repo-sync-caller): child
      `template-sync.yml` is a thin caller (`id-token: write`); engine step 1 classifies auth vs
      network, CI vs Codespaces guidance, strips URL userinfo — functionally tested against an
      unreadable repo (auth, CI text) and an unresolvable host (network, retry text); no token leak.
- [ ] A4 token: new fine-grained PAT (resource owner bayer-int, dd-template-repository only,
      Contents: read, 1-year expiry) → Console → SSM. Fallback: GH_PAT value.
- Go-live order: smart-aws apply → platform PR merge (trust pin is on master) → template PR merge
  (→ 1.4.12 auto-bump, children pick up the caller) → canary `gh workflow run` on qa-nexus.
- [x] LANDED 2026-09-09: smart-aws #170 applied (392 roles + shared policy + param), platform #14,
      template #18 (→ 1.4.12, tag template-v1.4.12), qa-nexus #29 (hand-placed caller).
- Canary run 1 → role assumed, SSM token read, engine fetch REFUSED: actions/checkout persists
  GITHUB_TOKEN as `http.https://github.com/.extraheader`, which beats URL credentials. The original
  TEMPLATE_URL design could never have worked in CI. Fixed in platform #15 (reset the header via
  GIT_CONFIG_* for the engine step only); reproduced + both fixes verified locally.
- Canary run 2 → engine synced 6 files, commit OK, push REFUSED: GITHUB_TOKEN may never create or
  change `.github/workflows/*` (needs the `workflows` permission Actions tokens don't have). The
  manifest syncs 3 workflow files → CI can never deliver those. Fix (platform, branch
  fix/template-sync-hold-workflows, helper unit-tested in bash): hold workflow files back, keep
  `.template-version` at the old release so the engine keeps re-checking, `::warning::` + PR-body
  section telling the user to run the engine from a Codespace (user token has the scope). Track 2
  consequence: workflow-file changes are a Codespaces-only delivery; keep them rare.
- [ ] 1b. Engine (`scripts/apply-updates.sh` step 1): capture git fetch stderr, classify auth vs
      network with the same regexes check-updates.sh already uses, and print CI-specific guidance
      when `$GITHUB_ACTIONS` is set ("TEMPLATE_READ_TOKEN missing or lacks read access to
      <template>") instead of the Codespaces `gh auth login` text. Contract line becomes
      `UPDATE_FAILED|Cannot read template repo (auth)` / `(network)`.
- [ ] 1c. Workflow: before running the engine, `if [ -z "${{ secrets.TEMPLATE_READ_TOKEN }}" ]`
      → `::warning::` (falls back to GITHUB_TOKEN, which cannot read a sibling repo); on engine
      failure emit `::error::<UPDATE_FAILED reason>` so the annotation says the cause, not
      "Engine failed".
- [ ] 1d. Validate on qa-nexus: repo secret set → `gh workflow run "Check Template Updates"` →
      green run, "Already up to date" (qa-nexus is on 1.4.11 = master). Then remove the repo
      secret once the org secret exists and re-run.

Side note (not in scope): PRs merged by GITHUB_TOKEN do not fire `push` workflows, so an
auto-merged sync PR never triggers deploy.yml. Harmless today (sync touches platform files only).

### Session-start update check (all AI tools) — DONE 2026-09-09 on feat/master-harness-integration, uncommitted
Ask: every new AI conversation (Claude Code, Cline, Copilot, Cursor, harness; local + Codespaces)
checks for a pending platform sync PR / outdated sync workflow and advises or auto-applies.
- `scripts/check-template-pr.sh` (new, in manifest auto_update): stable line contract
  TEMPLATE_PR / TEMPLATE_CALLER / TEMPLATE_VERSION / TEMPLATE_AUTO_UPDATE; PR check needs only
  repo read (works in Codespaces without gh login); self-guard for the template repo; exit 0 always.
- Canonical rule in the ALWAYS-ON core `.platform-rules/00-global.md` ("Session Start — Platform
  Update Check") → mirrored by the generated Cline core, Copilot instructions, Cursor core, CLAUDE.md
  import; journey.md §1 step 4 + update flow rewritten (merge PR → engine run for held workflow
  files → commit; `.template-auto-update` tracked marker = apply without asking).
- Claude Code extra: `scripts/audit/install-claude-hooks.sh` now also registers a SessionStart
  hook (matcher startup|resume|clear) running the script — stdout lands in context before the
  first reply; runs before the trust dialog. Installer idempotent, preserves foreign hooks (tested).
- Harness: `chat/server/core/template-check.js` (parse/describe), env-context `templateCheck`,
  prompt env-section WARNING lines, preflight check `template-update` (warn/pass).
- Verified: adapters regenerated + `--check` OK; unit 697/697 (4 new); script on qa-nexus →
  `TEMPLATE_PR|30|…|held_workflows=yes`, `TEMPLATE_CALLER|current`; bad token → `unknown|gh_auth`;
  no origin → `unknown|no_origin` + `CALLER|missing`.
- Not done: Cline/Copilot cannot run hooks — they rely on the core rule text (same as today's
  check-updates.sh instruction). Old repos get this only after their one-time engine run.

---

## Track 2 — 2.0 rollout safety (must land BEFORE the integration PR merges)

### STATUS 2026-09-09: IMPLEMENTED on feat/master-harness-integration (uncommitted), offline-validated
- Engine § 3b major gate (structural: `auto_update_major:` section), `--accept-major` /
  `TEMPLATE_ACCEPT_MAJOR=1`, held-state fields in `.template-version` (`held_major`,
  `additive_synced`), deferred major migrations, forced backups on a major crossing,
  git-ignored files preserved in directory sync, `MAJOR_HELD|` + `MIGRATION_NEEDED|` output
  lines (old callers still see UP_TO_DATE/UPDATE_COMPLETE with the unchanged local version).
- Manifest: version 2.0.0, additive vs gated split, chat/ + .chat files gated, stale `chat`
  cleanup removed, escape hatch (scope-migration.md + skills/migration/) + detect-stack.sh +
  audit scripts additive, migration "2.0.0" (gitignore adds), changelog 2.0.0.
- version-bump.yml honors a hand-set version (tags it, no patch bump); auto-update-template.sh
  prints the held/migration notice; caller + platform workflow gained `accept_major` and
  `template_ref` (canary) inputs; platform PR title/body for held majors.
- Rules: 01-common "Existing Project → Continue in ITS Stack" (JS stays JS, keeps its
  Dockerfile — Dockerfile.node is TS-only), journey stack table scoped to fresh projects,
  scope-backend wording, scope-migration.md (protocol + 3 recipes, sunset 2026-12-31),
  00-global session-start rows for MAJOR_HELD / MIGRATION_NEEDED; adapters regenerated.
- Harness: env-context `stack` (detect-stack.sh) → prompt "Detected stack … continue in it";
  template-check parses held/migration lines; 698/698 unit.
- Validated offline (scratch qa-nexus clone vs a snapshot of this branch as the template):
  dry-run lists additive only; held run syncs 23 additive files, version stays 1.4.12 with
  held fields, chat/ absent, escape hatch present; 2nd run UP_TO_DATE+MAJOR_HELD; accept →
  16 gated entries incl. chat/ (481 files), 55 backups, version 2.0.0; 3rd run UP_TO_DATE;
  chat/node_modules survives a refresh. Retired-stack fixture (chroma): marker written, accept
  refused, TEMPLATE_FORCE_MAJOR=1 accepted, marker auto-removed after migration.
- TypeScript migration (user ask 2026-09-09): `.platform-rules/scope-typescript.md` (skill
  "typescript": opt-in JS→TS for Express backend / React frontend, backup branch, allowJs
  staged conversion, verify per layer, no logic changes); detect-stack splits `react-ts` /
  `react-js`; check-template-pr.sh emits `TEMPLATE_TS_MIGRATION|<js layers>` (omitted while a
  major is held or after tracked `.template-ts-migration-declined`); 00-global row = one-sentence
  offer, once, never as a side effect; harness prompt OPTIONAL line. 707/707 unit; verified on the
  qa-nexus clone (node-js + react-js → line present; declined marker silences; held repo omits).
- Decisions applied: chat/ gated auto-update (user OK 2026-09-09); sunset 2026-12-31 (proposed,
  not explicitly confirmed); NO separate 1.4.13 gate release — the gate is structural and
  the escape hatch sits in the 2.0 manifest's additive section, which legacy parsers read;
  fewer releases = fewer human-delivered workflow files. Still to do before merge: CI canary
  on qa-nexus with `template_ref=feat/master-harness-integration` (held PR expected), then
  `accept_major` canary.

### Findings
- Auto-bump trap: version-bump.yml bumps PATCH on every push to master touching manifest paths.
  Merging the integration PR as-is → 1.4.12 → every child auto-applies the breaking files on next
  Codespace start (Codespaces path applies directly, no PR). The gate must be in the same release
  as the breaking files, and the version must be 2.0.0, not 1.4.12.
- The engine self-upgrades: a 1.4.11 child pins to the template-v<latest> tag and re-execs THAT
  engine. So a gate written into the 2.0.0 engine is honored by every child, however old. Good.
- Manifest on the integration branch still has `cleanup: - path: "chat" type: directory`
  ("moved to feat/chat branch"). chat/ (471 tracked files) is now the harness. First sync of any
  2.0 child would `rm -rf chat`. Must be removed, and chat/ must become an auto_update directory
  (gated) or existing children never receive the harness on opt-in.
- `sync_directory` does `rm -rf <dir>` then re-materializes tracked files → would wipe
  chat/node_modules and chat/bench/results on every sync. Fix: never delete git-ignored paths
  (`git check-ignore`); add chat/bench/results/ to .gitignore.
- The audit gate is NOT in the manifest: scripts/audit/*, scripts/pre-push-review.sh are
  untracked-by-manifest → they do not sync to anyone today. Add them (ungated).
- Retired stacks: Dockerfile.vanilla/.mysql/.chroma/.qdrant were dropped from the manifest on the
  integration branch. Existing children keep their copies (sync_file only writes paths present
  in the template) — no breakage from that alone.

### Fleet reality (survey 2026-09-07, tasks/fleet-survey.md — 352 repos, 341 real children)
- 246 repos are pre-1.4.0. Their sync path is NOT the engine: the 1.2.x apply-updates.sh and the
  legacy template-sync.yml parse `auto_update:` themselves and copy files. Both read the template
  via `gh api` with GITHUB_TOKEN → they have been dead since the template went private (Codespaces
  gh-api 403 too). Consequence for the gate: anything placed under `auto_update:` is applied
  UNGATED by every legacy copy the moment it can read the template again. A per-entry attribute
  (`gate: major`) would be ignored by them.
- Verified: all three parsers in the wild (1.2.x engine, legacy workflow awk, current engine awk)
  stop at the next top-level key. A NEW top-level section is invisible to all of them → the
  structural gate below.
- 95 repos ≥ 1.4.0 run the self-upgrading engine (51 on 1.4.11). 171 repos are untouched
  scaffolds (nothing deployable chosen) — for those the "breaking" rules change is actually the
  desired state; a held untouched repo just needs the opt-in.

### 2.1 Major-version gate
- [ ] Manifest: STRUCTURAL gate. Breaking entries move out of `auto_update:` into a new top-level
      section `auto_update_major:` (same entry format, plus `since: "2.0.0"`). Legacy consumers
      never see it; the 2.0 engine syncs it only when the child's major is current or the update
      is accepted. `auto_update:` keeps only additive entries. (Replaces the per-entry `gate:` idea.)
      GATED: .platform-rules/, .claude/skills/, .cursor/rules/, .github/instructions/,
      .github/copilot-instructions.md, .clinerules/, .cursorrules, CLAUDE.md, snippets/, examples/,
      README.md, docs/MIGRATION.md, docs/EXAMPLES.md, chat/ (new), .chat/README.md,
      .chat/secrets.example.json (new).
      ADDITIVE (unchanged behaviour): workflows, dependabot, .dockerignore ×3, nginx.conf,
      nginx.local.conf, Dockerfile.react/.node/.python/.rust, Dockerfile.postgres,
      Dockerfile.pgvector, the three AI ignore files, scripts/* (+ scripts/audit/,
      pre-push-review.sh — new entries), .devcontainer/*, database/seed/.gitkeep,
      context/.gitkeep, docs/CODESPACE_CLAUDE_CODE_SETUP.md, and the migration escape hatch:
      `.platform-rules/scope-migration.md` + `.claude/skills/migration/` listed as their own
      ungated entries (parent dirs stay gated; SKILL.md embeds the full rule body so it is
      self-contained).
- [ ] Engine: if major(LATEST) > major(LOCAL) and not accepted → HOLD:
      - sync only ungated entries; defer migration blocks whose version is ≥ the new major;
      - keep `.template-version` at the local version, add `held_major: "2"` and
        `additive_synced: "<latest>"` (idempotent: next run with nothing new → `UP_TO_DATE`);
      - back-compat output for OLD callers: `MAJOR_HELD|<local>|<latest>` line, then
        `UPDATE_COMPLETE|<local>` (files changed) or `UP_TO_DATE|<local>` (nothing), exit 0 —
        the 1.4.11 workflow/auto-update copies still in the fleet parse this correctly;
      - notice text with the opt-in command.
      Accept: `TEMPLATE_ACCEPT_MAJOR=2 bash scripts/apply-updates.sh` (Codespaces/manual) or the
      workflow_dispatch input `accept_major` (CI → reviewable PR). Refused while
      `.template-migration-needed` exists (override `TEMPLATE_FORCE_MAJOR=1`). On accept: back up
      EVERY gated path being replaced to `.template-backup/<old-version>/` (not only
      user-modified ones — the rules tree is replaced wholesale, rollback must be possible), then
      the normal full sync, version → 2.x.
- [ ] auto-update-template.sh: handle `MAJOR_HELD` (full notice on first hold, one line after),
      show the opt-in command, mention the backup dir.
- [ ] template-sync.yml: inputs `accept_major` (bool) and `template_ref` (string, canary —
      honored on workflow_dispatch only); held-run PR title "Platform security updates (v2.0 held —
      opt-in required)" + body explaining opt-in; Track 1 annotations.
- [ ] sync-from-template.sh: pass through `--accept-major`.
- [ ] version-bump.yml: if the push already changed `version:` in the manifest (hand-set bump),
      skip the computed bump and only tag `template-v<version>`. The integration PR then sets
      `version: "2.0.0"` + changelog "2.0.0" itself.
- [ ] .gitignore: `.template-backup/` (engine adds it at runtime today; ship it), chat/bench/results/.

### 2.2 "Continue in the existing stack" rule
- [ ] `.platform-rules/01-common.md` (core, always loaded): new section — before choosing a stack,
      detect an existing project: backend/main.py → Python/FastAPI; backend/src/index.ts → Node TS;
      backend/server.js or src/index.js → Node JS (stay JS, do not convert); Cargo.toml → Rust;
      frontend/package.json with react → React. Continue in THAT stack with the matching-language
      snippet (`.py` / `.js` / `.ts`); TS default applies to fresh projects only.
- [ ] journey.md "Recommend the stack" table → scoped to fresh projects; scope-backend.md
      "recommended" → "recommended for new projects"; scope-frontend unchanged.
- [ ] Harness: env-context.js already detects; confirm the planner prompt carries the detected
      runtime so it plans Python for a Python repo (check during implementation; add if missing).
- [ ] `node scripts/build-rule-adapters.js` then `--check`.

### 2.3 Group-2 dropped stacks (vanilla-JS, MySQL, Chroma/Qdrant)
- [x] Step 0 sizing (tasks/fleet-survey.md): 56 distinct repos in a retired stack —
      vanilla-JS frontend 50 (36 real projects, 14 index.html-only scaffolds), MySQL in
      production 6, Chroma/Qdrant 7 (overlaps: Smart_CLM_and_Routing hits all three). Plus 188
      repos whose docker-compose still runs the template's default mysql:8.0 locally (29 real
      projects) — local-dev only, but the compose merge strategy must not break them.
      Decision: vanilla (50) needs the tooling below; MySQL + vector (12, 1 overlap) are small
      enough to hand-migrate with the same skill, coordinated with owners. qa-nexus is NOT
      Group-2 (node-js/React/Postgres/pgvector) → the "continue in existing stack" canary.
- [ ] `scripts/detect-stack.sh` (new, ungated): prints `backend=<node-ts|node-js|python|rust|none>
      frontend=<react|vanilla|none> database=<postgres|mysql|none> vectordb=<pgvector|chroma|qdrant|none>`
      from Dockerfile FROM lines, compose images, file markers. Used by the engine at gate time
      and by the migration skill. (Deviation from the brief: classification lives in the engine
      call path, not check-updates.sh, so the hold decision has one owner; check-updates.sh keeps
      its stdout contract untouched.)
- [ ] Engine at gate time: retired stack detected → write `.template-migration-needed`
      (stack + date + sunset), hold (even with accept), one-time notice.
- [ ] `.platform-rules/scope-migration.md` (canonical; triggers "migrate", "template migration",
      ".template-migration-needed") → regenerated `.claude/skills/migration/SKILL.md`. Protocol:
      1. `git checkout -b pre-2.0-backup && git push -u origin pre-2.0-backup` (user runs)
      2. per-stack recipe: vanilla → React+Vite (keep markup/CSS, move script.js logic into
         App.tsx, Dockerfile.react); MySQL → Postgres (types/AUTO_INCREMENT→SERIAL, `?`→`$1`,
         mysql2→pg, Dockerfile.postgres, dump/restore note); Chroma/Qdrant → pgvector
         (Dockerfile.pgvector, `vector(1536)` table + ivfflat index, replace client with
         snippets/llm/knowledge-base-client + rag-tools, re-embed on first start)
      3. rebuild + verify: `docker compose up -d --build`, /health on 8080 and 3000, one endpoint
         probe per changed layer (harness pipeline when present, curl otherwise)
      4. on success: `rm .template-migration-needed`, then `TEMPLATE_ACCEPT_MAJOR=2 bash scripts/apply-updates.sh`
      Ships UNGATED so held repos receive it.
- [ ] Sunset window: proposed 2026-12-31 (≈16 weeks). Until then: retired stacks keep receiving
      additive updates and are supported for deploy. After: no rule/snippet support, platform
      stops testing those Dockerfiles, notice text switches to "unsupported — migrate". Date needs
      user sign-off.

### 2.4 Release sequencing (proposal)
1. Track 1 token (org admin) — independent of code, unblocks the fleet today.
2. PR-A to master (small, patch 1.4.12): 1b/1c, gate engine + workflow inputs + auto-update
   handling, detect-stack.sh, migration skill, .gitignore, version-bump.yml hand-set rule,
   audit-script manifest entries. Fleet receives the gate + escape hatch + better errors on a
   low-risk release BEFORE anything breaking exists. (Self-upgrade would make this unnecessary
   for the gate itself; it is a rehearsal of the sync channel and gets the escape hatch out.)
3. Merge master → integration branch; PR-B (2.0.0): manifest `gate:` keys, chat/ entry, cleanup
   fix, version/changelog 2.0.0, continue-in-stack rule, Track 3.

### 2.5 Validation
- [ ] Engine offline: scratch clone of qa-nexus (1.4.11, node-js + React + Postgres + pgvector →
      not Group-2) with `TEMPLATE_URL=file://<integration worktree> TEMPLATE_BRANCH=… TEMPLATE_ALLOW_UNPINNED=1`:
      `--dry-run` lists only additive paths; real run changes only those, `.template-version`
      still 1.4.11 with held_major; second run → UP_TO_DATE; `TEMPLATE_ACCEPT_MAJOR=2` → full sync,
      backups present, version 2.0.0. Same on a synthetic Group-2 fixture (Dockerfile.chroma) →
      marker written, accept refused.
- [ ] CI canary: qa-nexus `gh workflow run … -f template_ref=<branch>` → PR contains additive
      files only; then `-f accept_major=true` → full PR.
- [ ] Old-caller compatibility: run the 1.4.11 engine copy against the new ref (it self-upgrades)
      and confirm the 1.4.11 workflow grep logic accepts the output.

---

## Track 3 — reference-data seeding / silent failures (harness)

STATUS 2026-09-08: IMPLEMENTED + bench-proven by a parallel session on branch
`feat/reference-data-seeding` (worktree dd-template-repo-seeding); see the Review section at the
bottom. Awaiting the user's commit. Not re-done here.

Root cause verified this morning (see previous version of this file, kept below). Bench
2026-09-07T08-18-37: app reported "all 5 API endpoints verified", 3/4 actions failed, all from
`PUT /lines/:id/status` → 404 "Line not found" on an empty `lines` table.

### Root cause (verified)
1. Planner DID ask for seeding (database task ends "Seed 3-5 sample lines").
2. pre-stage-scaffolds.js § 4 retires the database agent on fresh builds; nothing deterministic
   emits rows → intent dropped.
3. `database/seed/` is executed by nothing (compose mounts only init/, Dockerfile.postgres COPYs
   only init/) and is gitignored → can never reach ECS. Rule text claiming compose runs seed/ is false.
4. Probe ranks parameterized POSTs first → `:id` is always the guess `1`; 404 = pass.
5. Bench assumes `POST /line*`; falls back to id=1 without reading `GET /lines`.

### Fix (bounded, ~250 LOC + tests)
- [ ] A. `chat/server/agent/coordinator/reference-data-generator.js`: tables that are the
      collection of a parameterized endpoint AND have no plausible creator (no matching
      non-parameterized POST/PUT, no file field, no field overlap), not identity tables, no
      VECTOR column → 3 placeholder rows, guarded `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1
      FROM t)`, written by pre-stage § 4 as `database/init/02_reference_data.sql` (runs on first
      boot locally AND on ECS), listed in the database report so the backend agent knows ids exist.
      Column fill rules and FK handling as previously specified; any un-fillable NOT NULL column →
      skip the table entirely.
- [ ] B. Probe: rank parameterized POSTs with PUT/PATCH (also fixes the idByPrefix clobber on
      `POST /projects/:id/tasks`); capture first id from a passing collection GET; new failure
      class `reference-data:` only for mutations on reference prefixes with a guessed id (GET/
      DELETE 404s stay pass); remedy line in formatProbeFailures; fix loop re-applies the seed file
      via psql and re-probes `GET <prefix>` for id capture.
- [ ] C. Bench realtime-status-board: read first id from `GET /lines` before falling back to 1.
- [ ] D. Rules (needs OK — security-flavoured text): 01-common "seed the reference entities" →
      `database/init/02_reference_data.sql` (≤3 placeholder rows/table, guarded INSERT, never
      PII); 00-global rule 6 + scope-database "schema only" get the existing sensitive-files.md
      carve-out wording; delete the false "compose runs database/seed/" sentence. Root
      CLAUDE.md/.cursorrules rule 6 left for the master PR description.
- Out of scope (recorded): planner-emitted `reference: true` flag; socket-broadcast verify in
  the probe (bench covers it); harness applying `database/migrations` vs rules' `backend/migrations`.

### Validation
- [ ] `cd chat && npm run test:unit` (new tests for A + B)
- [ ] stop leftover containers on 8080/3000/5432 (dd-sql-validator on 5432)
- [ ] bench `realtime-status-board` → 4/4 actions, probe 5p/0 broken, 02_reference_data.sql has 3 lines
- [ ] regression bench `crud-logbook` → generator seeds nothing, probe still green

---

## Open decisions for the user
1. Track 1 token type: GitHub App (durable) vs service-account PAT (fast). Who is the org admin?
2. chat/ becomes a gated auto_update directory (harness delivered/updated via sync). OK?
3. Sunset date for retired stacks (proposed 2026-12-31).
4. Release sequencing: PR-A (1.4.12 gate + escape hatch) before PR-B (2.0.0). OK?
5. Track 3 D rule-text changes (placeholder rows allowed in init/02_reference_data.sql).
6. Stack classification in detect-stack.sh called by the engine (not inside check-updates.sh).

## Review (2026-09-08)

Evidence:
- Unit: 678/678 (`npm run test:unit`), incl. 8 generator tests + 5 probe tests. Found and pinned a
  latent probe bug: PARAM_RE is /g and `.test()` resumed from lastIndex, so consecutive parameterized
  paths made the second read as parameter-free (POST /lines/:id/status was sorted as a collection POST).
- Bench run 1 (planner chose POST /lines): create-route variant → generator seeded nothing, probe
  5p/0broken, 4/4 actions PASS. Acts as the no-false-positive regression.
- Bench run 2 (clarify pinned "fixed set of lines"; contract: GET /lines, GET /lines/:id,
  PUT /lines/:id/status, GET /status-changes — no create route): `[pre-stage] reference data staged
  for lines`, database/init/02_reference_data.sql present, live DB `lines` = Line 1..3, REST mutation
  HTTP 200 on id 1, socket event pushed, history non-empty. 4/4 PASS, probe 5p/0broken.
- Generated SQL executed twice in a scratch schema on the live Postgres: DO-block valid, second run
  a no-op (3 rows).
- Offline preStageScaffolds on the 2026-09-07 failing contract: emits 02_reference_data.sql + report line.

Not exercised live: the `reference-data:` probe failure → fix-dispatch → re-apply path (no build
produced an empty reference table any more). Covered by unit tests only.

---

# Migrations that actually run in production — IMPLEMENTED + bench-proven 2026-09-09

## Verified findings

1. **Runtime image has no migrations.** `backend/Dockerfile.node` runtime stage copies only
   `dist/`, `node_modules/`, `package.json`. `backend/migrations/*.sql` never reach the container,
   locally or on ECS. Both runner snippets resolve `/app/migrations`, find nothing, and return
   silently (TS) or warn (JS).
2. **TS runner snippet can't run in the generated backend.** Backends are ESM (`"type": "module"`,
   NodeNext); `snippets/database/migration-runner.ts` uses `__dirname` (undefined in ESM) and has
   no ledger — every file re-runs on every boot. The JS snippet is CommonJS `require` — not
   importable from the ESM TS backend. Rules + preflight point at the JS one.
3. **Database agent prompt contradicts the rules.** `chat/prompts/subagent-database.md` § "Post-launch
   schema changes" says: write `database/migrations/002_*.sql`, apply manually with psql. Evidence:
   iterate-evolution bench (2026-09-04) — agents wrote `database/migrations/002..006_*.sql` for all
   5 iterates (add category, add projects table, fulltext, rename, drop).
4. **Harness papers over it locally.** `applyPendingMigrations` (docker-orchestration.js) psql-applies
   `database/migrations/*.sql` into the local DB with a `.harness/applied-migrations.json` ledger, so
   the bench passes. Production never runs them → every schema-changing iterate ships a backend
   that 500s on missing tables/columns. Silent: the bench is local-only.
5. **Preflight would catch the misplaced files but nobody runs it** (`deploy.yml` doesn't; users run it
   by hand), and its runner check greps only `*.js`/`*.py` — a TS backend with a wired runner FAILS.
6. Nothing in the harness or prompts tells the backend agent about iterate schema changes at all.

## Fix (one mechanism, local == prod)

A. **Runner staged deterministically.** Fix `snippets/database/migration-runner.ts` (ESM-safe dir via
   `import.meta.url` → `../../migrations`; `_migrations` ledger; per-file transaction; loud log when
   the dir is missing or empty). Pre-stage copies it to `backend/src/lib/migrate.ts` on every build
   with a database scope (fresh AND iterate, only if absent), listed in the pre-staged files manifest.
B. **Dockerfile.node ships migrations.** Builder: `RUN mkdir -p migrations` after `COPY . .` so the
   dir always exists; runtime: `COPY --from=builder --chown=appuser:appgroup /app/migrations ./migrations`.
C. **Harness verifies instead of applying.** Replace `applyPendingMigrations` with
   `verifyMigrationsApplied`: after compose up, if `backend/migrations/*.sql` exist, read `_migrations`
   from the live DB (execFileSync, no shell). Missing ledger table → verify step `migrations` WARN
   "runner never ran — call `await runMigrations(pool)` before app.listen"; files not in the ledger →
   WARN naming them. Delete the `database/migrations` psql path and the `.harness` ledger. The
   endpoint probe's 5xx + backend log tail (runner output) already drive the fix dispatch.
D. **Prompts, rules, preflight aligned.**
   - `subagent-database.md`: rewrite § Post-launch → `backend/migrations/NNN_*.sql`, never
     `database/migrations/`, runner is staged, report the file for the backend sibling.
   - `subagent-backend.md`: new short § "Schema changes on iterate": file location, idempotent SQL,
     `await runMigrations(pool)` before `app.listen`, `docker compose exec db psql -c '\d <table>'` proof.
   - `express-server-template.ts`: add the commented startup line showing where the runner call goes.
   - `scope-database.md` / `01-common.md` / `verify-checklist.md`: runner is `backend/src/lib/migrate.ts`
     (staged), not `snippets/config/db-migrations.js`.
   - `scripts/preflight-check.sh`: runner grep includes `*.ts`; fix hint names the staged runner.
E. Out of scope (follow-up): deterministic migration emission from `change_tables`/`add_tables` diffs
   (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) — would remove agent discretion for the
   two most common iterate shapes, same pattern as schema-generator on fresh. Python backend
   (`Dockerfile.python` copies everything, so B doesn't apply; no TS runner needed).

## Validation
- [x] unit: runner-verify pure helper (pending = files − ledger; missing-ledger case); pre-stage stages
      `backend/src/lib/migrate.ts`; Dockerfile.node contains the migrations COPY (existing dockerfile tests?)
- [x] `tsc` type-check of the fixed runner snippet against the generated backend's tsconfig (NodeNext ESM)
- [x] bench `iterate-evolution` (ladder always: fresh + 5 iterates, ~25 min): after `add-entity`,
      `docker compose exec backend ls /app/migrations` lists the file, `_migrations` has it in the live
      DB, no `database/migrations/` created, regression actions pass; grep server log for
      `[migrations]` verify-step lines.

## Review (2026-09-09)

Bench run 1 (first attempt) FAILED at add-field and exposed two gaps in the plan:
- iterate scopes run in PARALLEL; the database agent (told by the new prompt to write the migration)
  was BLOCKED by scope write-fencing (`checkPermissions`: database may only write under database/);
  the backend agent wrote a correct migration on its own but the reconciler's sql-prepare-gate only
  loaded database/init + vectordb/init as schema → "column category does not exist" hard mismatch on
  every attempt → build skipped → 25-min timeout.
- SMOKE_PORT_OFFSET was applied AGAIN on the iterate (9080 → 10080).
Fixes added: gate loads backend/migrations/*.sql (sorted, after init) as relational schema; backend
scope is the single migration owner (database prompt: report the DDL, write nothing; backend prompt:
ONE file per iterate); backend/src/lib/migrate.ts added to PLATFORM_LOCKED_FILES; port offset moved
to session/port-offset.js with an idempotency marker (.harness/port-offset.json).

Bench run 2: PASS, 25/25 actions, fresh 295s + 5 iterates (~25 min), $0.50.
- backend/migrations: 001_add_notes_category, 002_add_projects, 003_add_notes_search_index,
  004_rename_content_to_body (guarded DO block), 005_drop_notes_category. No database/migrations/.
- Each file present in /app/migrations INSIDE the runtime container; `_migrations` ledger = all 5;
  live notes columns after the ladder: id title body created_at project_id.
- Harness verify step after every iterate: "[migrations] done: N applied by the backend runner".
  0 HARD MISMATCH, 0 BLOCKED writes, offset applied once.
- Unit 691/691; adapters regenerated (`--check` OK) — also absorbs adapter drift left by the
  reference-data commit (242b9b1), which edited .platform-rules without regenerating.

Follow-ups noticed (not done): execute_command permission check treats `2>/dev/null` as a write path
(blocks agents' psql `\d` proof commands); deterministic migration emission from add/change_tables
diffs; deploy.yml does not run preflight-check.sh.

## Full bench sweep 2026-09-09 (after migrations change) — 10/10 scenarios green

Run beside the user's qa-nexus app via SMOKE_PORT_OFFSET=100 + BENCH_APP_URL=http://localhost:9080.

| scenario | result | notes |
|---|---|---|
| realtime-status-board | PASS (2 runs, 09-08) | seeded reference path + create-route path |
| iterate-evolution | PASS 25/25 | 5 migrations in container + ledger |
| crud-logbook | PASS 8p/0broken | |
| deviation-tracker | FAIL → PASS after bench fix | app exports per deviation (`/deviations/:id/audit-logs/export`); scenario sent a literal `:id` → 400. Fix: fill id, accept scoped exports |
| ai-root-cause | PASS 5p | AI class |
| sop-assistant | PASS 9p | vectordb split |
| vague-prompt | PASS | clarify behavior |
| ops-dashboard | PASS 7p | |
| public-board | PASS 2p | |
| webhook-integration | FAIL → PASS after fix | security-review AUTO-FIX (ec8352f) flagged the ADMIN-configured webhook URL as SSRF and enforced https-only + private-range blocking → intranet forwarder unusable. Fix: prompt ground rule (intranet outbound calls; admin-configured URL ≤ Medium; never https-only / RFC1918 blocking; proportionate = scheme + loopback/link-local/metadata) + scenario clarify states http intranet receiver. Re-run: 0 findings, 4/4 actions |

Unit 693/693 (added: locked migrate.ts + backend owns / database fenced permission test; security prompt rule test).

### Canary results + pending_workflows (2026-09-11)
- Held run (template_ref canary): 24 additive paths, 16 gated held, MAJOR_HELD emitted, deploy.yml
  held (2.0 branch improved deploy.yml: no-app-yet gate + advisory preflight → human-delivered).
- Opt-in run: accept, migration 2.0.0, 490 harness files, 55 backups, 647 paths → qa-nexus PR #34.
- Design fix: the helper reverted .template-version on a held workflow file even after a major
  accept → repo would look "held" forever. Now: version advances; held files recorded as
  `pending_workflows:` in .template-version; engine re-applies just those while set and clears
  the field once they match; check-template-pr emits TEMPLATE_WORKFLOWS_PENDING (rule row,
  harness WARNING). Guarded scratch test: accept → CI hold → human run clears → quiet. 708/708.
- Found: `--accept-major` is dropped by a pre-2.0 engine copy (only $1 read before self-upgrade);
  env form `TEMPLATE_ACCEPT_MAJOR=1 bash scripts/apply-updates.sh` works everywhere → all
  user-facing text uses the env form (flag kept as alias).
- Platform: existing-PR path now retitles + adds the held-major notice once.
