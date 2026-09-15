---
description: "Run the deep security, performance and style audit of changed code on demand and record its attestation; the automatic every-turn gate is off unless enabled"
triggers: ["audit", "security audit", "deep audit", "review my code", "review the changes for security", "attestation", "is my code safe"]
globs: []
---

# Deep Audit (on demand)

The audit reviews the code changed against `origin/master` (plus uncommitted work) for
security, performance and style, verifies every Critical/High finding with a second
adversarial pass, and records an attestation for the exact tree it reviewed.

## Run it

Follow `scripts/audit/deep-audit.md` exactly (fan out review subagents per
`scripts/audit/reviewer-prompt.md`, verify, then record with
`source scripts/audit/lib.sh; audit_write_state <PASS|FAIL> <critical> <high> "<note>"`).
In Claude Code the `/audit` command does the same. Outside a session:
`bash scripts/audit/run.sh`.

Do NOT fix anything unless the user asks. End with the verdict, the counts, the findings
that matter most and the report path (`audit_report_file`).

## Automatic gate (off by default)

The Stop hook that demands an audit after every turn with code changes, and the pre-push
attestation check, are inert unless the developer enables them:

```bash
touch .audit-auto          # per developer, gitignored
# or start the tool with AUDIT_AUTO=1
```

With the gate off, nothing runs on its own: the audit happens only when asked for.
