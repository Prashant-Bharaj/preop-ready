#!/bin/bash
# ==============================================================================
# Check for Template Updates
# 
# Usage: ./scripts/check-updates.sh
#
# Output:
#   - "UP_TO_DATE" - No updates available
#   - "UPDATE_AVAILABLE|<local_version>|<latest_version>" - Update available
#   - "CHECK_FAILED" - Could not check (network error, not in Codespaces, etc.)
#
# This script is designed to be called by AI assistants at session start.
# ==============================================================================

set -e

TEMPLATE_REPO="bayer-int/dd-template-repository"
LOCAL_VERSION_FILE=".template-version"
MANIFEST_FILE=".template-manifest.yml"

# Function to extract version from content
extract_version() {
    echo "$1" | grep "^version:" | head -1 | sed 's/version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/' | tr -d '[:space:]'
}

# Get local version
if [ -f "$LOCAL_VERSION_FILE" ]; then
    LOCAL_VERSION=$(extract_version "$(cat "$LOCAL_VERSION_FILE")")
else
    LOCAL_VERSION="0.0.0"
fi

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
git fetch -q template "+refs/heads/${TEMPLATE_BRANCH}:refs/remotes/template/${TEMPLATE_BRANCH}" 2>/dev/null || {
    echo "CHECK_FAILED"
    exit 0
}
LATEST_CONTENT=$(git show "template/${TEMPLATE_BRANCH}:${MANIFEST_FILE}" 2>/dev/null) || {
    echo "CHECK_FAILED"
    exit 0
}

if [ -z "$LATEST_CONTENT" ]; then
    echo "CHECK_FAILED"
    exit 0
fi

LATEST_VERSION=$(extract_version "$LATEST_CONTENT")

if [ -z "$LATEST_VERSION" ]; then
    echo "CHECK_FAILED"
    exit 0
fi

# Compare versions
if [ "$LOCAL_VERSION" = "$LATEST_VERSION" ]; then
    echo "UP_TO_DATE"
else
    echo "UPDATE_AVAILABLE|$LOCAL_VERSION|$LATEST_VERSION"
fi
