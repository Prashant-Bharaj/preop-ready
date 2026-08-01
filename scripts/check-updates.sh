#!/bin/bash
# ==============================================================================
# Check for Template Updates
#
# Usage: ./scripts/check-updates.sh
#
# Output (stdout — this contract is consumed by AI assistants; do not change):
#   - "UP_TO_DATE" - No updates available
#   - "UPDATE_AVAILABLE|<local_version>|<latest_version>" - Update available
#   - "CHECK_FAILED" - Could not check (network error, not in Codespaces, etc.)
#
# On CHECK_FAILED a machine-readable cause goes to STDERR as "reason=<token>"
# (no_git, fetch_auth, fetch_network, fetch_other, no_manifest, bad_version).
# Kept off stdout so the contract above is unchanged;
# .devcontainer/auto-update-template.sh turns it into a specific message with a
# specific fix, instead of one catch-all "could not check" line that hides a
# repo which has silently stopped receiving security updates.
#
# This script is designed to be called by AI assistants at session start.
# ==============================================================================

set -e

TEMPLATE_REPO="bayer-int/dd-template-repository"
LOCAL_VERSION_FILE=".template-version"
MANIFEST_FILE=".template-manifest.yml"

# fail_check <reason-token> — stdout contract unchanged, cause on stderr.
fail_check() {
    echo "$1" >&2
    echo "CHECK_FAILED"
    exit 0
}

# Function to extract version from content
extract_version() {
    echo "$1" | grep "^version:" | head -1 | sed 's/version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/' | tr -d '[:space:]'
}

# ver_gt A B  ->  true when A > B (semver compare via sort -V).
# MUST match apply-updates.sh. With the plain string equality used before, a
# child whose version is AHEAD of the template (mid-release, or a hand-edited
# .template-version) reported UPDATE_AVAILABLE forever and ran the whole
# engine for a guaranteed no-op on every Codespace start.
ver_gt() {
    [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail_check "reason=no_git"

# Get local version
if [ -f "$LOCAL_VERSION_FILE" ]; then
    LOCAL_VERSION=$(extract_version "$(cat "$LOCAL_VERSION_FILE")")
fi
# Absent or unparseable: treat as 0.0.0 so the engine re-materializes
# everything (the same fallback apply-updates.sh uses).
[ -n "${LOCAL_VERSION:-}" ] || LOCAL_VERSION="0.0.0"

# Read the template manifest via git. The Codespace gh-api token is often
# restricted (403), but git fetch of the template works. Ensure a 'template'
# remote, fetch it, then read the manifest from the fetched ref.
TEMPLATE_URL="https://github.com/${TEMPLATE_REPO}.git"
TEMPLATE_BRANCH="master"
if git remote get-url template >/dev/null 2>&1; then
    git remote set-url template "$TEMPLATE_URL" || true
else
    git remote add template "$TEMPLATE_URL" 2>/dev/null || true
fi

# Keep the fetch error so the cause can be classified: "could not check" reads
# identically whether the token lacks access to the template or the network is
# down, and those need completely different fixes.
FETCH_ERR=$(git fetch -q template "+refs/heads/${TEMPLATE_BRANCH}:refs/remotes/template/${TEMPLATE_BRANCH}" 2>&1) || {
    case "$FETCH_ERR" in
        *"Authentication failed"*|*"could not read Username"*|*"Permission denied"*|*"403"*|*"not found"*|*"access rights"*)
            fail_check "reason=fetch_auth" ;;
        *"Could not resolve host"*|*"unable to access"*|*"Connection timed out"*|*"Network is unreachable"*|*"Operation timed out"*|*"Connection refused"*)
            fail_check "reason=fetch_network" ;;
        *)
            fail_check "reason=fetch_other" ;;
    esac
}

LATEST_CONTENT=$(git show "template/${TEMPLATE_BRANCH}:${MANIFEST_FILE}" 2>/dev/null) \
    || fail_check "reason=no_manifest"

if [ -z "$LATEST_CONTENT" ]; then
    fail_check "reason=no_manifest"
fi

LATEST_VERSION=$(extract_version "$LATEST_CONTENT")

if [ -z "$LATEST_VERSION" ]; then
    fail_check "reason=bad_version"
fi

# Compare versions — semver, not string equality (see ver_gt above)
if ver_gt "$LATEST_VERSION" "$LOCAL_VERSION"; then
    echo "UPDATE_AVAILABLE|$LOCAL_VERSION|$LATEST_VERSION"
else
    echo "UP_TO_DATE"
fi
