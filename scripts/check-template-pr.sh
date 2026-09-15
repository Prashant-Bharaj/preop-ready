#!/bin/bash
# ==============================================================================
# Platform template status — one call that tells an AI assistant (Claude Code,
# Cline, Copilot, Cursor, the harness) whether this repo has platform updates
# waiting and what to do about them. Runs at every session start.
#
# Usage: bash scripts/check-template-pr.sh
#
# Always exits 0 and prints ONE line per fact (stdout contract, consumed by
# rules in .platform-rules/00-global.md — keep the tokens stable):
#
#   TEMPLATE_PR|<number>|<url>|held_workflows=<yes|no>
#       An open PR from the platform's weekly sync (branch template-sync/v*).
#       held_workflows=yes → the PR body says workflow files could not be
#       pushed by the platform and need a local engine run after merging.
#   TEMPLATE_PR|none            No such PR is open.
#   TEMPLATE_PR|unknown|<why>   Could not ask GitHub (gh_missing, gh_auth, no_origin).
#   TEMPLATE_CALLER|current     .github/workflows/template-sync.yml hands off to the
#                               platform reusable workflow (weekly sync works).
#   TEMPLATE_CALLER|outdated    Pre-platform copy — its weekly run cannot read the
#                               template. Fixed by one engine run + commit.
#   TEMPLATE_CALLER|missing     No sync workflow at all.
#   TEMPLATE_VERSION|UP_TO_DATE
#   TEMPLATE_VERSION|UPDATE_AVAILABLE|<local>|<latest>
#   TEMPLATE_VERSION|CHECK_FAILED|<reason>     reason as check-updates.sh reports it
#                               (fetch_auth = cannot read the template from here).
#   TEMPLATE_MAJOR_HELD|<major>|<synced-version>
#                               A MAJOR template release is available but held
#                               (only additive files were synced, up to
#                               <synced-version>). Opt in with
#                               `TEMPLATE_ACCEPT_MAJOR=1 bash scripts/apply-updates.sh`.
#   TEMPLATE_WORKFLOWS_PENDING|<files>
#                               Workflow files a CI sync could not push (GitHub
#                               restriction) — apply with `bash scripts/apply-updates.sh`
#                               here, then commit those files + .template-version.
#   TEMPLATE_MIGRATION_NEEDED|<retired layers>
#                               The project is on a retired stack; the major
#                               cannot be accepted until migrated
#                               (.platform-rules/scope-migration.md).
#   TEMPLATE_TS_MIGRATION|<js layers>
#                               Optional: JavaScript layers that could move to the
#                               TypeScript layout (.platform-rules/scope-typescript.md).
#                               Omitted while a major is held or after
#                               `.template-ts-migration-declined` exists.
#   TEMPLATE_AUTO_UPDATE|on|off  Updates are applied without asking unless the
#                               team opted out with `.template-auto-update-disabled`
#                               (the same switch the Codespace start hook honours).
#
# The PR check only needs read access to THIS repo, so it works in Codespaces
# without a gh login; the version check needs template access and may report
# CHECK_FAILED|fetch_auth there — that is expected, not an error.
# ==============================================================================

set -u

PLATFORM_CALLER_REF="dd-platform-repository/.github/workflows/template-sync.yml"
SYNC_BRANCH_PREFIX="template-sync/"
HELD_MARKER="One manual step: workflow files"

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0

# The template repo itself has nothing to sync from.
case "$(git remote get-url origin 2>/dev/null || true)" in
    *bayer-int/dd-template-repository*|*bayer-int/dd-template-repository.git)
        echo "[template-check] This is the template repository itself — nothing to sync."
        exit 0 ;;
esac

echo "[template-check] Platform template status for this repo — act on it as .platform-rules/00-global.md \"Session start\" says, before greeting the user."

# ── 1. Open sync PR ───────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
    echo "TEMPLATE_PR|unknown|gh_missing"
else
    ORIGIN=$(git remote get-url origin 2>/dev/null || true)
    REPO=$(echo "$ORIGIN" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
    if [ -z "$REPO" ] || [ "$REPO" = "$ORIGIN" ]; then
        echo "TEMPLATE_PR|unknown|no_origin"
    else
        # Newest open sync PR (gh lists newest first); gh's built-in jq keeps
        # this free of a jq dependency. A failed call (no auth, no network)
        # exits non-zero → "unknown"; a successful call with no match → "none".
        if PR_LINE=$(gh pr list -R "$REPO" --state open --json number,url,headRefName,body \
              --jq "[.[] | select(.headRefName | startswith(\"${SYNC_BRANCH_PREFIX}\"))] | first // empty | \"\(.number)|\(.url)|\(if ((.body // \"\") | contains(\"${HELD_MARKER}\")) then \"yes\" else \"no\" end)\"" 2>/dev/null); then
            if [ -n "$PR_LINE" ]; then
                echo "TEMPLATE_PR|${PR_LINE%|*}|held_workflows=${PR_LINE##*|}"
            else
                echo "TEMPLATE_PR|none"
            fi
        else
            echo "TEMPLATE_PR|unknown|gh_auth"
        fi
    fi
fi

# ── 2. Is the repo's sync workflow the platform caller? ──────────────────────
WF=".github/workflows/template-sync.yml"
if [ ! -f "$WF" ]; then
    echo "TEMPLATE_CALLER|missing"
elif grep -q "$PLATFORM_CALLER_REF" "$WF"; then
    echo "TEMPLATE_CALLER|current"
else
    echo "TEMPLATE_CALLER|outdated"
fi

# ── 3. Version vs template (may need template access) ────────────────────────
if [ -f scripts/check-updates.sh ]; then
    ERR_FILE=$(mktemp)
    RESULT=$(bash scripts/check-updates.sh 2>"$ERR_FILE") || RESULT="CHECK_FAILED"
    REASON=$(grep -o 'reason=[a-z_]*' "$ERR_FILE" 2>/dev/null | head -1 | cut -d= -f2)
    rm -f "$ERR_FILE"
    case "$RESULT" in
        UP_TO_DATE)          echo "TEMPLATE_VERSION|UP_TO_DATE" ;;
        UPDATE_AVAILABLE*)   echo "TEMPLATE_VERSION|$RESULT" ;;
        *)                   echo "TEMPLATE_VERSION|CHECK_FAILED|${REASON:-unknown}" ;;
    esac
else
    echo "TEMPLATE_VERSION|CHECK_FAILED|script_missing"
fi

# ── 3b. Held major / retired stack (written by the engine) ───────────────────
HELD_MAJOR=$(grep "^held_major:" .template-version 2>/dev/null | head -1 | cut -d'"' -f2)
if [ -n "$HELD_MAJOR" ]; then
    SYNCED=$(grep "^additive_synced:" .template-version 2>/dev/null | head -1 | cut -d'"' -f2)
    echo "TEMPLATE_MAJOR_HELD|${HELD_MAJOR}|${SYNCED:-?}"
fi
PENDING_WF=$(grep "^pending_workflows:" .template-version 2>/dev/null | head -1 | cut -d'"' -f2)
[ -n "$PENDING_WF" ] && echo "TEMPLATE_WORKFLOWS_PENDING|${PENDING_WF}"
if [ -f .template-migration-needed ]; then
    RETIRED=$(grep "^retired:" .template-migration-needed 2>/dev/null | head -1 | cut -d'"' -f2)
    echo "TEMPLATE_MIGRATION_NEEDED|${RETIRED:-unknown}"
fi

# ── 3c. Optional TypeScript migration (v2 projects on JavaScript layers) ─────
# Informational only; silenced by a tracked `.template-ts-migration-declined`.
if [ -z "$HELD_MAJOR" ] && [ ! -f .template-ts-migration-declined ] && [ -f scripts/detect-stack.sh ]; then
    JS_LAYERS=$(bash scripts/detect-stack.sh 2>/dev/null | grep -E '^(backend=node-js|frontend=react-js)$' | paste -sd, -)
    [ -n "$JS_LAYERS" ] && echo "TEMPLATE_TS_MIGRATION|${JS_LAYERS}"
fi

# ── 4. Hands-off updates (default on; same opt-out as the Codespace hook) ─────
if [ -f .template-auto-update-disabled ]; then
    echo "TEMPLATE_AUTO_UPDATE|off"
else
    echo "TEMPLATE_AUTO_UPDATE|on"
fi

exit 0