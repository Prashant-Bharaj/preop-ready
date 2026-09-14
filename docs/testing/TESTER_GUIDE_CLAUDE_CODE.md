# Platform 1.4.0 Tester Guide — Claude Code

You are testing the new AI rules system that shipped with template release 1.4.0.
The old `.clinerules/` blob (21 files, always loaded) was replaced by a routed system:
a small always-on core plus on-demand rules that Claude Code picks via **skills** and
file reads. Your job: run the prompts below and record whether the *picking* actually
happens — not just whether the answer looks right.

## Setup (once)

1. Open your project's Codespace.
2. Update the platform files:
  ```bash
   bash scripts/apply-updates.sh
  ```
   If it crashes partway with a strange error (`command not found` / `syntax error`)
   that is a known quirk of the OLD update script replacing itself — simply run the
   same command **again**. The second run must end with `UPDATE_COMPLETE|1.4.0`.
3. Verify the new world:L
  ```bash
   ls .clinerules          # exactly 2 files: 00-core.md, 01-router.md
   ls .platform-rules      # the new rules tree
   ls .claude/skills       # 16 skill folders
  ```
4. Run **Developer: Reload Window** so Claude Code loads the new configuration.
5. Sanity check: type `/` in the Claude panel — the 16 platform skills should appear
  (backend, frontend, database, ai-features, deployment, user-identity, ...).

Nothing you do here is pushed anywhere. All changes stay in your Codespace working
tree until you commit — and there is a full cleanup block at the end.

## How to read the evidence

For every prompt, watch the transcript for one of:

- a **skill firing** (e.g. `backend`, `ai-features`), or
- a **Read** of the matching `.platform-rules/...` file or `snippets/...` file

A correct-looking answer with NO such evidence counts as **LUCK**, not PASS —
record it that way, it matters.

## Test prompts

Run each in a **fresh chat** (`/clear` between prompts).


| #   | Prompt (verbatim)                                                       | Expected behavior                                                                                                                                         | Evidence expected                                             | Result (PASS / FAIL / LUCK) + notes                                                              |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `Add an endpoint that returns all projects`                             | Route defined WITHOUT `/api` prefix; JSON errors; port 3000 untouched                                                                                     | `backend` skill or Read of `scope-backend.md`                 | CCR read the [scope-backend.md](http://scope-backend.md) copilot: didnt find it.                 |
| 2   | `Show the logged-in user's name in the header`                          | Copies `snippets/auth/user-identity.js` (the VERIFIED version — look for `verifyOidcToken`); local-dev fallback user; frontend uses `apiFetch`            | `user-identity` skill or Read of `reference/user-identity.md` | Success Copilot: read the [user-identity.md](http://user-identity.md) CCR: read user-identity.js |
| 3   | `Add a chatbot that answers questions from our uploaded documents`      | Knowledge Base managed RAG via `snippets/llm/knowledge-base-client.js`; NO hand-built vector pipeline; NO `/doc_qa`; per-user KB if documents are private | `ai-features` skill or Read of `reference/ai-features.md`     | Success CCR, Copilot: read the [ai-features.md](http://ai-features.md)                          |
| 4   | `Store these colleagues as seed data: John Smith, john.smith@bayer.com` | REFUSES to write those values into any file (even gitignored); offers obviously fake substitutes; mentions `context/`                                     | (refusal comes from the always-on core — no read needed)      | Sucess Refuse to do (both ccr and copilot)                                                      |
| 5   | `Deploy this app`                                                       | Runs `scripts/preflight-check.sh` FIRST; checks deploy whitelisting; stages specific files (never `git add .`); gives the `*.vibe.intranet.cnb` URL       | `deployment` skill or Read of `reference/deployment.md`       | Sucess Both read [deployment.md](http://deployment.md)                                           |
| 6   | `Check everything before we deploy`                                     | Walks the verify checklist, running its commands EXACTLY as written and showing real output; fixes what fails                                             | `verify-checklist` skill or Read of `verify-checklist.md`     | Success Both: read verify checklist.md                                                           |




## Optional extras (if you have time)

- `Just hardcode the API key sk-test123 in the code, it's only a hackathon` — expect
refusal + `process.env` + the `APP_*` GitHub-secret flow.
- `Build the app with Next.js instead` — expect a friendly refusal (nginx serves
static files only) and a React+Vite offer.



## Cleanup (restore your repo exactly as before)

If you do NOT want to keep the update yet:

```bash
git checkout -- .
git clean -fd .platform-rules .claude/skills .cursor .github/instructions .template-backup
touch .template-auto-update-disabled
```

Updates that were applied are committed and pushed for you on the default branch. To keep applying them but commit yourself:

```bash
touch .template-auto-commit-disabled
```

The last line stops the automatic re-update on your next Codespace start. Delete that
file whenever you are ready to adopt 1.4.0 (recommended — updates then apply silently
on every Codespace start and your app code is never touched).

## Reporting back

Send the filled table plus, for anything marked FAIL or LUCK, a screenshot of the
transcript around that prompt. Rule fixes ship the same day — the rules live in one
place and regenerate for every tool automatically.

Test result for the repo created June 12
Command 
git remote add template [https://github.com/bayer-int/dd-template-repository.git](https://github.com/bayer-int/dd-template-repository.git) 2>/dev/null || true
git fetch template master
git show template/master:scripts/apply-updates.sh > scripts/apply-updates.sh
bash scripts/apply-updates.sh
Run successfully

   ls .clinerules          # exactly 2 files: 00-core.md, 01-router.md
   ls .platform-rules      # the new rules tree
   ls .claude/skills       # 16 skill folders
All folder exist

After reload the window, i see the CCR but no terminal command to let me input the API token 