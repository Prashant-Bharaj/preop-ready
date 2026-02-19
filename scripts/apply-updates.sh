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

# Function to fetch a single file
fetch_file() {
    local FILE_PATH="$1"
    echo "Updating: $FILE_PATH"
    
    # Create parent directory if needed
    mkdir -p "$(dirname "$FILE_PATH")"
    
    gh api "repos/$TEMPLATE_REPO/contents/$FILE_PATH" --jq '.content' 2>/dev/null | base64 -d > "$FILE_PATH" 2>/dev/null || {
        echo "  Warning: Could not fetch $FILE_PATH"
        return 1
    }
    return 0
}

# Function to fetch a directory recursively
fetch_directory() {
    local DIR_PATH="$1"
    # Remove trailing slash if present
    DIR_PATH="${DIR_PATH%/}"
    
    echo "Updating directory: $DIR_PATH/"
    
    # Get list of items in directory
    local DIR_CONTENTS=$(gh api "repos/$TEMPLATE_REPO/contents/$DIR_PATH" 2>/dev/null) || {
        echo "  Warning: Could not list $DIR_PATH"
        return 1
    }
    
    # Create directory if needed
    mkdir -p "$DIR_PATH"
    
    # Process each item
    echo "$DIR_CONTENTS" | jq -r '.[] | "\(.type) \(.name)"' 2>/dev/null | while read -r TYPE NAME; do
        local FULL_PATH="$DIR_PATH/$NAME"
        
        if [ "$TYPE" = "file" ]; then
            echo "  - $FULL_PATH"
            gh api "repos/$TEMPLATE_REPO/contents/$FULL_PATH" --jq '.content' 2>/dev/null | base64 -d > "$FULL_PATH" 2>/dev/null || {
                echo "    Warning: Could not fetch $FULL_PATH"
            }
        elif [ "$TYPE" = "dir" ]; then
            # Recursively fetch subdirectory
            fetch_directory "$FULL_PATH"
        fi
    done
    return 0
}

# Parse the manifest using a simple state machine
UPDATED_COUNT=0

# Extract auto_update entries using grep/sed (more reliable than line-by-line parsing)
# Find lines with "- path:" in auto_update section
IN_AUTO_UPDATE=false
CURRENT_PATH=""
CURRENT_IS_DIR=false

while IFS= read -r line; do
    # Check for section markers
    if echo "$line" | grep -qE "^auto_update:"; then
        IN_AUTO_UPDATE=true
        continue
    fi
    
    # Check for end of auto_update (new top-level section)
    if $IN_AUTO_UPDATE && echo "$line" | grep -qE "^[a-z_]+:" && ! echo "$line" | grep -qE "^[[:space:]]"; then
        # Process last entry before leaving section
        if [ -n "$CURRENT_PATH" ]; then
            if $CURRENT_IS_DIR; then
                fetch_directory "$CURRENT_PATH" && ((UPDATED_COUNT++)) || true
            else
                fetch_file "$CURRENT_PATH" && ((UPDATED_COUNT++)) || true
            fi
        fi
        IN_AUTO_UPDATE=false
        CURRENT_PATH=""
        CURRENT_IS_DIR=false
        continue
    fi
    
    if ! $IN_AUTO_UPDATE; then
        continue
    fi
    
    # Check for new entry (starts with "- path:")
    if echo "$line" | grep -qE "^[[:space:]]*-[[:space:]]*path:"; then
        # Process previous entry first
        if [ -n "$CURRENT_PATH" ]; then
            if $CURRENT_IS_DIR; then
                fetch_directory "$CURRENT_PATH" && ((UPDATED_COUNT++)) || true
            else
                fetch_file "$CURRENT_PATH" && ((UPDATED_COUNT++)) || true
            fi
        fi
        
        # Extract new path
        CURRENT_PATH=$(echo "$line" | sed 's/.*path:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/' | tr -d '[:space:]')
        CURRENT_IS_DIR=false
        continue
    fi
    
    # Check for is_directory flag (belongs to current entry)
    if echo "$line" | grep -qE "is_directory:[[:space:]]*true"; then
        CURRENT_IS_DIR=true
        continue
    fi
    
done < "$TMP_MANIFEST"

# Process final entry
if [ -n "$CURRENT_PATH" ]; then
    if $CURRENT_IS_DIR; then
        fetch_directory "$CURRENT_PATH" && ((UPDATED_COUNT++)) || true
    else
        fetch_file "$CURRENT_PATH" && ((UPDATED_COUNT++)) || true
    fi
fi

# Process cleanup section - remove deprecated files/directories
echo ""
echo "Checking for deprecated files..."
IN_CLEANUP=false
CLEANUP_PATH=""
CLEANUP_TYPE=""

while IFS= read -r line; do
    if echo "$line" | grep -qE "^cleanup:"; then
        IN_CLEANUP=true
        continue
    fi

    # End of cleanup section (new top-level key)
    if $IN_CLEANUP && echo "$line" | grep -qE "^[a-z_]+:" && ! echo "$line" | grep -qE "^[[:space:]]"; then
        IN_CLEANUP=false
        continue
    fi

    if ! $IN_CLEANUP; then
        continue
    fi

    # Extract path
    if echo "$line" | grep -qE "^[[:space:]]*-[[:space:]]*path:"; then
        # Process previous entry
        if [ -n "$CLEANUP_PATH" ]; then
            if [ "$CLEANUP_TYPE" = "directory" ] && [ -d "$CLEANUP_PATH" ]; then
                rm -rf "$CLEANUP_PATH"
                echo "  Removed: $CLEANUP_PATH/"
            elif [ "$CLEANUP_TYPE" = "gitignore_entry" ] && [ -f .gitignore ]; then
                ENTRY="${CLEANUP_PATH#.}"
                if grep -q "^\.${ENTRY}/" .gitignore 2>/dev/null; then
                    sed -i "\|^\.${ENTRY}/|d" .gitignore
                    sed -i "\|^# .*${ENTRY}|d" .gitignore
                    echo "  Cleaned: $CLEANUP_PATH from .gitignore"
                fi
            fi
        fi
        CLEANUP_PATH=$(echo "$line" | sed 's/.*path:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/' | tr -d '[:space:]')
        CLEANUP_TYPE=""
        continue
    fi

    # Extract type
    if echo "$line" | grep -qE "type:"; then
        CLEANUP_TYPE=$(echo "$line" | sed 's/.*type:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/' | tr -d '[:space:]')
        continue
    fi
done < "$TMP_MANIFEST"

# Process final cleanup entry
if [ -n "$CLEANUP_PATH" ]; then
    if [ "$CLEANUP_TYPE" = "directory" ] && [ -d "$CLEANUP_PATH" ]; then
        rm -rf "$CLEANUP_PATH"
        echo "  Removed: $CLEANUP_PATH/"
    elif [ "$CLEANUP_TYPE" = "gitignore_entry" ] && [ -f .gitignore ]; then
        ENTRY="${CLEANUP_PATH#.}"
        if grep -q "^\.${ENTRY}/" .gitignore 2>/dev/null; then
            sed -i "\|^\.${ENTRY}/|d" .gitignore
            sed -i "\|^# .*${ENTRY}|d" .gitignore
            echo "  Cleaned: $CLEANUP_PATH from .gitignore"
        fi
    fi
fi

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
echo "Updated files to version $LATEST_VERSION"
echo "Your code (frontend/*, backend/*, database/init/*) was NOT touched."
