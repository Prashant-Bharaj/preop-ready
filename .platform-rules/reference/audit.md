---
description: "Security audit loop: review the changed code, fix every Critical/High/Medium finding, re-audit until only Low remain, record the attestation; on demand via /audit, or automatically before every push when a project opts in"
triggers: ["audit", "security audit", "deep audit", "review my code", "review the changes for security", "attestation", "is my code safe", "push held", "push blocked"]
globs: []
---

# Deep Audit (before every push)

The audit reviews the project's own code changed against `origin/master` (plus uncommitted
work) — never the platform-owned files a template update commits, those are audited in the
template repository — for security, performance and style, verifies every Critical/High/Medium finding with a second
adversarial pass, **fixes what survives, and audits again until only Low findings remain**.
It then records an attestation for the exact tree it reviewed. Low findings are reported,
never fixed by the loop.

## When it runs

On demand: `/audit` in Claude Code, or `bash scripts/audit/run.sh` in a terminal.

Automatically before every push when the project opts in (`touch .audit-auto`, gitignored, or
`AUDIT_AUTO=1`) — off by default for now. With the gate on, a push whose code has no fresh
attestation is held:

- In Claude Code the hook prints the instruction and exits 1. Run this audit loop, commit the
  fixes, and repeat the same `git push`. Never bypass it with `--no-verify`.
- In a plain terminal `scripts/audit/run.sh` runs the loop headless before the push.
- Automation (scripts, CI, the platform update commits) is allowed through with a warning.

A PASS attestation for the current tree lets the push through instantly; a FAIL (the loop
could not get the tree clean) blocks it until the remaining findings are fixed. Docs-only
pushes never gate.

## Run it

Follow `scripts/audit/deep-audit.md` exactly: fan out review subagents per
`scripts/audit/reviewer-prompt.md`, verify, fix every Critical/High/Medium, re-audit, and
record with `source scripts/audit/lib.sh; audit_write_state <PASS|FAIL> <critical> <high>
<medium> "<note>"`. In Claude Code the `/audit` command does the same. Commit the fixes
before recording — the attestation is bound to the tree hash.

Stop when a round returns the same surviving findings as the round before: that is a stall,
record FAIL with what is left and tell the user which findings the fixes did not satisfy.

End with the rounds, what was fixed, the verdict, the Low notes and the report path
(`audit_report_file`).

## The harness does the same at build time

Apps built in the harness get the same loop before their containers build when the harness
runs with `SECURITY_REVIEW=1` (off by default for now): the security review fixes every
Critical/High/Medium and re-reviews until only Low remain; what could not be resolved is
listed in the app-ready message.
