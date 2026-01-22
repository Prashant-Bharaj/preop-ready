#!/bin/bash
# ==============================================================================
# Apply Template Updates
# 
# Usage: ./scripts/apply-updates.sh
#
# Output:
#   - Lists each file being updated
#   - Ends with "UPDATE_COMPLETE|<version>" on success
#   - Ends with "UPDATE_FAILED|<reason>" on failure
#
# This script reads the manifest from the template repo and updates all files
# listed in the auto_update section. User code (frontend/*, backend/*, 
# database/init/*) is NEVER touched.
# ==============================================================================

set -e

TEMPLATE_REPO="bayer-int/dd-template-repository"
MANIFEST_FILE=".template-manifest.yml"
TMP_MANIFEST="/tmp/template-manifest.yml"

echo "Fetching update manifest..."

# Fetch manifest
gh api "repos/$TEMPLATE_REPO/contents/$MANIFEST_FILE" --jq '.content' 2>/dev/null | base64 -d > "$TMP_MANIFEST" 2>/dev/null || {
    echo "UPDATE_FAILED|Could not fetch manifest"
    exit 1
}

# Extract version
LATEST_VERSION=$(grep "^version:" "$TMP_MANIFEST" | head -1 | sed 's/version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/' | tr -d '[:space:]')

if [ -z "$LATEST_VERSION" ]; then
    echo "UPDATE_FAILED|Could not determine version"
    exit 1
fi

echo "Updating to version $LATEST_VERSION..."
echo ""

# Parse auto_update section and fetch each file
# The manifest format is:
# auto_update:
#   - path: ".github/workflows/deploy.yml"
#   - path: ".clinerules"
#     is_directory: true
#   - path: "frontend/Dockerfile.vanilla"

IN_AUTO_UPDATE=false
UPDATED_FILES=()

while IFS= read -r line; do
    # Check if we're entering auto_update section
    if echo "$line" | grep -q "^auto_update:"; then
        IN_AUTO_UPDATE=true
        continue
    fi
    
    # Check if we're leaving auto_update section (another top-level key)
    if $IN_AUTO_UPDATE && echo "$line" | grep -q "^[a-z_]*:" && ! echo "$line" | grep -q "^[[:space:]]"; then
        IN_AUTO_UPDATE=false
        continue
    fi
    
    # Skip if not in auto_update section
    if ! $IN_AUTO_UPDATE; then
        continue
    fi
    
    # Extract path from "  - path: ..." line
    if echo "$line" | grep -q "path:"; then
        FILE_PATH=$(echo "$line" | sed 's/.*path:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}/\1/' | tr -d '[:space:]')
        
        # Skip empty paths
        if [ -z "$FILE_PATH" ]; then
            continue
        fi
        
        # Check next line for is_directory flag
        IS_DIR=false
    fi
    
    # Check for is_directory flag
    if echo "$line" | grep -q "is_directory:[[:space:]]*true"; then
        IS_DIR=true
    fi
    
    # If we have a path, fetch it
    if [ -n "$FILE_PATH" ] && ! echo "$line" | grep -q "is_directory:"; then
        if $IS_DIR; then
            # Fetch directory contents
            echo "Updating directory: $FILE_PATH/"
            
            # Get list of files in directory
            DIR_FILES=$(gh api "repos/$TEMPLATE_REPO/contents/$FILE_PATH" --jq '.[].name' 2>/dev/null) || {
                echo "  Warning: Could not list $FILE_PATH"
                FILE_PATH=""
                continue
            }
            
            # Create directory if needed
            mkdir -p "$FILE_PATH"
            
            # Fetch each file in directory
            for FILENAME in $DIR_FILES; do
                FULL_PATH="$FILE_PATH/$FILENAME"
                echo "  - $FULL_PATH"
                
                gh api "repos/$TEMPLATE_REPO/contents/$FULL_PATH" --jq '.content' 2>/dev/null | base64 -d > "$FULL_PATH" 2>/dev/null || {
                    echo "    Warning: Could not fetch $FULL_PATH"
                }
                UPDATED_FILES+=("$FULL_PATH")
            done
        else
            # Fetch single file
            echo "Updating: $FILE_PATH"
            
            # Create parent directory if needed
            mkdir -p "$(dirname "$FILE_PATH")"
            
            gh api "repos/$TEMPLATE_REPO/contents/$FILE_PATH" --jq '.content' 2>/dev/null | base64 -d > "$FILE_PATH" 2>/dev/null || {
                echo "  Warning: Could not fetch $FILE_PATH"
            }
            UPDATED_FILES+=("$FILE_PATH")
        fi
        
        FILE_PATH=""
        IS_DIR=false
    fi
done < "$TMP_MANIFEST"

# Update local version tracker
cat > .template-version << EOF
# Template Version Tracker - DO NOT EDIT MANUALLY
# This file tracks which version of the platform template is installed.
version: "$LATEST_VERSION"
template_repo: "$TEMPLATE_REPO"
last_updated: "$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)"
EOF

echo ""
echo "UPDATE_COMPLETE|$LATEST_VERSION"
echo ""
echo "Updated ${#UPDATED_FILES[@]} files to version $LATEST_VERSION"
echo "Your code (frontend/*, backend/*, database/init/*) was NOT touched."
