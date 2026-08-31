# Deep audit — in-session orchestration playbook

This is the procedure the agent runs **in-session** (via the Agent/Task tool) to
perform the deep security/performance/style audit and record an attestation the
pre-push hook can trust. It is invoked by the `/audit` command and auto-triggered
by the Stop hook when tracked code changed since the last attestation.

Do NOT spawn `claude -p` for this — it refuses to run nested in a live session.
Use the Agent tool (subagents) for the fan-out, exactly as below.

## 1. Determine scope (only what changed)

```
BASE=${AUDIT_BASE:-origin/master}
git diff --name-only "$BASE"...HEAD ; git diff --name-only   # committed + working
```
Filter to reviewable code (drop `docs/**` and `*.md`). Call this the CHANGED SET.

- **Empty CHANGED SET** → nothing to review. Record PASS (`audit_write_state PASS 0 0 "no code changes vs $BASE"`) and stop.
- **Large CHANGED SET** (> ~40 files, e.g. a big integration branch) → a single
  in-session pass can't do it justice. Record a skip (`audit_write_state SKIPPED 0 0 "diff too large (<n> files) — audited manually"`) and tell the user to scope it or audit by area. (The pre-push hook treats a non-PASS/FAIL attestation as stale → fail-open.)

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

## 3. Verify surviving Critical/High (Agent tool)

For each Critical or High a review subagent reports, launch a **separate** verify
subagent that adversarially tries to REFUTE it against the real file (this is how
we catch both false positives and superficial fixes). Only findings that survive
refutation count toward the gate. (This step is why the audit is multi-agent, not
a single pass — the independent cross-check matters.)

## 4. Consolidate + record the attestation

Count the surviving **Critical** and **High** findings. Then:

```
. scripts/audit/lib.sh
audit_write_state PASS 0 0 "clean"                 # if 0 critical AND 0 high
# or
audit_write_state FAIL <critical> <high> "<n> unresolved"
```
Write the full report (executive summary, findings table, detailed findings with
What/Why/Fix, strengths) to the path from `audit_report_file`.

`audit_write_state` stamps the attestation with the CURRENT tree hash, so the
pre-push hook allows the push iff the tree is unchanged since this PASS.

## 5. Surface to the user

Print a short summary: verdict, counts, the 2–3 findings that matter, and the
report path. Do not modify any reviewed code (NO FIXES) unless the user then asks.
