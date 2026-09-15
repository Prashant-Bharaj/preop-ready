# Deep audit — in-session orchestration playbook (audit → fix → re-audit)

This is the procedure the agent runs **in-session** (via the Agent/Task tool) to
get the changed code security-clean before it is pushed, and to record an
attestation the pre-push gate can trust. It is invoked by the `/audit` command
or the `audit` skill, and triggered automatically by the pre-push gate
(`scripts/pre-push-review.sh`, opt-in: `.audit-auto` marker or `AUDIT_AUTO=1`) when a
push carries code without a fresh attestation. When the gate holds a push, run this playbook, commit the
fixes, then repeat the same `git push`.

Do NOT spawn `claude -p` for this — it refuses to run nested in a live session.
Use the Agent tool (subagents) for the fan-out, exactly as below.

## 1. Determine scope (only what changed)

```
BASE=${AUDIT_BASE:-origin/master}
. scripts/audit/lib.sh
{ git diff --name-only "$BASE"...HEAD ; git diff --name-only ; } | sort -u | audit_reviewable
```
That is the CHANGED SET: committed + working changes, minus `docs/**`, markdown and —
in a project — every platform-owned file (harness under `chat/`, `scripts/`, rules,
snippets, devcontainer, workflows; anything `.template-manifest.yml` syncs). A platform
update commit is NOT the project's code and is never re-audited here; it was audited in
the template repository. In the template repository itself nothing is excluded.

Review by READING. Never run exploit probes, test markers or other experiments inside the
workspace to "verify" a finding — verification is a second reading by a separate subagent.

- **Empty CHANGED SET** → nothing to review. Record PASS (`audit_write_state PASS 0 0 0 "no code changes vs $BASE"`) and stop.
- **Large CHANGED SET** (> ~40 files, e.g. a big integration branch) → a single
  in-session pass can't do it justice. Record a skip (`audit_write_state SKIPPED 0 0 0 "diff too large (<n> files) — audit by area"`) and tell the user to scope it or audit by area. (The gate treats a non-PASS/FAIL attestation as stale → fail-open.)

## 2. Fan out review subagents (Agent tool, in parallel)

Split the CHANGED SET by area and dimension and launch one review subagent per
slice. Each subagent MUST read the rubric at `scripts/audit/reviewer-prompt.md`
and follow it exactly (evidence per finding, verify-before-reporting, no fixes),
scoped to its slice. Typical slices:
- server/backend security surface (injection, path traversal, auth, secrets, SSRF)
- frontend / rendered-output surface (XSS, unsafe HTML, output handling)
- shipped `snippets/**` + infra (`Dockerfile.*`, `nginx*.conf`) held to a prod bar
- performance + code-style pass over the changed files

Give each subagent the exact file list for its slice and the calibration from the
rubric (harness = local dev tool; `snippets/**` = production bar).

## 3. Verify surviving Critical/High/Medium (Agent tool)

For each Critical, High or Medium a review subagent reports, launch a **separate**
verify subagent that adversarially tries to REFUTE it against the real file (this
is how we catch both false positives and superficial fixes). Only findings that
survive refutation count. (This step is why the audit is multi-agent, not a
single pass — the independent cross-check matters.)

## 4. Fix, then go back to step 2

Fix every surviving Critical/High/Medium yourself (or through one fix subagent
per area), following `.platform-rules/02-security.md`. Do not add features or
change behaviour beyond closing the finding; keep each fix minimal. Then run
**steps 1–3 again on the same scope**. Repeat until a round ends with only Low
findings. There is no round limit, but STOP when a round returns the same
surviving set as the previous round (nothing you changed convinced the verify
pass): that is a stall, not progress — record FAIL in step 5 with what is left.

Low findings are never fixed by this loop; they are listed for the user.

## 5. Record the attestation

```
. scripts/audit/lib.sh
audit_write_state PASS 0 0 0 "clean after <n> round(s), <k> fixed"   # only Low left
# or, on a stall
audit_write_state FAIL <critical> <high> <medium> "<n> unresolved after <r> round(s)"
```
Write the full report (rounds, what was fixed, remaining findings with
What/Why/Fix, Low notes, strengths) to the path from `audit_report_file`.

`audit_write_state` stamps the attestation with the CURRENT tree hash, so the
pre-push gate allows the push iff the tree is unchanged since this PASS — commit
the fixes BEFORE recording, or the attestation is stale immediately.

## 6. Surface to the user

Print a short summary: rounds, what was fixed, the verdict, the Low notes and
the report path. If the loop stalled, say exactly which findings remain and why
the fix did not satisfy the verifier.
