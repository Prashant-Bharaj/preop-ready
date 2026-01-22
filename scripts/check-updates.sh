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

# Try to get latest version from template repo
# Uses gh api which is pre-authenticated in Codespaces
LATEST_CONTENT=$(gh api "repos/$TEMPLATE_REPO/contents/$MANIFEST_FILE" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null) || {
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
