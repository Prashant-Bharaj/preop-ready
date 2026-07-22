#!/usr/bin/env bash
# ==============================================================================
# Dependabot PR Handler (runs on Codespace start via auto-update-template.sh)
#
# Policy:
#   - AUTO-MERGE: Dependabot PRs that are grouped patch/minor updates or
#     clearly non-major single bumps, WITH a clean merge state (checks green).
#     dependabot.yml guarantees grouped PRs contain only minor/patch.
#   - SURFACE ONLY: major updates, failing/pending checks, conflicts — printed
#     for the user (the AI assistant walks them through these on request).
#
# Merging to the default branch triggers the deploy workflow — that is the
# normal update path, identical to the dependabot-auto-merge workflow's result.
#
# Output is machine-readable-ish on purpose; the AI session-start flow surfaces
# it to the user (see .platform-rules/reference/journey.md).
# ==============================================================================

set -u

command -v gh >/dev/null 2>&1 || exit 0
gh auth status >/dev/null 2>&1 || exit 0

PRS=$(gh pr list --author "app/dependabot" --state open \
  --json number,title,mergeStateStatus 2>/dev/null) || exit 0

COUNT=$(echo "$PRS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
[ "$COUNT" = "0" ] && exit 0

echo ""
echo "📦 Dependabot: $COUNT open PR(s)"

MERGED=0
NEEDS_REVIEW=""

while IFS=$'\t' read -r NUMBER TITLE STATE; do
    [ -z "$NUMBER" ] && continue

    # Major bumps never auto-merge. Grouped PRs ("... group with N updates")
    # are minor/patch only by dependabot.yml `update-types`, so title-based
    # major detection only needs to cover single-package bumps:
    # "bump foo from 1.2.3 to 2.0.0" -> major if leading version digit changed.
    IS_MAJOR=false
    if echo "$TITLE" | grep -qiE "bump .* from [0-9]+[^ ]* to [0-9]+"; then
        FROM_MAJOR=$(echo "$TITLE" | sed -E 's/.* from ([0-9]+).*/\1/')
        TO_MAJOR=$(echo "$TITLE" | sed -E 's/.* to ([0-9]+).*/\1/')
        [ "$FROM_MAJOR" != "$TO_MAJOR" ] && IS_MAJOR=true
    fi

    if [ "$IS_MAJOR" = "true" ]; then
        NEEDS_REVIEW="${NEEDS_REVIEW}  - #${NUMBER} (MAJOR — review required): ${TITLE}\n"
        continue
    fi

    if [ "$STATE" = "CLEAN" ]; then
        if gh pr merge "$NUMBER" --squash >/dev/null 2>&1; then
            echo "  ✓ Merged #${NUMBER}: ${TITLE}"
            MERGED=$((MERGED + 1))
        else
            NEEDS_REVIEW="${NEEDS_REVIEW}  - #${NUMBER} (merge failed): ${TITLE}\n"
        fi
    else
        NEEDS_REVIEW="${NEEDS_REVIEW}  - #${NUMBER} (checks: ${STATE}): ${TITLE}\n"
    fi
done < <(echo "$PRS" | python3 -c "
import json, sys
for pr in json.load(sys.stdin):
    print(f\"{pr['number']}\t{pr['title']}\t{pr.get('mergeStateStatus','')}\")" 2>/dev/null)

if [ "$MERGED" -gt 0 ]; then
    echo "  Merged $MERGED update(s) — run 'git pull' to get them locally."
    echo "  (Each merge triggers a normal deploy of the default branch.)"
fi

if [ -n "$NEEDS_REVIEW" ]; then
    echo "  Needs attention:"
    printf "%b" "$NEEDS_REVIEW"
    echo "  Ask your AI assistant: 'Help me review the open Dependabot PRs.'"
fi
