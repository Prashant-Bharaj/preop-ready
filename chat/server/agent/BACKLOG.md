# Custom Agent — Improvement Backlog

> **STALE — historical record only.** This file predates Phase 4. Several items here were resolved long ago (notably: the verification port marked DEFERRED in the first section was actually shipped in commit `9b15dfa`; primary-snippet improvements landed; single-scope improvements were ported to multi-scope). Some entries are still useful (specific code-level paper cuts in execute_command idle-kill, /api/ scrub edge cases). Skim with skepticism — anything claimed "DEFERRED" predates today's architecture; cross-check with git log before acting on it.

This file is kept for historical record and the few low-level paper cuts that haven't migrated.

## High-value

### Port the post-phase verification scope to the custom agent (DEFERRED)

**STATUS**: DEFERRED 2026-04-23 after repeated loop failures.
Verification now stays on Cline unconditionally (see session.js
comment at the verification kickoff). The custom-agent `scope ===
'verification'` branches in [agent.js](./agent.js) remain in place
but are unreachable on this path — preserved as reference if the
port is retried.

Original motivation still valid: Cline's verification pass burns
~387K tokens per run (observed in multi-scope Test 4), the single
largest remaining cost now that scoped phases are on the custom agent.

**What was tried** (in order):
1. Basic port — moved kickoff to `runCustomAgent`, added workspace
   snapshot + verification-specific DoD + narrowed CHECK 1 wording
   to services-in-compose.
2. Task-spec extractor fix — renamed verification header to match
   the `=== YOUR TASK (SCOPE scope) ===` regex so the per-turn
   reminder wasn't the DoD tail.
3. Idle-kill regex fix in tools.js — `2>&1` was falsely triggering
   the 5s idle-kill on `docker-compose build`. Fixed.
4. Scope-aware gather-nudge threshold (2 for scoped, 4 for
   verification) — the first attempt at curbing verify-theater.
5. Path-listed surgical nudge — echoed `readPaths` back with
   "don't re-read these."
6. Hard dispatcher lock — rejected gather tools at call time after
   the nudge fired. Produced "BLOCKED gather tool" synthetic errors.
7. Lock release on productive action — so post-build diagnostic
   reads weren't permanently blocked.
8. Build-passed stall — tracked successful `docker-compose build`
   and rejected everything except `attempt_completion` after it.

**What kept failing**:
- The Coder assistant largely ignored pure-text "do not" nudges
  regardless of wording (soft, surgical, blanket all failed).
- Dispatcher-level blocks worked mechanically but the model kept
  finding new loops: after a green build it would wander back into
  "let me verify CHECK 1-3 one more time," then burn iterations on
  blocked-tool errors until MAX_ITERATIONS.
- One observed run produced a hallucinated `<human><tool_result>`
  conversation transcript as the assistant's response — the parser
  didn't recognize those tags, zero tool calls registered, nudge
  fired, model doubled down. Pathological.
- Net result across four+ test runs: verification either timed out,
  max-itered, or finalized without running the build.

**Conclusion**: the "read contracts → build → finalize" flow has
enough degrees of freedom that the Coder assistant drifts into
verify-theater loops without far more scaffolding (likely a tighter
system prompt with explicit state-machine framing, or a much smaller
tool surface for this scope). Cline's token cost is high but it
completes reliably. Not worth further spike time until there's a
clear thesis on why it would work next time.

**Improvements that shipped anyway** (not specific to the port,
help Cline-path verification too):
- `buildVerificationPrompt` workspace snapshot section
- Narrowed CHECK 1 wording (services-in-compose, not generic list)
- Verification-specific DoD block with anti-loop rule
- `tools.js` idle-kill regex fix (`/\s&(?!&)/`) — fixes any command
  with `2>&1` or similar redirects

### 1. Move planning decisions upstream to the router (PARTIAL — primarySnippet done in v4.4)

The router now emits `primarySnippet` and uses `scope: "docs"` directly.
Slice 3 cleanup (once the new router is reliably flowing):
- Remove the scope-prefix fallback heuristic in `prompt-builder/core.js`
- Remove `reclassifyDocsOnly` regex in `router.js`
- Remove `/api/` scrub in `router.js` (router now emits clean paths)

Still nice-to-have upstream:
- `doneCriteria` object per task (explicit closure hints instead of
  hardcoded DoD boilerplate in prompt-builder/sections/definition-of-done.js)
- `verificationMode: "none" | "syntax" | "runtime" | "docker"` to let
  the router declare how much verification is appropriate per task.

Original schema sketch retained for reference:

```json
{
  "scope": "frontend",
  "task": "...",
  "primarySnippet": "frontend/AppScaffold.jsx",
  "doneCriteria": "files written + syntactically valid",
  "verificationMode": "none"
}
```

Then `prompt-builder/core.js` just renders what's decided. Eliminates:
- Scope-prefix-match heuristic for primary snippet (see #2)
- Hardcoded Definition of Done adaptation per scope
- `/api/` prefix scrub (router can just emit the right path)

**Cost**: update router assistant's system prompt on MGA + parser in
[router.js:196](./planner/router.js#L196). ~1-2 hrs + MGA upload.

**Why backlog**: works around the problem cleanly today; deserves the
cleanup once multi-scope is working and the API is stable.

### 2. Smarter primary-snippet selection

Current: first snippet whose path starts with the scope name
([prompt-builder/core.js:primarySnippetPaths](./prompt-builder/core.js)).
Breaks on frontend scope — `frontend/dockerfile-react.conf` beats
`frontend/AppScaffold.jsx` because the router happens to list the
Dockerfile first.

**Fix**: prefer non-config/non-Dockerfile entries. Either regex-exclude
`/dockerfile|\.conf$|\.ya?ml$/i` in the match, or let the router tag
the primary explicitly (ties into #1).

**Observed impact**: Test 4 still passed in 6 turns because the model
fetched the real scaffold via MCP at turn 1. Inlining just wasted ~1.2K
tokens on a Dockerfile template we didn't need.

### 3. Port single-scope improvements to `buildScopedPrompt` (multi-scope)

Multi-scope path uses a separate prompt-assembly function that skipped
every improvement we made in `buildPromptFromSpec`:

- Inline scope rule + primary snippet
- Workspace snapshot
- Definition of Done (the closure trigger — scope restriction already has "don't test the app")
- MCP hints tone (optional/on-demand instead of MANDATORY)

Plus wire custom agent into parallel phases
([session.js:1001](../session.js#L1001) currently always calls Cline).

**Cost**: ~2-3 hrs including per-scope conversation-ID plumbing and Test 4-style validation per scope.

**STATUS**: DONE (commit 6c5b7a3).

### 4. `2>&1` false-positive in execute_command idle-kill regex

[`tools/exec-tools.js`](./tools/exec-tools.js) detects backgrounded commands via
`/[^&]&(?!&)/` to decide whether to run the 5s idle-kill timer. The regex
matches the `&` in `2>&1` (shell redirect) as if it were a background
operator, so `cd X && npm install 2>&1 | tail -5` gets idle-killed at 5s
when piped through `tail` — `tail` buffers stdout until the upstream
finishes, so the pipe looks idle even though work is happening.

**Observed**: Test 4 frontend scope turn 3 — `npm install 2>&1 | tail -5`
killed at exactly 5s with `(exit code: killed)`. Model recovered via
read-back + re-run but wasted a turn.

**Fix**: tighten the regex to `\s&\s*(?:$|;|&|\|)` — only match `&` that's
at end of command, or before `;`, `&&`, `||`. Requires surrounding
whitespace so `2>&1` (no space before `&`) doesn't match.

## Medium-value

### 4. Remove `node -e` runtime verification from the DoD

Current DoD says *"smoke test showing process starts cleanly is sufficient"*.
But per design, verification is a separate post-phase step that runs
`docker-compose build`. Individual scopes shouldn't spin up servers —
risks port 3000 conflicts and doesn't add signal.

**Fix**: change DoD to say *"files written + syntactically valid = done,
do NOT run the app. Docker-compose build happens in the verification
phase."*

**Observed impact**: today the model runs `node -e "require(...)"`
sometimes; it's a reasonable lightweight check and doesn't break things.
But it does add turns we could avoid.

### 5. Stronger "don't re-fetch inlined content" signal

Model still calls `get_snippet()` on the MCP server for content we've
inlined in `=== PRIMARY SNIPPETS ===`. The filter-from-hints worked
structurally (not in MCP hints list) but the model fetches anyway from
its own memory of what Express setup requires.

**Fix**: system-prompt anti-pattern: *"Never call get_snippet for a path
that appears in `=== PRIMARY SNIPPETS (already loaded) ===`. The content
is already in context."*

**Cost**: system-prompt-source.md edit + MGA re-upload.

### 6. Documentation & config consistency — server.js → index.js

Several non-model-facing files still mention `backend/server.js`. Not
affecting the agent today (we fixed the model-facing ones), but worth a
sweep:

- `README.md:80` — hand-written docs
- `chat/server/agent/TEST_PROMPTS.md:40,54` — expected file writes
- `.template-manifest.yml:214`
- `scripts/preflight-check.sh:184,198,232` — currently accepts both, could be tightened

## Low-value / watch-list

### 7. `/api/` scrub edge case

[`router.js:normalizeTaskText`](./planner/router.js) strips
`/api/<letter>` in backend-scope task prose. Current regex
`/\/api\/(?=[A-Za-z])/g` is conservative (lookahead requires letter), but
if a backend task ever legitimately describes cross-scope routing
("frontend calls /api/X") the scrub would mangle it. No regression
observed yet.

### 8. Model's verify-theater habit persists even with DoD

Despite the Definition of Done block, the model still does 1-2
read-back/verify turns after writes succeed (see Test 1 turn 5,
Test 4 turn 4). The finalize-nudge catches it, so no functional issue,
but it's pure token waste. Candidate for a stronger anti-pattern in
system prompt: *"After write_to_file / replace_in_file returns success,
do not read the same file back in the next turn unless a tool call in
between explicitly modified it."*
