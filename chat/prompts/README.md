# `chat/prompts/` — MGA assistant prompt sources

Canonical source of truth for every MGA assistant's `instructions` field. Edit a `.md` file here, then upload to MGA via `npm run prompt:upload`.

## Files

| File | Assistant | Notes |
|---|---|---|
| `router.md` | Router (planning agent) | YAML frontmatter format. The `instructions` field is everything AFTER the closing `---`. |
| `coder.md` | Coder | Prose preamble + single `---` separator + content. |
| `summarizer.md` | Summarizer | Prose preamble + single `---` separator + content. |
| `orchestrator.md` | Orchestrator | Prose preamble + single `---` separator + content. |
| `subagent-{database,backend,frontend,vectordb,integration}.md` | Subagent (per scope) | Layered on `subagent-base.md`; uploaded per-scope to MGA. |

The upload script's `stripPreamble` handles both formats — it never sends preamble content to MGA. The legacy `verifier.md` and `subagent-verifier.md` were retired alongside the cross-scope reconciler rollout — verification is now deterministic in `chat/server/reconciler/`, not LLM-dispatched.

## Upload workflow

```bash
# Single assistant
npm run prompt:upload -- --assistant=router

# All four
npm run prompt:upload -- --all

# Dry-run (no PATCH, just preview)
npm run prompt:upload -- --assistant=router --dry-run
```

The script:
1. Strips the preamble from the source file.
2. PATCHes `/api/v2/assistants/{id}` with `{ assistant_patch: { instructions: "..." } }`.
3. Verifies the saved content contains a 120-char fingerprint from the tail of what was sent.
4. Fails loud if the fingerprint is missing (catches MGA silent truncation).

## When PATCH writes silently no-op

Observed 2026-05-02: PATCH returns 200 + `modification_date` bumps but the field doesn't actually update. UI writes via `chat.int.bayer.com/assistant/{id}` still work. If this state recurs, the workaround is to paste the post-preamble body of the source file into the MGA UI's Assistant Prompt field. Report the regression to the MGA team with reproduction steps.

## Adding a new assistant

1. Create the source file in this folder.
2. Create the assistant on MGA (UI), seed it with the source's post-preamble body, copy the returned ID.
3. Add the ID to `.chat/secrets.json` under a key like `<role>AssistantId`.
4. Add an entry to `ASSISTANTS` in `chat/scripts/upload-assistant-prompt.js` so future edits round-trip through the fingerprint check.
