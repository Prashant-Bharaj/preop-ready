---
name: audit
description: Security audit loop: review the changed code, fix every Critical/High/Medium finding, re-audit until only Low remain, record the attestation; on demand via /audit, or automatically before every push when a project opts in
---

Read `.platform-rules/reference/audit.md` and follow it exactly. It is the canonical platform rule
for this topic; it links the code snippets to copy instead of writing from scratch.

Also honor the always-on core rules (imported via CLAUDE.md) — they override
anything that conflicts.
